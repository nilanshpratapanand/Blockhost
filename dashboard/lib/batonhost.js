'use strict';
// Baton Host: whichever friend's PC starts first becomes the host. It pulls the world, runs the server with RAM sized to the PC,
// keeps the cloud copy fresh while people play, and after the server has sat empty it saves, uploads and hands the baton back.
const EventEmitter = require('events');
const os = require('os');
const crypto = require('crypto');
const { Coord, Sync, decodeCode, encodeCode } = require('./baton');
const { recommendHeap } = require('./perf');

const sleep = ms => new Promise(r => setTimeout(r, ms));

class BatonHost extends EventEmitter {
  /** o: {mc, dir, getConfig, saveConfig, log, fetchImpl, totalMem(), timing:{heartbeatMs,syncMs,idleMs,tickMs,crashMs,standbyMs}} */
  constructor(o) {
    super();
    this.o = o; this.mc = o.mc;
    this.timing = { heartbeatMs: 45000, syncMs: 5 * 60000, tickMs: 15000, crashMs: 25000, standbyMs: 20000, ...(o.timing || {}) };
    this.phase = 'off'; this.message = ''; this.progress = null; this.epoch = 0; this.error = null;
    this.remote = null; this.lastSync = null; this.emptySince = null; this.handing = false;
    this.timers = []; this.coord = null; this.sync = null; this.cfgKey = '';
    this.mc.on('state', st => this.onMcState(st));
  }
  cfg() { return this.o.getConfig(); }
  log(t) { try { (this.o.log || (() => {}))(t); } catch { /* ignore */ } }
  emitState() { this.emit('state', this.snapshot()); }
  set(phase, message, extra = {}) { this.phase = phase; this.message = message || ''; Object.assign(this, extra); this.emitState(); }

  // ---------------------------------------------------------------- setup
  configured() { return !!this.cfg().batonCode; }
  ident() {
    const c = this.cfg();
    if (!c.batonId) this.o.saveConfig({ batonId: crypto.randomBytes(8).toString('hex') });
    return { id: this.cfg().batonId, name: (c.batonName || os.userInfo().username || 'Host').slice(0, 40) };
  }
  ensure() {
    const code = this.cfg().batonCode;
    if (!code) throw new Error('This PC has not joined a Cloud Host group yet.');
    if (code !== this.cfgKey || !this.coord) {
      const { url, secret } = decodeCode(code);
      this.coord = new Coord({ url, secret, fetchImpl: this.o.fetchImpl });
      this.sync = new Sync({ dir: this.o.dir, coord: this.coord, log: t => this.log(t), worldName: this.o.worldName, stateFile: this.o.stateFile });
      this.cfgKey = code;
    }
    return this.coord;
  }
  join(code) {
    decodeCode(code);                                    // validates
    this.o.saveConfig({ batonCode: code.trim() }); this.cfgKey = ''; this.ensure();
    this.emitState();
  }
  leave() {
    if (this.phase !== 'off' && this.phase !== 'error') throw new Error('Stop hosting first.');
    this.o.saveConfig({ batonCode: '' }); this.cfgKey = ''; this.coord = null; this.sync = null; this.remote = null; this.setStandby(false);
    this.set('off', ''); 
  }
  /** Owner: upload this PC's world as the first cloud copy. */
  async seed(url, secret) {
    if (this.mc.isRunning()) throw new Error('Stop the server first - the world must not change while it uploads.');
    const code = encodeCode(url, secret);
    const prior = this.cfg().batonCode || '';
    this.join(code);
    const me = this.ident();
    this.set('uploading', 'Uploading your world for the first time...');
    try {
      const st = await this.coord.status();
      if (st.state === 'hosted' && st.host.id !== me.id) throw new Error(st.host.name + ' is hosting right now.');
      const a = await this.coord.acquire(me.id, me.name, 0);
      if (!a.ok) throw new Error('Could not take the baton.');
      this.epoch = a.epoch;
      try {
        const r = await this.sync.push(a.epoch, me.name, p => this.set('uploading', `Uploading ${p.done}/${p.total} files...`, { progress: p }));
        this.lastSync = { at: Date.now(), version: r.version, files: r.uploaded, bytes: r.bytes };
        return { code, ...r };
      } finally { await this.coord.release(a.epoch).catch(() => {}); this.epoch = 0; }
    } catch (e) {
      this.o.saveConfig({ batonCode: prior }); this.cfgKey = ''; this.coord = null;      // a failed first upload must not leave a half-joined group
      throw e;
    } finally { this.set('off', ''); this.progress = null; }
  }

  /** "Test connection": proves the secret, the lease and a real 4 MB upload/download against the user's own deployment */
  async selfTest() {
    const coord = this.ensure(); const me = this.ident(); const steps = [];
    const step = async (name, fn) => { const t = Date.now(); try { const note = await fn(); steps.push({ name, ok: true, note: note || '', ms: Date.now() - t }); return true; } catch (e) { steps.push({ name, ok: false, note: e.message, ms: Date.now() - t }); return false; } };
    let st;
    if (!await step('Reach the coordinator and prove the group secret', async () => { st = await coord.status(); return st.state === 'hosted' ? st.host.name + ' is hosting' : 'nobody is hosting'; })) return steps;
    if ((st.state === 'hosted' && st.host.id !== me.id) || this.phase !== 'off') { steps.push({ name: 'Upload and download test', ok: true, note: 'skipped while a server is running' }); return steps; }
    let epoch = 0, blob = crypto.randomBytes(4 * 1024 * 1024), sha = crypto.createHash('sha256').update(blob).digest('hex');
    try {
      if (!await step('Take and release the baton', async () => { const a = await coord.acquire(me.id, me.name, 0); if (!a.ok) throw new Error('busy'); epoch = a.epoch; })) return steps;
      if (!await step('Upload a 4 MB test piece', async () => { await coord.putBlob(epoch, sha, blob); })) return steps;
      await step('Download it back and compare', async () => { const g = await coord.getBlob(sha); if (!g.equals(blob)) throw new Error('data did not match'); });
    } finally { if (epoch) await coord.release(epoch).catch(() => {}); }
    return steps;
  }

  // ---------------------------------------------------------------- eligibility
  ramPlan() {
    const total = (this.o.totalMem ? this.o.totalMem() : os.totalmem());
    const totalGB = Math.round(total / 1073741824 * 10) / 10;
    const cap = Math.max(2, Number(this.cfg().batonMaxRamGB) || 4);
    const rec = recommendHeap(total);
    const minGB = Number(this.cfg().batonMinHostGB) || 6;
    return { totalGB, ramGB: Math.max(2, Math.min(rec, cap)), cap, minGB, ok: totalGB >= minGB };
  }
  blocksStart() {
    // while a group is joined, the local world may be out of date: starting the server by hand could fork the world
    if (!this.configured()) return null;
    if (this.phase === 'hosting' || this.phase === 'starting' || this.phase === 'downloading') return null;
    return 'This server is shared through Cloud Host. Use Cloud Host > Start server so your world is up to date and nobody else is hosting.';
  }

  // ---------------------------------------------------------------- hosting
  async startHosting() {
    const coord = this.ensure();
    if (!['off', 'error', 'lost'].includes(this.phase)) throw new Error('Already ' + this.phase + '.');
    if (this.mc.isRunning()) throw new Error('The server is already running on this PC outside Cloud Host. Stop it first.');
    const plan = this.ramPlan();
    if (!plan.ok) throw new Error(`This PC has ${plan.totalGB} GB of RAM. Hosting needs at least ${plan.minGB} GB so the game and the server both run well.`);
    const me = this.ident();
    this.error = null; this.handing = false;
    this.set('checking', 'Checking who is hosting...');
    let st;
    try { st = await coord.status(); } catch (e) { this.set('error', e.message, { error: e.message }); throw e; }
    this.remote = st;
    if (st.state === 'hosted' && st.host.id !== me.id) {
      this.set('off', '');
      throw Object.assign(new Error(`${st.host.name} is already hosting.`), { code: 'BUSY', host: st.host });
    }
    this.set('acquiring', 'Taking the baton...');
    const a = await coord.acquire(me.id, me.name, plan.ramGB).catch(e => { this.set('error', e.message, { error: e.message }); throw e; });
    if (!a.ok) { this.set('off', ''); throw Object.assign(new Error(`${a.host ? a.host.name : 'Someone'} is already hosting.`), { code: 'BUSY', host: a.host }); }
    this.epoch = a.epoch;
    try {
      this.set('downloading', 'Downloading the latest world...');
      const r = await this.sync.pull(p => this.set('downloading', `Downloading ${p.done}/${p.total} files...`, { progress: p }));
      this.progress = null;
      if (r.empty) throw new Error('The cloud has no world yet. The owner must press "Upload world" first.');
      this.lastSync = { at: Date.now(), version: r.version, files: r.downloaded, bytes: r.bytes || 0 };
      this.applyRam(plan);
      this.set('starting', 'Starting the server...');
      this.startHeartbeat();
      await this.mc.start();
      await this.waitOnline(5 * 60000);
      this.emptySince = Date.now();
      this.set('hosting', 'Hosting - friends can join now.');
      this.startLoops();
      return { epoch: this.epoch, address: this.cfg().serverAddress || '' };
    } catch (e) {
      this.log('Could not start hosting: ' + e.message);
      await this.abortStart(e);
      throw e;
    }
  }
  applyRam(plan) {
    const c = this.cfg();
    if (!c.batonRamBackup) this.o.saveConfig({ batonRamBackup: { minRam: c.minRam, maxRam: c.maxRam } });
    this.o.saveConfig({ minRam: plan.ramGB + 'G', maxRam: plan.ramGB + 'G' });
  }
  restoreRam() {
    const b = this.cfg().batonRamBackup;
    if (b) this.o.saveConfig({ minRam: b.minRam, maxRam: b.maxRam, batonRamBackup: null });
  }
  waitOnline(ms) {
    return new Promise((resolve, reject) => {
      if (this.mc.state === 'online') return resolve();
      const t = setTimeout(() => { this.mc.off('state', f); reject(new Error('The server did not finish starting in 5 minutes.')); }, ms);
      const f = st => {
        if (st.state === 'online') { clearTimeout(t); this.mc.off('state', f); resolve(); }
        else if (st.state === 'crashed' || (st.state === 'offline' && this.mc.lastFailure)) { clearTimeout(t); this.mc.off('state', f); reject(new Error((this.mc.lastFailure && this.mc.lastFailure.hint) || 'The server stopped while starting.')); }
      };
      this.mc.on('state', f);
    });
  }
  async abortStart(err) {
    this.clearTimers();
    try { if (this.mc.isRunning()) await this.mc.stop(30000); } catch { /* ignore */ }
    this.restoreRam();
    try { await this.coord.release(this.epoch); } catch { /* lease expires on its own */ }
    this.epoch = 0;
    this.set('error', err.message, { error: err.message });
  }

  startHeartbeat() {
    const beat = async () => {
      if (!this.epoch) return;
      const players = this.mc.players ? this.mc.players.size : 0;
      try {
        const r = await this.coord.heartbeat(this.epoch, { address: this.cfg().serverAddress || '', players, phase: this.phase });
        this.beatFails = 0;
        if (!r.ok && r.reason === 'lost') return this.onLost();
      } catch (e) { this.beatFails = (this.beatFails || 0) + 1; if (e.lost) return this.onLost(); this.log('Heartbeat failed: ' + e.message); }
    };
    this.timers.push(setInterval(beat, this.timing.heartbeatMs));
    beat();
  }
  startLoops() {
    this.timers.push(setInterval(() => this.syncTick().catch(e => this.log('Sync failed: ' + e.message)), this.timing.syncMs));
    this.timers.push(setInterval(() => this.idleTick().catch(() => {}), this.timing.tickMs));
  }
  clearTimers() { for (const t of this.timers) clearInterval(t); this.timers = []; }

  async onLost() {
    if (this.handing || !this.epoch) return;
    this.handing = true; this.clearTimers();
    this.log('Another PC took over hosting - stopping this server without uploading.');
    try { this.mc.kill(); } catch { /* ignore */ }
    this.restoreRam(); this.epoch = 0;
    this.set('lost', 'Another host took over. Your changes since the last upload were not kept.');
    this.handing = false;
  }

  // ---------------------------------------------------------------- keeping the cloud copy fresh
  async syncTick() {
    if (this.phase !== 'hosting' || this.handing || this.syncing || this.mc.state !== 'online') return;
    this.syncing = true;
    try { await this.snapshotPush(); } finally { this.syncing = false; }
  }
  /** upload what changed without stopping the server: flush, freeze writes, copy changed files, resume, then upload */
  async snapshotPush() {
    const remote = await this.coord.getManifest();
    let prep, froze = false;
    try {
      this.mc.sendQuiet('save-all flush', /Saved the (game|world)/i);
      if (!(await this.mc.waitFor(/Saved the (game|world)/i, 60000))) throw new Error('The server did not confirm saving - skipping this upload.');
      this.mc.sendQuiet('save-off', /Automatic saving is now disabled/i); froze = true;
      if (!(await this.mc.waitFor(/Automatic saving is now disabled/i, 15000))) throw new Error('The server did not confirm pausing saves - skipping this upload.');
      prep = await this.sync.prepare(remote);
    } finally {
      if (froze) { try { this.mc.sendQuiet('save-on', /Automatic saving is now enabled/i); } catch { /* server gone */ } }
    }
    const r = await this.sync.commit(this.epoch, prep, this.ident().name);
    if (r.changed) this.lastSync = { at: Date.now(), version: r.version, files: r.uploaded, bytes: r.bytes };
    this.emitState();
    return r;
  }

  // ---------------------------------------------------------------- idle stop and hand-off
  idleLimitMs() { return (this.o.idleMsOverride != null ? this.o.idleMsOverride : (Number(this.cfg().batonIdleMin) || 30) * 60000); }
  async idleTick() {
    if (this.phase !== 'hosting' || this.handing) return;
    const n = this.mc.players ? this.mc.players.size : 0;
    if (n > 0) { this.emptySince = null; return; }
    if (!this.emptySince) this.emptySince = Date.now();
    if (Date.now() - this.emptySince >= this.idleLimitMs()) await this.handoff('nobody was playing for ' + (this.idleLimitMs() >= 60000 ? Math.round(this.idleLimitMs() / 60000) + ' minutes' : 'a while'));
  }
  onMcState(st) {
    if (this.phase !== 'hosting' || this.handing) return;
    if (st.state === 'offline' || st.state === 'crashed') {
      clearTimeout(this.crashT);
      this.crashT = setTimeout(() => { if (this.phase === 'hosting' && !this.handing && !this.mc.isRunning() && !['starting', 'online'].includes(this.mc.state)) this.handoff('the server stopped'); }, this.timing.crashMs);
    }
  }
  async handoff(reason) {
    if (this.handing || !this.epoch || !['hosting', 'error'].includes(this.phase)) return;
    this.handing = true; this.clearTimers(); clearTimeout(this.crashT);
    this.log('Handing the server back: ' + reason);
    try {
      this.set('saving', 'Saving the world...');
      if (this.mc.isRunning()) await this.mc.stop(120000);
      this.startHeartbeat();                      // stay "alive" in the cloud while the upload runs
      let lastErr;
      for (let i = 0; i < 3; i++) {
        try {
          const r = await this.sync.push(this.epoch, this.ident().name, p => this.set('saving', `Uploading ${p.done}/${p.total} files...`, { progress: p }));
          this.lastSync = { at: Date.now(), version: r.version, files: r.uploaded, bytes: r.bytes }; lastErr = null; break;
        } catch (e) { lastErr = e; if (e.lost) break; this.log('Upload attempt failed: ' + e.message); await sleep(Math.min(5000, this.timing.tickMs)); }
      }
      this.progress = null;
      if (lastErr) {
        if (lastErr.lost) { this.clearTimers(); this.restoreRam(); this.epoch = 0; this.handing = false; return this.set('lost', 'Another host took over before your upload finished.'); }
        this.handing = false;
        return this.set('error', 'Could not upload the world: ' + lastErr.message + ' Your world is safe on this PC. Press "Retry upload".', { error: lastErr.message });
      }
      await this.coord.gc(this.epoch).catch(() => {});
      this.clearTimers();
      await this.coord.release(this.epoch).catch(() => {});
      this.epoch = 0; this.restoreRam();
      this.set('off', 'Server asleep - saved to the cloud.');
    } finally { this.handing = false; }
  }
  /** user pressed "Stop & hand off" or "Retry upload" */
  async stopHosting() { if (this.phase === 'hosting') return this.handoff('you stopped it'); if (this.phase === 'error' && this.epoch) return this.handoff('retry'); throw new Error('Not hosting.'); }

  // ---------------------------------------------------------------- waiting players and standby helpers
  async refresh() {
    if (!this.configured()) return null;
    try { this.remote = await this.ensure().status(); this.remoteErr = null; } catch (e) { this.remoteErr = e.message; }
    this.emitState(); return this.remote;
  }
  async requestHost() { const me = this.ident(); const r = await this.ensure().request(me.name); this.remote = r; this.emitState(); return r; }
  setStandby(on) {
    clearInterval(this.standbyT); this.standbyT = null;
    this.o.saveConfig({ batonStandby: !!on });
    if (on && this.configured()) this.standbyT = setInterval(() => this.standbyTick().catch(() => {}), this.timing.standbyMs);
    this.emitState();
  }
  async standbyTick() {
    if (!['off'].includes(this.phase) || !this.ramPlan().ok) return;
    const st = await this.refresh();
    if (st && st.state === 'free' && st.wanted) { this.log(`${st.wanted.by} is waiting to play - starting the server.`); await this.startHosting().catch(e => this.log('Standby start failed: ' + e.message)); }
  }
  boot() { if (this.cfg().batonStandby && this.configured()) this.setStandby(true); }

  snapshot() {
    const c = this.cfg(); const plan = this.ramPlan();
    return {
      configured: this.configured(), phase: this.phase, message: this.message, error: this.error, progress: this.progress,
      remote: this.remote, remoteErr: this.remoteErr || null, me: this.configured() ? this.ident() : null,
      hosting: this.phase === 'hosting', ramPlan: plan, lastSync: this.lastSync, standby: !!c.batonStandby,
      idleMin: Number(c.batonIdleMin) || 30, emptyForMs: this.emptySince ? Date.now() - this.emptySince : 0, syncMin: Math.round(this.timing.syncMs / 60000),
      address: c.serverAddress || '',
    };
  }
}

module.exports = { BatonHost };
