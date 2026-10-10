'use strict';
// Blockhost player runtime: runs on a FRIEND's PC next to the Blockhost Sync tray app (no dashboard there).
//   node player.js <hostDir> [prepare]
// It reuses the same Baton Host engine as the dashboard: pull the newest world from the cloud, run the server,
// open the shared playit tunnel, keep the cloud copy fresh, and hand the baton back when everyone has left.
// The tray app talks to it over a token-protected API on 127.0.0.1.
const fs = require('fs');
const path = require('path');
const http = require('http');
const os = require('os');
const crypto = require('crypto');
const net = require('net');
const { spawn } = require('child_process');
const { parseSecret } = require('./hostbundle');
const props = require('./props');
const { MinecraftServer } = require('./mc');
const { BatonHost } = require('./batonhost');
const { ensureJre } = require('./provision');
const { installPlayit } = require('./playit');
const { IS_WIN } = require('./util');

const DEFAULT_JAVA = 25;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const readJSON = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };

function pidAlive(pid) { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } }

/** o: {dir, fetchImpl?, ensureJre?, installPlayit?, spawnPlayit?, timing?, idleExitMs?} */
function createPlayer(o) {
  const dir = o.dir;
  const host = readJSON(path.join(dir, 'host.json'), {});        // {code, playitKey, address, world, name, java}
  const serverDir = path.join(dir, 'server');
  const dataDir = path.join(dir, 'data');
  const binDir = path.join(dir, 'bin');
  fs.mkdirSync(serverDir, { recursive: true }); fs.mkdirSync(dataDir, { recursive: true }); fs.mkdirSync(binDir, { recursive: true });
  const cfgFile = path.join(dataDir, 'config.json');
  const defaults = {
    minRam: '2G', maxRam: '4G', jvmFlags: '', javaPath: '', useManagementApi: false, rpcPort: 25585, autoRestart: false,
    batonCode: '', batonIdleMin: 15, batonMinHostGB: 6, batonMaxRamGB: 4, batonStandby: false, serverAddress: '', batonName: '',
  };
  let config = { ...defaults, ...readJSON(cfgFile, {}), ...(o.config || {}) };
  // the owner's settings win over what this PC saved before
  if (host.code) config.batonCode = host.code;
  if (host.address) config.serverAddress = host.address;
  if (host.name && !config.batonName) config.batonName = host.name;
  const getConfig = () => config;
  const saveConfig = patch => { config = { ...config, ...patch }; try { fs.writeFileSync(cfgFile, JSON.stringify(config, null, 2)); } catch { /* disk full etc. */ } };
  const logFile = path.join(dir, 'host.log');
  const log = t => {
    try {
      if (fs.existsSync(logFile) && fs.statSync(logFile).size > 1048576) fs.renameSync(logFile, logFile + '.old');
      fs.appendFileSync(logFile, `${new Date().toISOString().replace('T', ' ').slice(0, 19)}  ${t}\n`);
    } catch { /* ignore */ }
  };

  const mc = new MinecraftServer(serverDir, getConfig);
  mc.on('line', l => { if (l.level !== 'info' || /Done \(|joined|left the game|Stopping|ERROR|Exception/i.test(l.text)) log('mc: ' + l.text.slice(0, 300)); });
  const worldName = () => host.world || props.getAll(path.join(serverDir, 'server.properties'))['level-name'] || 'world';
  const baton = new BatonHost({ mc, dir: serverDir, getConfig, saveConfig, log, fetchImpl: o.fetchImpl, worldName, stateFile: path.join(dataDir, 'baton-state.json'), timing: o.timing, idleMsOverride: o.idleMsOverride });

  const P = { prep: '', prepPct: 0, playit: null, playitErr: '', lastActive: Date.now(), quitting: false };
  const doEnsureJre = o.ensureJre || ensureJre;
  const doInstallPlayit = o.installPlayit || installPlayit;

  // ------------------------------------------------------------------ Java + playit
  async function prepare() {
    const progress = (m, pct) => { if (m) P.prep = m; if (pct != null) P.prepPct = pct; };
    try {
      progress('Getting Java ready (first time only)...', 0);
      const exe = await doEnsureJre(path.join(dir, 'java'), host.java || DEFAULT_JAVA, { log: m => progress(m), progress: pct => progress(null, pct) });
      saveConfig({ javaPath: exe });
      if (host.playitKey) {
        const have = playitExe();
        if (!have) {
          progress('Getting the tunnel helper (playit.gg)...', 0);
          await doInstallPlayit(dir, (m, pct) => progress(m, pct));
        }
      }
    } finally { P.prep = ''; P.prepPct = 0; }
  }
  function playitExe() {
    const p = path.join(binDir, IS_WIN ? 'playit.exe' : 'playit');
    return fs.existsSync(p) ? p : null;
  }
  // playit's Windows build is a daemon ("playitd"): it takes --secret / --socket-path / --log-path, and refuses to start when the
  // playit Windows service is already running on this PC. If that service already uses the group's key, the tunnel exists - don't start a second one.
  function serviceHasKey() {
    if (!IS_WIN || !host.playitKey) return false;
    try { return parseSecret(fs.readFileSync(path.join(process.env.ProgramData || 'C:\\ProgramData', 'playit_gg', 'playit.toml'), 'utf8')) === host.playitKey; } catch { return false; }
  }
  const playitLog = path.join(dir, 'playit.log');
  function startPlayit() {
    if (P.playit || !host.playitKey) return;
    if (serviceHasKey()) { P.playitErr = ''; P.tunnelVia = 'the playit service already running on this PC'; log('Using the playit service already running on this PC.'); return; }
    const exe = playitExe();
    if (!exe) { P.playitErr = 'The tunnel helper is missing.'; return; }
    P.playitErr = ''; P.tunnelVia = 'its own tunnel helper';
    const spawnIt = o.spawnPlayit || ((x, env) => {
      const out = fs.openSync(playitLog, 'w');
      return spawn(x, ['--socket-path', IS_WIN ? '\\\\.\\pipe\\blockhost-playit' : path.join(dir, 'playit.sock'), '--log-path', path.join(dir, 'playitd.log')], { env, windowsHide: true, stdio: ['ignore', out, out] });
    });
    const child = spawnIt(exe, { ...process.env, SECRET: host.playitKey, SECRET_KEY: host.playitKey });
    P.playit = child; log('Tunnel started.');
    child.on('exit', code => {
      if (P.playit === child) {
        P.playit = null; log('Tunnel stopped (' + code + ').');
        if (code) { let t = ''; try { t = fs.readFileSync(playitLog, 'utf8').trim().split(/\r?\n/).slice(-3).join(' | '); } catch { /* none */ } P.playitErr = `The tunnel helper stopped (code ${code}). ${t}`.slice(0, 300); log('Tunnel output: ' + t); }
      }
    });
    child.on('error', e => { P.playitErr = e.message; if (P.playit === child) P.playit = null; });
  }
  function stopPlayit() { const c = P.playit; P.playit = null; if (c) { try { c.kill(); } catch { /* gone */ } log('Tunnel closed.'); } }

  // the server jar can ask for a newer Java than the one we fetched first: fetch that too, right before it starts
  const rawStart = mc.start.bind(mc);
  mc.start = async () => {
    const info = mc.jarInfo(); const need = (info && info.java) || DEFAULT_JAVA;
    const cur = config.javaPath ? require('./java').javaMajor(config.javaPath) : 0;
    if (cur < need) {
      P.prep = `Getting Java ${need}...`;
      try { saveConfig({ javaPath: await doEnsureJre(path.join(dir, 'java'), need, { log, progress: () => {} }) }); } finally { P.prep = ''; }
    }
    if (host.port) { try { props.setMany(path.join(serverDir, 'server.properties'), { 'server-port': String(host.port) }); } catch (e) { log('Could not set the server port: ' + e.message); } }
    return rawStart();
  };


  // can the internet reach the shared address? A Minecraft "status" ping through the public address, from this PC
  function pingAddress(addr, timeoutMs = 6000) {
    return new Promise(resolve => {
      const m = String(addr || '').match(/^([^:]+)(?::(\d+))?$/); if (!m) return resolve({ ok: false, error: 'no address' });
      const hostName = m[1], port = Number(m[2]) || 25565;
      const vi = n => { const b = []; do { let x = n & 0x7f; n >>>= 7; if (n) x |= 0x80; b.push(x); } while (n); return Buffer.from(b); };
      const str = t => { const b = Buffer.from(t, 'utf8'); return Buffer.concat([vi(b.length), b]); };
      const pk = body => Buffer.concat([vi(body.length), body]);
      const port2 = Buffer.alloc(2); port2.writeUInt16BE(port);
      const sock = net.connect({ host: hostName, port });
      let done = false, got = Buffer.alloc(0);
      const fin = r => { if (done) return; done = true; clearTimeout(t); sock.destroy(); resolve(r); };
      const t = setTimeout(() => fin({ ok: false, error: 'no answer in ' + Math.round(timeoutMs / 1000) + ' s' }), timeoutMs);
      sock.on('connect', () => { sock.write(pk(Buffer.concat([vi(0), vi(772), str(hostName), port2, vi(1)]))); sock.write(pk(vi(0))); });
      sock.on('data', d => { got = Buffer.concat([got, d]); if (got.length > 8 && got.includes(Buffer.from('"version"')) || got.includes(Buffer.from('description'))) fin({ ok: true }); });
      sock.on('error', e => fin({ ok: false, error: e.code === 'ECONNREFUSED' ? 'refused (nothing is forwarding the tunnel to this PC)' : e.code === 'ENOTFOUND' ? 'address not found' : e.message }));
      sock.on('close', () => fin({ ok: got.length > 0, error: got.length ? '' : 'the connection was closed straight away' }));
    });
  }
  async function reachCheck() {
    P.reach = { state: 'checking' };
    const r = await (o.pingAddress || pingAddress)(config.serverAddress);
    P.reach = r.ok ? { state: 'ok' } : { state: 'fail', error: r.error };
    log('Reach check ' + config.serverAddress + ': ' + (r.ok ? 'ok' : r.error));
  }

  baton.on('state', s => {
    P.lastActive = Date.now();
    if (s.phase === 'hosting' && P.lastPhase !== 'hosting') setTimeout(() => reachCheck().catch(() => {}), o.reachDelayMs != null ? o.reachDelayMs : 8000);
    P.lastPhase = s.phase;
    if (s.phase !== 'hosting') P.reach = null;
    if (s.phase === 'starting' || s.phase === 'hosting') startPlayit();
    else if (['off', 'lost', 'error'].includes(s.phase)) stopPlayit();
  });

  // ------------------------------------------------------------------ control API
  const token = crypto.randomBytes(24).toString('hex');
  const view = () => {
    const s = baton.snapshot();
    return {
      ok: true, pid: process.pid, phase: s.phase, message: s.message, error: s.error, progress: s.progress, hosting: s.hosting,
      remote: s.remote, remoteErr: s.remoteErr, standby: s.standby, address: s.address, ramPlan: s.ramPlan, lastSync: s.lastSync,
      configured: s.configured, players: mc.players ? mc.players.size : 0, prep: P.prep, prepPct: P.prepPct,
      tunnel: !!P.playit || !!(P.tunnelVia && !P.playitErr && baton.phase === 'hosting'), tunnelErr: P.playitErr, tunnelVia: P.tunnelVia || '', reach: P.reach || null, port: host.port || null, version: 2, name: host.name || '',
    };
  };
  const routes = {
    'GET /state': async ({ fresh }) => { if (fresh && ['off', 'error', 'lost'].includes(baton.phase)) await baton.refresh(); return view(); },
    'POST /start': async () => {
      if (!['off', 'error', 'lost'].includes(baton.phase)) return view();
      await prepare();
      const p = baton.startHosting(); p.catch(e => log('Start failed: ' + e.message));
      await Promise.race([p.catch(() => {}), sleep(1500)]);
      return view();
    },
    'POST /stop': async () => { baton.stopHosting().catch(e => log('Stop failed: ' + e.message)); await sleep(200); return view(); },
    'POST /recheck': async () => { await reachCheck(); return view(); },
    'POST /request': async () => { await baton.requestHost(); return view(); },
    'POST /standby': async ({ body }) => { baton.setStandby(!!body.on); return view(); },
    'POST /quit': async () => { setTimeout(() => shutdown(), 50); return { ok: true }; },
  };
  const server = http.createServer((req, res) => {
    const send = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(obj)); };
    if (req.headers['x-bh-token'] !== token || (req.headers.host || '').split(':')[0] !== '127.0.0.1') return send(403, { ok: false, error: 'forbidden' });
    const u = new URL(req.url, 'http://127.0.0.1');
    const h = routes[req.method + ' ' + u.pathname];
    if (!h) return send(404, { ok: false, error: 'unknown' });
    let raw = '';
    req.on('data', c => { raw += c; if (raw.length > 65536) req.destroy(); });
    req.on('end', async () => {
      let body = {}; try { body = raw ? JSON.parse(raw) : {}; } catch { /* ignore */ }
      P.lastActive = Date.now();
      try { send(200, await h({ body, fresh: u.searchParams.get('fresh') === '1' })); }
      catch (e) { send(200, { ...view(), ok: false, error: e.message, code: e.code || '' }); }
    });
  });

  const lockFile = path.join(dir, 'control.json');
  async function listen() {
    const cur = readJSON(lockFile, null);
    if (cur && cur.pid && cur.pid !== process.pid && pidAlive(cur.pid)) throw Object.assign(new Error('already running'), { code: 'RUNNING' });
    await new Promise((ok, bad) => { server.once('error', bad); server.listen(0, '127.0.0.1', ok); });
    const port = server.address().port;
    fs.writeFileSync(lockFile, JSON.stringify({ port, token, pid: process.pid }));
    log(`Player runtime ready on 127.0.0.1:${port}`);
    baton.boot();
    // go to sleep after a while when there is nothing to do, so a friend's PC isn't carrying an idle process all day
    const idleExit = o.idleExitMs != null ? o.idleExitMs : 30 * 60000;
    P.idleT = setInterval(() => {
      if (baton.phase === 'off' && !config.batonStandby && Date.now() - P.lastActive > idleExit) shutdown();
    }, 30000);
    return { port, token };
  }
  async function shutdown() {
    if (P.quitting) return; P.quitting = true;
    clearInterval(P.idleT);
    try { if (baton.phase === 'hosting') await Promise.race([baton.handoff('the helper was closed'), sleep(180000)]); } catch { /* ignore */ }
    try { if (mc.isRunning()) mc.kill(); } catch { /* ignore */ }
    stopPlayit();
    try { const c = readJSON(lockFile, null); if (c && c.pid === process.pid) fs.rmSync(lockFile, { force: true }); } catch { /* ignore */ }
    server.close(); try { server.closeAllConnections(); } catch { /* old node */ }
    if (!o.noExit) setTimeout(() => process.exit(0), 200);
  }
  return { baton, mc, config: getConfig, listen, shutdown, prepare, view, routes, server, P, token, log };
}

async function main() {
  const dir = process.argv[2];
  if (!dir) { console.error('usage: node player.js <hostDir> [prepare]'); process.exit(2); }
  const p = createPlayer({ dir });
  if (process.argv[3] === 'prepare') {
    const t = setInterval(() => { if (p.P.prep) console.log(`${p.P.prep}${p.P.prepPct ? ' ' + p.P.prepPct + '%' : ''}`); }, 2000);
    try { await p.prepare(); console.log('Ready.'); process.exit(0); }
    catch (e) { console.error('FAILED: ' + e.message); process.exit(1); }
    finally { clearInterval(t); }
  }
  try { await p.listen(); } catch (e) { if (e.code === 'RUNNING') process.exit(0); console.error(e.message); process.exit(1); }
  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => p.shutdown());
  process.on('uncaughtException', e => p.log('uncaught: ' + (e && e.stack || e)));
  process.on('unhandledRejection', e => p.log('unhandled: ' + (e && e.stack || e)));
}
if (require.main === module) main();

module.exports = { createPlayer, DEFAULT_JAVA };
