'use strict';
// Manages the Minecraft server java process: start/stop/restart, console I/O, state, players.
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { spawn } = require('child_process');
const EventEmitter = require('events');
const props = require('./props');
const { readJarVersion } = require('./zipread');
const { findJava } = require('./java');
const { IS_WIN, sleep } = require('./util');

const MAX_LINES = 3000;

class MinecraftServer extends EventEmitter {
  constructor(serverDir, getConfig) {
    super();
    this.dir = serverDir;
    this.getConfig = getConfig;
    this.proc = null;
    this.state = 'offline';        // offline | starting | online | stopping | crashed
    this.lines = [];
    this.lineId = 0;
    this.players = new Map();      // name -> {name, uuid, joinedAt}
    this.startedAt = null;
    this.onlineAt = null;
    this.userStop = false;
    this.restartAfterStop = false;
    this.crashTimes = [];
    this.runningVersion = null;
    this.waiters = [];             // {re, resolve, timer}
    this.quiet = [];               // {re, until} console lines to hide (dashboard's own queries)
    this.onlineCount = 0;
    this.recent = [];              // last console bodies (for error diagnosis)
    this.inspectLock = Promise.resolve();
    this.lastFailure = null;
  }

  get jarPath() { return path.join(this.dir, 'server.jar'); }
  get propsPath() { return path.join(this.dir, 'server.properties'); }
  isRunning() { return !!this.proc; }

  jarInfo() {
    const v = fs.existsSync(this.jarPath) ? readJarVersion(this.jarPath) : null;
    return v ? { id: v.id || v.name, name: v.name, java: v.java_version || null, protocol: v.protocol_version || null } : null;
  }

  setState(s, extra = {}) {
    this.state = s;
    this.emit('state', { state: s, ...extra });
  }

  log(text, level = 'dash') {
    const line = { id: ++this.lineId, t: Date.now(), text, level };
    this.lines.push(line);
    if (this.lines.length > MAX_LINES) this.lines.splice(0, this.lines.length - MAX_LINES);
    this.emit('line', line);
    return line;
  }

  /** Wait until a console line matches regex (or timeout). Resolves with match or null. */
  waitFor(re, timeoutMs) {
    return new Promise(resolve => {
      const w = { re, resolve };
      w.timer = setTimeout(() => { this.waiters = this.waiters.filter(x => x !== w); resolve(null); }, timeoutMs);
      this.waiters.push(w);
    });
  }

  ensureRpcProps() {
    // Enable the built-in Minecraft Server Management Protocol on localhost (no TLS) for live data.
    const cfg = this.getConfig();
    if (!cfg.useManagementApi) return;
    const cur = props.getAll(this.propsPath);
    const want = {
      'management-server-enabled': 'true',
      'management-server-host': 'localhost',
      'management-server-port': String(cfg.rpcPort),
      'management-server-tls-enabled': 'false',
    };
    const changes = {};
    for (const [k, v] of Object.entries(want)) if (cur[k] !== v) changes[k] = v;
    if (Object.keys(changes).length && fs.existsSync(this.propsPath)) props.setMany(this.propsPath, changes);
  }

  async start() {
    if (this.proc) throw new Error('Server is already running');
    const cfg = this.getConfig();
    if (!fs.existsSync(this.jarPath)) throw new Error('server.jar not found. Install a version on the Software page first.');
    const eula = path.join(this.dir, 'eula.txt');
    if (!fs.existsSync(eula) || !/^\s*eula\s*=\s*true/m.test(fs.readFileSync(eula, 'utf8'))) {
      const err = new Error('You need to accept the Minecraft EULA first.'); err.code = 'EULA'; throw err;
    }
    const info = this.jarInfo();
    const need = (info && info.java) || 21;
    const { best } = findJava(need, cfg.javaPath);
    if (!best) { const err = new Error(`Java ${need} or newer is required for this version.`); err.code = 'JAVA'; err.need = need; throw err; }

    this.ensureRpcProps();
    if (this.beforeStart) await this.beforeStart();       // e.g. open the Live Sync front door
    const args = [`-Xms${cfg.minRam}`, `-Xmx${cfg.maxRam}`, ...String(cfg.jvmFlags || '').split(/\s+/).filter(Boolean), '-jar', 'server.jar', 'nogui', ...(this.extraArgs ? this.extraArgs() : [])];
    this.listenPort = this.listenPortFor ? this.listenPortFor() : null;
    this.log(`Starting ${info ? info.id : 'server'} with Java ${best.major} (${cfg.maxRam} RAM)`, 'dash');
    this.userStop = false;
    this.players.clear();
    this.emit('players', this.playerList());
    this.startedAt = Date.now();
    this.onlineAt = null;
    this.runningVersion = info ? info.id : null;
    this.lastFailure = null;
    this.recent = [];
    this.setState('starting');

    const proc = spawn(best.path, args, { cwd: this.dir, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    this.proc = proc;
    proc.stdin.on('error', () => {});
    const onLine = (text, isErr) => this.handleLine(text, isErr);
    readline.createInterface({ input: proc.stdout }).on('line', l => onLine(l, false));
    readline.createInterface({ input: proc.stderr }).on('line', l => onLine(l, true));
    proc.on('error', e => { this.log('Failed to start Java: ' + e.message, 'error'); });
    proc.on('exit', (code, signal) => this.handleExit(code, signal));
  }

  handleLine(text, isErr) {
    let level = isErr ? 'error' : 'info';
    if (/\/WARN\]/.test(text)) level = 'warn';
    else if (/\/(ERROR|FATAL)\]/.test(text)) level = 'error';
    // 26.x prefixes some messages, e.g. "System chat: Steve joined the game" or "[Not Secure] <Steve> hi"
    const body = text.replace(/^\[[^\]]*\]\s*\[[^\]]*\]:\s*/, '').replace(/^(?:System chat|Chat):\s*/, '').replace(/^\[Not Secure\]\s*/, '');
    if (/^RPC Connection #\d+: Management connection (opened|closed)/.test(body)) return; // dashboard's own API link - noise
    let m;
    if (/: Done \([\d.,]+s\)! For help/.test(text)) {
      this.onlineAt = Date.now();
      this.setState('online');
      level = 'success';
    } else if ((m = body.match(/^(\S+) joined the game$/))) {
      this.addPlayer(m[1]); level = 'join';
    } else if ((m = body.match(/^(\S+) left the game$/))) {
      this.removePlayer(m[1]); level = 'leave';
    } else if ((m = body.match(/^(\S+)\[\/?([^\]]*)\] logged in with entity id/))) {
      this.pendingIp = { name: m[1], ip: m[2] };
    } else if ((m = body.match(/There are (\d+) of a max(?: of)? (\d+) players online:?\s*(.*)$/))) {
      const names = m[3].split(',').map(s => s.trim()).filter(Boolean);
      const keep = new Map();
      for (const n of names) keep.set(n, this.players.get(n) || { name: n, joinedAt: Date.now() });
      this.players = keep; this.onlineCount = Number(m[1]); this.emit('players', this.playerList());
    } else if (/^Stopping (the )?server$/.test(body)) {
      if (this.state !== 'stopping') this.setState('stopping');
    } else if ((m = body.match(/^Starting minecraft server version (.+)$/))) {
      this.runningVersion = m[1].trim();
    } else if (/^<[^>]+> /.test(body)) {
      level = 'chat';
    }
    const now = Date.now();
    this.quiet = this.quiet.filter(q => q.until > now);
    const qi = this.quiet.findIndex(q => q.re.test(body));
    if (qi >= 0) this.quiet.splice(qi, 1); else this.log(text, level);
    this.recent.push(body); if (this.recent.length > 40) this.recent.shift();
    for (const w of [...this.waiters]) {
      const mm = body.match(w.re) || text.match(w.re);
      if (mm) { clearTimeout(w.timer); this.waiters = this.waiters.filter(x => x !== w); w.resolve(mm); }
    }
  }

  addPlayer(name, uuid) {
    const p = { name, joinedAt: Date.now() };
    if (uuid) p.uuid = uuid;
    if (this.pendingIp && this.pendingIp.name === name) p.ip = this.pendingIp.ip;
    const prev = this.players.get(name);
    if (!prev) this.emit('join', name);
    this.players.set(name, prev ? { ...p, ...prev, ...(p.ip ? { ip: p.ip } : {}) } : p);
    this.onlineCount = Math.max(this.onlineCount || 0, this.players.size);
    this.emit('players', this.playerList());
  }

  removePlayer(name) {
    if (this.players.delete(name)) { this.onlineCount = this.players.size; this.emit('players', this.playerList()); }
  }

  syncPlayers(list) {
    // list from management API: [{id,name}]
    const next = new Map();
    for (const p of list) next.set(p.name, { ...(this.players.get(p.name) || { joinedAt: Date.now() }), name: p.name, uuid: p.id });
    this.players = next;
    this.onlineCount = next.size;
    this.emit('players', this.playerList());
  }

  /** Reconcile with a Server List Ping result {online, sample:[{name,id}]}. Returns true if the list changed. */
  reconcile(r) {
    const before = [...this.players.keys()].sort().join('|');
    const next = new Map();
    const add = (name, id) => next.set(name, this.players.get(name) || { name, uuid: id, joinedAt: Date.now() });
    if (r.online > 0) {
      for (const p of r.sample) add(p.name, p.id);
      if (next.size < r.online) {           // sample is partial (players hidden, or 12+ online)
        for (const [n, p] of this.players) { if (next.size >= r.online) break; if (!next.has(n)) next.set(n, p); }
      }
    }
    this.players = next;
    const countChanged = this.onlineCount !== r.online;
    this.onlineCount = r.online;
    const changed = [...next.keys()].sort().join('|') !== before;
    if (changed || countChanged) this.emit('players', this.playerList());
    return changed;
  }

  playerList() { return [...this.players.values()]; }

  diagnoseFailure() {
    const t = this.recent.join('\n');
    const rules = [
      [/FAILED TO BIND TO PORT|Address already in use|BindException/i, 'PORT_BUSY', 'Another program (usually another Minecraft server, e.g. the old run.bat) is already using the server port.'],
      [/session\.lock|already locked|DirectoryLock/i, 'WORLD_LOCKED', 'The world is open in another Minecraft server. Close the other server window first.'],
      [/OutOfMemoryError|Could not reserve enough space|Invalid maximum heap size/i, 'MEMORY', 'Not enough memory for the RAM setting - lower Maximum RAM in Settings.'],
      [/UnsupportedClassVersionError|has been compiled by a more recent version/i, 'JAVA_OLD', 'Java is too old for this Minecraft version.'],
      [/eula/i, 'EULA', 'The EULA needs to be accepted.'],
      [/Failed to start the minecraft server|Exception in server tick loop|Encountered an unexpected exception/i, 'CRASH', 'Minecraft crashed while starting - see the console for the error.'],
    ];
    for (const [re, code, hint] of rules) if (re.test(t)) return { code, hint, at: Date.now() };
    return { code: 'UNKNOWN', hint: 'The server stopped while starting. Check the console for the last error lines.', at: Date.now() };
  }

  handleExit(code, signal) {
    const wasState = this.state;
    this.lastFailure = (wasState === 'starting' && !this.userStop && code !== 0) ? this.diagnoseFailure() : null;
    if (this.lastFailure) this.log('Start failed: ' + this.lastFailure.hint, 'error');
    this.proc = null;
    const clean = this.userStop || code === 0;
    this.log(`Server process exited (code ${code ?? signal}).`, clean ? 'dash' : 'error');
    this.players.clear();
    this.onlineCount = 0;
    this.emit('players', []);
    this.startedAt = null; this.onlineAt = null;
    for (const w of this.waiters) { clearTimeout(w.timer); w.resolve(null); }
    this.waiters = [];

    if (this.restartAfterStop) {
      this.restartAfterStop = false;
      this.setState('offline');
      setTimeout(() => this.start().catch(e => this.log('Restart failed: ' + e.message, 'error')), 1500);
      return;
    }
    if (clean) { this.setState('offline'); this.emit('stopped'); return; }

    this.setState('crashed', { code });
    const cfg = this.getConfig();
    const now = Date.now();
    this.crashTimes = this.crashTimes.filter(t => now - t < 10 * 60 * 1000);
    this.crashTimes.push(now);
    if (cfg.autoRestart && wasState !== 'starting' && this.crashTimes.length <= 3) {
      this.log('Crash detected - restarting in 10 seconds...', 'warn');
      setTimeout(() => { if (!this.proc && this.state === 'crashed') this.start().catch(e => this.log('Restart failed: ' + e.message, 'error')); }, 10000);
    } else if (cfg.autoRestart) {
      this.log('Not auto-restarting (crashed during startup or 3+ crashes in 10 minutes). Check the log above.', 'error');
    }
  }

  send(cmd) {
    if (!this.proc) throw new Error('Server is offline');
    const c = String(cmd).replace(/^\//, '').replace(/[\r\n]/g, ' ').trim();
    if (!c) return;
    this.log('> ' + c, 'cmd');
    if (/^stop$/i.test(c)) { this.userStop = true; this.setState('stopping'); }
    this.proc.stdin.write(c + '\n');
  }

  /** Send a command without echoing it (or its reply) into the console view. */
  sendQuiet(cmd, replyRe) {
    if (!this.proc) throw new Error('Server is offline');
    if (replyRe) this.quiet.push({ re: replyRe, until: Date.now() + 5000 });
    this.proc.stdin.write(String(cmd).replace(/[\r\n]/g, ' ') + '\n');
  }

  /** Read a player's live stats with /data get (health, food, xp, position, dimension, game mode). */
  inspect(name) {
    // one inspect at a time, so replies can't get mixed up between players
    const run = this.inspectLock.then(() => this._inspect(name));
    this.inspectLock = run.catch(() => {});
    return run;
  }

  async _inspect(name) {
    if (this.state !== 'online') throw new Error('Server is offline');
    if (!/^[\w.\-]{1,16}$/.test(name)) throw new Error('This name cannot be used in commands');
    const esc = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // 26.x may prefix console feedback (e.g. "System chat: ..."), so match the phrase anywhere in the line
    const reply = new RegExp(`(?:^|: )${esc} has the following entity data: (.*)$|(No entity was found|Unknown or incomplete command|Incorrect argument)`, 'i');
    const fields = { Health: 'health', foodLevel: 'food', XpLevel: 'xp', Pos: 'pos', Dimension: 'dimension', playerGameType: 'gamemode' };
    const out = {};
    let lastReply = null, got = 0;
    for (const [path, key] of Object.entries(fields)) {
      const wait = this.waitFor(reply, 4000);
      this.sendQuiet(`data get entity ${name} ${path}`, reply);
      const m = await wait;
      if (!m) { lastReply = 'no reply from the server within 4 s'; continue; }
      if (m[1] === undefined) { lastReply = m[0]; if (/No entity/i.test(m[0])) break; continue; }
      out[key] = m[1].trim(); got++;
    }
    if (!got) throw new Error(/No entity/i.test(lastReply || '') ? `${name} is not online right now.` : `Couldn't read ${name}'s data (server said: ${lastReply}).`);
    const num = v => v == null ? null : parseFloat(String(v).replace(/[^\d.\-]/g, ''));
    const pos = out.pos ? out.pos.replace(/[\[\]d]/g, '').split(',').map(x => Math.round(parseFloat(x))) : null;
    return {
      name,
      health: num(out.health), food: num(out.food), xp: num(out.xp),
      pos: pos && pos.length === 3 && pos.every(n => !isNaN(n)) ? pos : null,
      dimension: out.dimension ? out.dimension.replace(/"/g, '') : null,
      gamemode: ['survival', 'creative', 'adventure', 'spectator'][num(out.gamemode)] || null,
    };
  }

  async stop(timeoutMs = 90000) {
    if (!this.proc) return;
    this.userStop = true;
    this.setState('stopping');
    const proc = this.proc;
    try { proc.stdin.write('stop\n'); } catch { /* ignore */ }
    const exited = await Promise.race([
      new Promise(r => proc.once('exit', () => r(true))),
      sleep(timeoutMs).then(() => false),
    ]);
    if (!exited) { this.log('Server did not stop in time - killing it.', 'warn'); this.kill(); await sleep(1000); }
  }

  restart() {
    if (!this.proc) return this.start();
    this.restartAfterStop = true;
    return this.stop();
  }

  kill() {
    if (!this.proc) return;
    this.userStop = true;
    if (IS_WIN) spawn('taskkill', ['/PID', String(this.proc.pid), '/T', '/F'], { windowsHide: true }).on('error', () => this.proc && this.proc.kill());
    else this.proc.kill('SIGKILL');
  }

  status() {
    return {
      state: this.state,
      pid: this.proc ? this.proc.pid : null,
      startedAt: this.startedAt,
      onlineAt: this.onlineAt,
      version: this.runningVersion,
      players: this.playerList(),
      lastFailure: this.lastFailure,
      onlineCount: Math.max(this.onlineCount || 0, this.players.size),
    };
  }
}

module.exports = { MinecraftServer };
