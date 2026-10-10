'use strict';
// Remote control (owner side): while a friend's PC hosts the server, this keeps the owner's dashboard in the loop.
// It polls the coordinator for what the host reports (server state, who is online, the newest console lines) and queues
// the owner's commands for the host to run. The console lines are written into the normal console, so every existing
// page keeps working. Polling is fast only while a browser tab is open on the dashboard; the host speeds up its own
// reporting only while it is being watched, so an unattended server costs next to nothing on the free Cloudflare plan.
const EventEmitter = require('events');

class RemoteWatch extends EventEmitter {
  /** o: {baton, mc, watched(): bool, timing:{fastMs,slowMs}} */
  constructor(o) {
    super();
    this.o = o; this.baton = o.baton; this.mc = o.mc;
    this.timing = { fastMs: 3000, midMs: 8000, slowMs: 30000, ...(o.timing || {}) };
    this.active = false; this.host = null; this.epoch = 0; this.tele = null; this.lastId = 0; this.adminOk = null; this.error = ''; this.stopped = true;
  }
  start() { if (!this.stopped) return; this.stopped = false; this.schedule(1500); }
  stop() { this.stopped = true; clearTimeout(this.t); }
  schedule(ms) { clearTimeout(this.t); if (this.stopped) return; this.t = setTimeout(() => this.tick(), ms); }
  async tick() {
    try { await this.poll(); } catch (e) { this.error = e.message; this.publish(); }
    const w = this.o.watched();
    this.schedule(w ? (this.active ? this.timing.fastMs : this.timing.midMs) : this.timing.slowMs);
  }
  /** a browser tab just opened: look right away */
  nudge() { if (!this.stopped) this.schedule(200); }
  /** is the server running on this PC (or about to be)? then there is nothing to mirror */
  localBusy() { return this.mc.isRunning() || !['off', 'error', 'lost'].includes(this.baton.phase); }

  async poll() {
    if (!this.baton.configured() || this.localBusy()) return this.detach();
    const coord = this.baton.ensure();
    const admin = !!this.baton.cfg().batonAdmin;
    let r = null;
    // peek also tells the host "someone is watching" (fast reporting); a plain status call does not
    if (admin && this.adminOk !== false && this.o.watched()) {
      try { r = await coord.peek(this.lastId); this.adminOk = true; }
      catch (e) { if (e.admin) { this.adminOk = false; this.adminErr = e.message; } else throw e; }
    }
    if (!r) r = await coord.status();
    this.error = '';
    const me = this.baton.ident().id;
    if (r.state === 'hosted' && r.host && r.host.id !== me) this.attach(r); else this.detach();
  }
  attach(r) {
    if (!this.active || r.epoch !== this.epoch) {
      this.lastId = 0; this.tele = null; this.epoch = r.epoch;
      this.mc.log(`Connected to ${r.host.name}'s server (it is running on their PC).`, 'dash');
    }
    this.active = true; this.host = { name: r.host.name, address: r.host.address || '', since: r.host.since || 0, phase: r.host.phase || '', players: r.host.players || 0 };
    if (r.tele) {
      this.tele = r.tele;
      for (const l of (r.tele.lines || [])) if (l.id > this.lastId) { this.mc.log(l.text, l.level); this.lastId = l.id; }
      if (r.tele.lastId > this.lastId) this.lastId = r.tele.lastId;
    }
    this.publish();
  }
  publish() { const v = this.view(), j = JSON.stringify(v); if (j !== this.lastView) { this.lastView = j; this.emit('update', v); } }
  detach() {
    if (!this.active) return;
    const name = this.host && this.host.name;
    this.active = false; this.host = null; this.tele = null; this.epoch = 0; this.lastId = 0;
    this.mc.log(`${name ? name + "'s" : 'The'} server is no longer running (the world is saved to the cloud).`, 'dash');
    this.publish();
  }

  view() {
    if (!this.active) return { on: false, needsUpdate: this.adminOk === false, error: this.error };
    const t = this.tele;
    const state = t && t.state ? t.state : (this.host.phase === 'hosting' ? 'online' : 'starting');
    const names = t ? t.players : [];
    return {
      on: true, host: this.host, state, version: t ? t.version : '', startedAt: t ? t.startedAt : 0, players: names, count: t ? names.length : this.host.players,
      control: this.adminOk === true, needsUpdate: this.adminOk === false, controlNote: this.adminOk === false ? this.adminErr : '', error: this.error,
    };
  }

  need() {
    if (!this.active) throw new Error('Nobody else is hosting right now.');
    if (!this.baton.cfg().batonAdmin) throw new Error('Remote control is not set up yet - open Cloud Host and press "Update cloud".');
    if (this.adminOk === false) throw new Error(this.adminErr || 'Remote control is not switched on in your cloud yet - press "Update cloud".');
  }
  async command(text) {
    this.need();
    const r = await this.baton.ensure().command(String(text), 'cmd');
    if (!r.ok) throw new Error(r.reason === 'nobody' ? 'The server just stopped.' : 'That command was empty.');
    setTimeout(() => this.poll().catch(() => {}), 1500);
    return r;
  }
  async handoff() {
    this.need();
    const r = await this.baton.ensure().command('', 'handoff');
    if (!r.ok) throw new Error('The server just stopped.');
    setTimeout(() => this.poll().catch(() => {}), 1500);
    return r;
  }
}

module.exports = { RemoteWatch };
