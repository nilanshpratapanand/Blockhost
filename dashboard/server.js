'use strict';
/*
 * Blockhost - local Minecraft server dashboard.
 * Zero npm dependencies. Runs on http://localhost:<port> (default 8765), only reachable from this PC.
 */
const http = require('http');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { pipeline } = require('stream/promises');

const U = require('./lib/util');
const props = require('./lib/props');
const { MinecraftServer } = require('./lib/mc');
const { McRpc, asArray } = require('./lib/rpc');
const { Backups } = require('./lib/backups');
const { Updater } = require('./lib/updater');
const { findJava, installJava } = require('./lib/java');
const { extractZip, createZip } = require('./lib/archive');
const sys = require('./lib/sys');
const { ping } = require('./lib/ping');
const { buildInstaller } = require('./lib/installer');
const doctor = require('./lib/doctor');
const { Packs } = require('./lib/packs');
const { installPlayit, createDesktopShortcut } = require('./lib/playit');
const { SyncHost } = require('./lib/sync');
const { buildSyncBat, agentScript } = require('./lib/syncagent');
const { FrontDoor } = require('./lib/frontdoor');
const { FastLane } = require('./lib/fastlane');
const { mergePacks } = require('./lib/rpmerge');
const mcclient = require('./lib/mcclient');

const DASH_DIR = __dirname;
const FABRIC_META = process.env.BLOCKHOST_FABRIC || 'https://meta.fabricmc.net';
const SERVER_DIR = path.resolve(process.env.BLOCKHOST_SERVER_DIR || path.join(DASH_DIR, '..'));
const PUBLIC_DIR = path.join(DASH_DIR, 'public');
const CONFIG_FILE = path.join(DASH_DIR, 'config.json');

// ------------------------------------------------------------------ config
const DEFAULT_CONFIG = {
  port: 8765,
  minRam: '4G',
  maxRam: '4G',
  jvmFlags: '-XX:+UseG1GC -XX:+ParallelRefProcEnabled -XX:MaxGCPauseMillis=200 -XX:+DisableExplicitGC -XX:+AlwaysPreTouch',
  javaPath: '',
  autoRestart: true,
  autoStartServer: false,
  checkUpdatesOnLaunch: true,
  backupsToKeep: 10,
  autoBackupMinutes: 0,
  useManagementApi: true,
  rpcPort: 25585,
  serverAddress: '',
  playitPath: '',
  autoStartPlayit: false,
  openBrowser: true,
  myName: '',
  curseforgeKey: '',
  welcomeEnabled: false,
  welcomeText: 'Welcome {player}! For shaders & texture packs, ask the host for the installer and run it once.',
  welcomeFirstOnly: true,
  setupDone: false,
  serverPackName: '',
  syncEnabled: false,
  syncPort: 25570,
  syncAddress: '',
  syncToken: '',
  syncDefaultMode: 'next',
  syncIris: true,
  syncPolicy: null,
  syncShared: true,
  syncPublicAddress: '',    // manual override for the shared tunnel's public host:port        // Live Sync rides on the Minecraft playit tunnel (free) via the front door
  mcInternalPort: 25567,   // where Minecraft really listens while the front door is on
  fastLane: false,         // Cloudflare quick tunnel (free, no account) for fast sync + server texture pack
  serverPackAuto: null,    // {sha1, via, names} when the server texture pack is built from the kit
  lastPush: null,
};
let config = { ...DEFAULT_CONFIG, ...U.readJSONFile(CONFIG_FILE, {}) };
if (!fs.existsSync(CONFIG_FILE)) U.writeJSONFile(CONFIG_FILE, config);
const getConfig = () => config;
function saveConfig(patch) { config = { ...config, ...patch }; U.writeJSONFile(CONFIG_FILE, config); }

// ------------------------------------------------------------------ core objects
const mc = new MinecraftServer(SERVER_DIR, getConfig);
const backups = new Backups(SERVER_DIR, mc, getConfig);
const updater = new Updater(SERVER_DIR, mc, backups, getConfig);
const rpc = new McRpc();
const packs = new Packs(SERVER_DIR, DASH_DIR, mc, getConfig, saveConfig);
let latestRelease = null;
let playit = { running: false, path: null };
let statsHistory = [];
let lastStats = null;
let worldSize = 0;

// ------------------------------------------------------------------ SSE
const clients = new Set();
function broadcast(event, data) {
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of clients) { try { res.write(msg); } catch { /* ignore */ } }
}
mc.on('line', l => broadcast('line', l));
mc.on('state', s => { broadcast('state', snapshot()); onStateChange(s.state); });
// ---- welcome message for players who join
const SEEN_FILE = path.join(DASH_DIR, 'seen-players.json');
const seenPlayers = new Set(U.readJSONFile(SEEN_FILE, []));
mc.on('join', name => {
  const first = !seenPlayers.has(name.toLowerCase());
  if (first) { seenPlayers.add(name.toLowerCase()); try { U.writeJSONFile(SEEN_FILE, [...seenPlayers]); } catch { /* ignore */ } }
  if (!config.welcomeEnabled || (config.welcomeFirstOnly && !first) || !/^[\w.\-]{1,16}$/.test(name)) return;
  const text = String(config.welcomeText || '').replace(/\{player\}/g, name).replace(/\{address\}/g, config.serverAddress || '').slice(0, 256);
  if (!text.trim()) return;
  setTimeout(() => { try { mc.send(`tellraw ${name} ${JSON.stringify({ text, color: 'gold' })}`); } catch { /* offline */ } }, 3000);
});
// ---- Live Sync: friends' PCs follow the player kit automatically
// Front door: shares the Minecraft port (and its free playit tunnel) between the game and Live Sync
const publicPort = () => Number(serverProps()['server-port']) || 25565;
const internalPort = () => { const p = Number(config.mcInternalPort) || 25567; return p === publicPort() ? p + 1 : p; };
const sharedActive = () => !!(config.syncEnabled && config.syncShared !== false);
const front = new FrontDoor({
  getPorts: () => ({ publicPort: publicPort(), internalPort: internalPort(), httpPort: Number(config.syncPort) || 25570, host: serverProps()['server-ip'] || '0.0.0.0' }),
  log: m => mc.log(m, 'dash'),
  framed: resId => sync.framed(resId),
});
mc.beforeStart = async () => {
  await packs.processPendingDeletes();   // data packs removed while the server had them open
  if (config.serverPackAuto && config.serverPackAuto.via === 'fast') {   // the fast-lane address changes per run
    if (!fast.url && fast.wanted) await fast.waitUrl(20000);
    const want = fast.url ? `${fast.url}/rp/${config.serverPackAuto.sha1}.zip` : '';
    if (serverProps()['resource-pack'] !== want) props.setMany(path.join(SERVER_DIR, 'server.properties'), { 'resource-pack': want });
  }
  if (!sharedActive()) { front.stop(); return; }
  if (!(await front.start())) { const e = new Error(front.error); e.code = 'PORT_BUSY'; throw e; }
  if (await portInUse(internalPort())) { const e = new Error(`Port ${internalPort()} (used inside Blockhost for Minecraft) is busy. Change "Internal Minecraft port" on the Live Sync page.`); e.code = 'PORT_BUSY'; throw e; }
};
mc.extraArgs = () => sharedActive() ? ['--port', String(internalPort())] : [];
mc.listenPortFor = () => sharedActive() ? internalPort() : publicPort();
mc.on('state', s => {
  if (!mc.isRunning()) setTimeout(() => packs.processPendingDeletes().catch(() => {}), 1500);
  if (!mc.isRunning() && !sharedActive() && front.listening()) front.stop();
  setTimeout(() => sync.onChange(), 500);
});
// Applies Live Sync on/off while the server may be running. Returns true if a restart is still needed.
async function applyFront() {
  if (sharedActive()) {
    if (mc.isRunning() && mc.listenPort === publicPort()) return true;   // Minecraft still holds the public port
    await front.start();
  } else if (!mc.isRunning() || mc.listenPort === publicPort()) front.stop();
  else return true;                                                     // Minecraft is behind the front door
  return false;
}
const sync = new SyncHost({
  dashDir: DASH_DIR, getConfig, saveConfig, kitData: iris => kitData(iris), agentScript, versionKey: () => packs.gameVersion(),
  internalPort: () => internalPort(),
  restartNeeded: () => mc.isRunning() && mc.listenPort != null && mc.listenPort !== (sharedActive() ? internalPort() : publicPort()),
  log: m => mc.log(m, 'dash'),
  onChange: () => { clearTimeout(sync._t); sync._t = setTimeout(() => broadcast('sync', sync.status()), 300); },
});
sync.front = front;
const fast = new FastLane({
  dashDir: DASH_DIR, getPort: () => Number(config.syncPort) || 25570, log: m => mc.log(m, 'dash'),
  onUrl: url => { sync.fastUrl = url; sync.invalidate(); sync.onChange(); },
});
sync.fast = fast;
const SERVER_PACK_DIR = path.join(DASH_DIR, 'server-pack');
sync.serverPackFile = sha => { const f = path.join(SERVER_PACK_DIR, `server-pack-${sha}.zip`); return /^[0-9a-f]{40}$/.test(sha) && fs.existsSync(f) ? f : null; };

// Server texture pack built from ALL texture packs in the player kit. Every player (even without Blockhost) gets it
// when joining. Needs a public https/http address: a single Modrinth pack uses Modrinth's CDN, otherwise the fast lane.
async function applyServerPack(p = () => {}) {
  const kitDir = path.join(DASH_DIR, 'player-kit');
  const rps = packs.kitManifest().filter(e => e.folder === 'resourcepacks' && fs.existsSync(path.join(kitDir, 'resourcepacks', e.name)));
  const cfPub = e => e.url && !require('./lib/curseforge').isCfUrl(e.url) ? e.url : null;
  if (!rps.length) {
    if (config.serverPackAuto) { packs.clearServerPack(); saveConfig({ serverPackAuto: null }); return { ok: true, detail: 'No texture packs in the kit - server pack removed.' }; }
    return { ok: true, skipped: true, detail: 'No texture packs in the kit.' };
  }
  let url, sha1, via, names;
  if (rps.length === 1 && cfPub(rps[0]) && rps[0].sha1) { url = cfPub(rps[0]); sha1 = rps[0].sha1; via = 'cdn'; names = [rps[0].name]; }
  else {
    p('Merging texture packs into one server pack...');
    const m = await mergePacks(rps.map(e => ({ file: path.join(kitDir, 'resourcepacks', e.name), name: e.name })), SERVER_PACK_DIR, path.join(SERVER_DIR, 'server.jar'), path.join(SERVER_DIR, 'backups'));
    sha1 = m.sha1; names = m.names; via = 'fast';
    if (!fast.url) {
      if (!config.fastLane) return { ok: false, detail: `${rps.length} texture packs need a public address to be sent by the server - turn on "Fast lane" (free Cloudflare tunnel).` };
      p('Waiting for the fast lane address...'); await fast.waitUrl(25000);
      if (!fast.url) return { ok: false, detail: 'Fast lane is not online yet (' + (fast.error || 'starting') + ') - try again in a minute.' };
    }
    url = `${fast.url}/rp/${sha1}.zip`;
  }
  const sameAsBefore = config.serverPackAuto && config.serverPackAuto.sha1 === sha1 && serverProps()['resource-pack'] === url;
  props.setMany(path.join(SERVER_DIR, 'server.properties'), {
    'resource-pack': url, 'resource-pack-sha1': sha1,
    'resource-pack-id': [sha1.slice(0, 8), sha1.slice(8, 12), '4' + sha1.slice(13, 16), '8' + sha1.slice(17, 20), sha1.slice(20, 32)].join('-'),
    'require-resource-pack': 'false',
    'resource-pack-prompt': JSON.stringify({ text: `Server texture packs: ${names.map(n => n.replace(/\.zip$/i, '')).join(', ')}`.slice(0, 200) }),
  });
  saveConfig({ serverPackAuto: { sha1, via, names }, serverPackName: names.length === 1 ? names[0] : `${names.length} kit texture packs (merged)` });
  return { ok: true, restartNeeded: mc.isRunning() && !sameAsBefore, detail: `${names.length} texture pack${names.length > 1 ? 's' : ''} → ${via === 'cdn' ? 'Modrinth CDN' : 'fast lane'}${mc.isRunning() && !sameAsBefore ? ' (players get it after the next server restart / rejoin)' : ''}` };
}
mc.on('players', p => broadcast('players', { players: p, count: Math.max(mc.onlineCount || 0, p.length) }));

// ------------------------------------------------------------------ long-running tasks
let task = null;
function runTask(title, fn) {
  if (task && !task.done) throw new Error(`Busy: ${task.title}`);
  task = { id: Date.now(), title, msg: 'Starting...', pct: 0, done: false, error: null };
  broadcast('task', task);
  const progress = (msg, pct) => {
    if (msg) { task.msg = msg; mc.log(`[${title}] ${msg}`, 'dash'); }
    if (pct != null) task.pct = pct;
    broadcast('task', task);
  };
  Promise.resolve().then(() => fn(progress)).then(result => {
    task.done = true; task.pct = 100; task.result = result || null; task.msg = task.msg || 'Done';
    broadcast('task', task);
    broadcast('state', snapshot());
  }).catch(err => {
    task.done = true; task.error = err.message; task.code = err.code || null;
    mc.log(`[${title}] FAILED: ${err.message}`, 'error');
    broadcast('task', task);
    broadcast('state', snapshot());
  });
  return task;
}

// ------------------------------------------------------------------ management API glue
function serverProps() { return props.getAll(path.join(SERVER_DIR, 'server.properties')); }

async function rpcCall(names, params) {
  let lastErr;
  for (const n of [].concat(names)) {
    try { return await rpc.call(n, params); } catch (e) { lastErr = e; if (!rpc.connected) break; }
  }
  throw lastErr;
}

async function refreshPlayersFromRpc() {
  try {
    const r = await rpcCall(['minecraft:players', 'minecraft:players/']);
    if (!Array.isArray(r) && !(r && Array.isArray(r.players))) return; // unknown shape - don't touch the list
    const list = asArray(r, 'players').filter(p => p && p.name);
    // Never let an API answer wipe players the log already saw join; the ping check below settles counts.
    if (!list.length && mc.players.size) return;
    mc.syncPlayers(list);
  } catch { /* fall back to log parsing */ }
}

function notifPlayer(params) {
  let p = Array.isArray(params) ? params[0] : params;
  if (p && p.player) p = p.player;
  return p && p.name ? p : null;
}
rpc.on('connected', () => { mc.log('Connected to Minecraft management API (live players & game rules).', 'dash'); refreshPlayersFromRpc(); broadcast('state', snapshot()); });
rpc.on('disconnected', () => broadcast('state', snapshot()));
rpc.on('notification', (method, params) => {
  // Apply join/leave directly. (Re-fetching the list here raced with the server and wiped players.)
  const p = notifPlayer(params);
  if (!p) return;
  if (/players\/joined$/.test(method)) mc.addPlayer(p.name, p.id);
  else if (/players\/left$/.test(method)) mc.removePlayer(p.name);
});

// Server List Ping: the same status check the multiplayer menu uses. It is the source of truth
// for "how many are online" and also detects a server started outside Blockhost (e.g. old run.bat).
let external = null;
async function pingCheck() {
  const port = mc.isRunning() && mc.listenPort ? mc.listenPort : publicPort();
  let r = null;
  try { r = await ping(port); } catch { /* not reachable */ }
  if (mc.isRunning()) {
    if (external) { external = null; broadcast('state', snapshot()); }
    if (r && mc.state === 'online' && mc.reconcile(r)) mc.log(`Player list re-synced from server status: ${r.online} online.`, 'dash');
  } else {
    const was = JSON.stringify(external);
    external = r ? { online: r.online, max: r.max, players: r.sample, version: r.version } : null;
    if (JSON.stringify(external) !== was) broadcast('state', snapshot());
  }
}
// Poll fast only when it matters: server running (5 s) or someone has the dashboard open (15 s), else 60 s.
let lastPing = 0;
setInterval(() => {
  const every = mc.isRunning() ? 5000 : clients.size ? 15000 : 60000;
  if (Date.now() - lastPing < every - 100) return;
  lastPing = Date.now();
  pingCheck().catch(() => {});
}, 5000);

function onStateChange(state) {
  if (state === 'online') measureWorld().catch(() => {});
  if (state === 'online' && config.useManagementApi) {
    const p = serverProps();
    if (p['management-server-enabled'] === 'true' && p['management-server-secret']) rpc.connect(Number(p['management-server-port']) || config.rpcPort, p['management-server-secret']);
  }
  if (state === 'offline' || state === 'crashed') rpc.disconnect();
}

// ------------------------------------------------------------------ periodic jobs
let lastAutoBackup = Date.now();
// Resource use: stats/playit checks spawn small system tools, so they only run while a dashboard tab is open.
setInterval(async () => {
  if (!clients.size) { sys.stats(null).catch(() => {}); return; } // keep CPU baseline warm, no process spawn
  lastStats = await sys.stats(mc.proc && mc.proc.pid);
  lastStats.t = Date.now();
  statsHistory.push({ t: lastStats.t, cpu: lastStats.cpu, mem: lastStats.serverMem, players: mc.players.size });
  if (statsHistory.length > 120) statsHistory.shift();
  broadcast('stats', lastStats);
}, 4000);

setInterval(async () => {
  if (!clients.size && !config.autoStartPlayit) return;
  playit.path = sys.findPlayit(config.playitPath, SERVER_DIR, DASH_DIR);
  const running = await sys.playitRunning();
  if (running !== playit.running) { playit.running = running; broadcast('state', snapshot()); }
}, 10000);

async function measureWorld() {
  const lvl = serverProps()['level-name'] || 'world';
  let total = 0;
  for (const f of [lvl, `${lvl}_nether`, `${lvl}_the_end`]) total += await U.dirSize(path.join(SERVER_DIR, f));
  worldSize = total;
}
measureWorld();
setInterval(() => { if (clients.size) measureWorld().catch(() => {}); }, 5 * 60000);

setInterval(() => {
  const mins = Number(config.autoBackupMinutes) || 0;
  if (!mins || mc.state !== 'online' || (task && !task.done)) return;
  if (Date.now() - lastAutoBackup < mins * 60000) return;
  lastAutoBackup = Date.now();
  try { runTask('Auto backup', p => backups.create('scheduled', 'auto', m => p(m))); } catch { /* busy */ }
}, 30000);

// ------------------------------------------------------------------ snapshot
function snapshot() {
  const info = mc.jarInfo();
  const p = serverProps();
  return {
    ...mc.status(),
    external,
    myName: config.myName || '',
    installedVersion: info ? info.id : null,
    javaNeeded: info ? info.java : null,
    latestRelease,
    rpc: rpc.connected,
    task,
    address: config.serverAddress,
    port: p['server-port'] || '25565',
    motd: p.motd || 'A Minecraft Server',
    maxPlayers: Number(p['max-players']) || 20,
    onlineMode: p['online-mode'] !== 'false',
    whitelist: p['white-list'] === 'true',
    difficulty: p.difficulty || 'easy',
    gamemode: p.gamemode || 'survival',
    levelName: p['level-name'] || 'world',
    eula: eulaAccepted(),
    hasJar: fs.existsSync(mc.jarPath),
    needsSetup: !fs.existsSync(mc.jarPath) && !config.setupDone,
    serverPack: packs.serverPack(),
    playit,
    worldSize,
    serverDir: SERVER_DIR,
    stats: lastStats,
  };
}

function eulaAccepted() {
  try { return /^\s*eula\s*=\s*true/m.test(fs.readFileSync(path.join(SERVER_DIR, 'eula.txt'), 'utf8')); } catch { return false; }
}

// ------------------------------------------------------------------ player lists (ops/whitelist/bans)
const LIST_FILES = { ops: 'ops.json', whitelist: 'whitelist.json', bans: 'banned-players.json', ipbans: 'banned-ips.json' };
function readLists() {
  const out = {};
  for (const [k, f] of Object.entries(LIST_FILES)) out[k] = U.readJSONFile(path.join(SERVER_DIR, f), []);
  out.known = U.readJSONFile(path.join(SERVER_DIR, 'usercache.json'), []);
  return out;
}

async function uuidFor(name) {
  if (serverProps()['online-mode'] === 'false') return U.offlineUUID(name);
  const r = await U.fetchJSON(`https://api.mojang.com/users/profiles/minecraft/${encodeURIComponent(name)}`);
  const h = r.id;
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

function mcDate(d = new Date()) {
  const p = n => String(Math.abs(n)).padStart(2, '0');
  const off = -d.getTimezoneOffset();
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())} ${off >= 0 ? '+' : '-'}${p(Math.floor(Math.abs(off) / 60))}${p(Math.abs(off) % 60)}`;
}

/** Apply a list change: uses console commands when online, edits the JSON files when offline. */
async function listAction(list, action, name, reason) {
  name = String(name || '').trim();
  if (!name) throw new Error('Name required');
  if (!/^[\w.\-<>:]{1,40}$/.test(name)) throw new Error('Invalid name/IP');
  const file = path.join(SERVER_DIR, LIST_FILES[list]);
  const keyField = list === 'ipbans' ? 'ip' : 'name';
  const inFile = () => U.readJSONFile(file, []).some(e => String(e[keyField]).toLowerCase() === name.toLowerCase());
  if (mc.isRunning() && mc.state === 'online') {
    // 1) management API (works by UUID, so it also removes names the console can't resolve, e.g. "<nilansh>"
    //    or players whose name cache expired), 2) console command, 3) last resort: edit the file.
    const entry = U.readJSONFile(file, []).find(e => String(e[keyField]).toLowerCase() === name.toLowerCase());
    const rpcNs = { ops: 'operators', whitelist: 'allowlist', bans: 'bans', ipbans: 'ip_bans' }[list];
    if (rpc.connected && action === 'remove' && entry) {
      const arg = list === 'ipbans' ? entry.ip : (entry.uuid ? { id: entry.uuid, name: entry.name } : { name: entry.name });
      try { await rpcCall([`minecraft:${rpcNs}/remove`], [[arg]]); await U.sleep(300); if (!inFile()) return; } catch { /* fall through */ }
    }
    const cmds = {
      ops: { add: `op ${name}`, remove: `deop ${name}` },
      whitelist: { add: `whitelist add ${name}`, remove: `whitelist remove ${name}` },
      bans: { add: `ban ${name}${reason ? ' ' + reason : ''}`, remove: `pardon ${name}` },
      ipbans: { add: `ban-ip ${name}${reason ? ' ' + reason : ''}`, remove: `pardon-ip ${name}` },
    };
    if (/^[\w.\-:]+$/.test(name)) { mc.send(cmds[list][action]); await U.sleep(800); }
    if (action === 'remove' ? !inFile() : inFile()) return;
    if (action === 'add') throw new Error(`The server didn't accept "${name}" - check the spelling (console shows the reason).`);
    // still listed: remove from the file directly; the running server picks it up on next restart
    U.writeJSONFile(file, U.readJSONFile(file, []).filter(e => String(e[keyField]).toLowerCase() !== name.toLowerCase()));
    mc.log(`Removed ${name} from ${LIST_FILES[list]} directly - takes full effect after the next restart.`, 'warn');
    return;
  }
  let data = U.readJSONFile(file, []);
  if (action === 'remove') {
    data = data.filter(e => String(e[keyField]).toLowerCase() !== name.toLowerCase());
  } else {
    if (data.some(e => String(e[keyField]).toLowerCase() === name.toLowerCase())) return;
    if (list === 'ipbans') data.push({ ip: name, created: mcDate(), source: 'Blockhost', expires: 'forever', reason: reason || 'Banned by an operator.' });
    else {
      const uuid = await uuidFor(name);
      if (list === 'ops') data.push({ uuid, name, level: 4, bypassesPlayerLimit: false });
      if (list === 'whitelist') data.push({ uuid, name });
      if (list === 'bans') data.push({ uuid, name, created: mcDate(), source: 'Blockhost', expires: 'forever', reason: reason || 'Banned by an operator.' });
    }
  }
  U.writeJSONFile(file, data);
}

// ------------------------------------------------------------------ game rules
// Fallback list (1.21.11+ names) used when the management API is not available.
const FALLBACK_RULES = [
  ['keep_inventory', 'boolean'], ['advance_time', 'boolean'], ['advance_weather', 'boolean'], ['spawn_mobs', 'boolean'],
  ['mob_griefing', 'boolean'], ['pvp', 'boolean'], ['natural_health_regeneration', 'boolean'], ['immediate_respawn', 'boolean'],
  ['show_death_messages', 'boolean'], ['show_advancement_messages', 'boolean'], ['fall_damage', 'boolean'], ['fire_damage', 'boolean'],
  ['drowning_damage', 'boolean'], ['freeze_damage', 'boolean'], ['spawn_phantoms', 'boolean'], ['spawn_patrols', 'boolean'],
  ['spawn_wandering_traders', 'boolean'], ['spawn_wardens', 'boolean'], ['raids', 'boolean'], ['block_drops', 'boolean'],
  ['mob_drops', 'boolean'], ['entity_drops', 'boolean'], ['tnt_explodes', 'boolean'], ['command_block_output', 'boolean'],
  ['send_command_feedback', 'boolean'], ['reduced_debug_info', 'boolean'], ['locator_bar', 'boolean'], ['limited_crafting', 'boolean'],
  ['random_tick_speed', 'integer'], ['players_sleeping_percentage', 'integer'], ['respawn_radius', 'integer'], ['max_entity_cramming', 'integer'],
].map(([key, type]) => ({ key: 'minecraft:' + key, type, value: null }));

async function getGamerules() {
  if (rpc.connected) {
    try {
      const r = await rpcCall(['minecraft:gamerules', 'minecraft:gamerules/']);
      const list = asArray(r, 'gamerules');
      if (list.length) return { source: 'live', rules: list };
    } catch { /* fallback */ }
  }
  return { source: 'fallback', rules: FALLBACK_RULES };
}

// ------------------------------------------------------------------ HTTP helpers
const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json', '.woff2': 'font/woff2' };

function serveStatic(req, res, urlPath) {
  let rel = decodeURIComponent(urlPath);
  if (rel === '/' || !path.extname(rel)) rel = '/index.html';
  let file;
  try { file = U.safeJoin(PUBLIC_DIR, rel); } catch { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(data);
  });
}

function sendFile(res, file, downloadName) {
  const st = fs.statSync(file);
  res.writeHead(200, {
    'Content-Type': 'application/octet-stream',
    'Content-Length': st.size,
    'Content-Disposition': `attachment; filename="${(downloadName || path.basename(file)).replace(/"/g, '')}"`,
  });
  fs.createReadStream(file).pipe(res);
}

async function receiveFile(req, dest) {
  await fsp.mkdir(path.dirname(dest), { recursive: true });
  await pipeline(req, fs.createWriteStream(dest));
}

function requireOffline() { if (mc.isRunning()) throw new Error('Stop the server first.'); }

async function findLevelDir(root, depth = 0) {
  if (fs.existsSync(path.join(root, 'level.dat'))) return root;
  if (depth > 3) return null;
  for (const e of await fsp.readdir(root, { withFileTypes: true })) {
    if (e.isDirectory()) { const f = await findLevelDir(path.join(root, e.name), depth + 1); if (f) return f; }
  }
  return null;
}


// ------------------------------------------------------------------ servers started outside Blockhost
function portInUse(port) {
  return new Promise(resolve => {
    const s = require('net').createConnection({ host: '127.0.0.1', port });
    const done = v => { s.destroy(); resolve(v); };
    s.setTimeout(800, () => done(false));
    s.on('connect', () => done(true));
    s.on('error', () => done(false));
  });
}

/** Stop a Minecraft server that Blockhost didn't start: politely via the management API, else end its process. */
async function stopExternal(port) {
  const p = serverProps();
  if (p['management-server-enabled'] === 'true' && p['management-server-secret']) {
    const { WsClient } = require('./lib/wsclient');
    const ok = await new Promise(resolve => {
      const ws = new WsClient('127.0.0.1', Number(p['management-server-port']) || config.rpcPort, { Authorization: `Bearer ${p['management-server-secret']}` });
      const t = setTimeout(() => { ws.close(); resolve(false); }, 5000);
      ws.on('open', () => ws.send(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'minecraft:server/stop' })));
      ws.on('message', m => { try { const r = JSON.parse(m); if (r.id === 1) { clearTimeout(t); ws.close(); resolve(!r.error); } } catch { /* ignore */ } });
      ws.on('error', () => { clearTimeout(t); resolve(false); });
    });
    if (ok) { mc.log('Asked the other server to stop (saves the world first).', 'dash'); return 'api'; }
  }
  if (U.IS_WIN) {
    const r = await U.run('netstat', ['-ano', '-p', 'TCP']);
    const line = r.stdout.split(/\r?\n/).find(l => new RegExp(`:${port}\\s+\\S+\\s+LISTENING`, 'i').test(l));
    const pid = line && line.trim().split(/\s+/).pop();
    if (pid && /^\d+$/.test(pid) && Number(pid) !== process.pid) {
      const t = await U.run('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH']);
      if (!/java/i.test(t.stdout)) throw new Error(`Port ${port} is used by a non-Java program (PID ${pid}) - not touching it.`);
      mc.log(`Ending the other server process (PID ${pid}).`, 'warn');
      await U.run('taskkill', ['/PID', pid, '/T', '/F']);
      return 'kill';
    }
  }
  throw new Error('Could not stop the other server automatically. Type "stop" in its window.');
}

// ------------------------------------------------------------------ Live Sync transports self-test + push to everyone
async function testTransports() {
  sync._urlAt = 0;
  const ep = await sync.endpoints();
  const out = { mc: ep.mc, results: [] };
  const add = (name, ok, detail, who) => out.results.push({ name, ok, detail, who });
  if (!config.syncEnabled) throw new Error('Turn Live Sync on first.');
  if (sync.status().restartNeeded) throw new Error('Restart the Minecraft server once to finish switching Live Sync on (Overview > Restart).');
  // all routes are checked at the same time
  const jobs = [];
  if (fast.url) jobs.push(fetch(fast.url + '/', { signal: AbortSignal.timeout(8000) }).then(async r => add('Fast lane (Cloudflare)', /Blockhost Live Sync/.test(await r.text()), fast.url, 'helpers + server texture pack'))
    .catch(e => add('Fast lane (Cloudflare)', false, e.cause ? e.cause.code || e.cause.message : e.message)));
  else add('Fast lane (Cloudflare)', false, config.fastLane ? (fast.error || 'starting...') : 'off', 'helpers + server texture pack');
  if (ep.mc) {
    jobs.push(mcclient.wrappedHttp(ep.mc.host, ep.mc.port, '/', { timeout: 6000 }).then(r => add('Minecraft-wrapped (playit)', /Blockhost Live Sync/.test(r.body.toString()), `${ep.mc.host}:${ep.mc.port}`, 'helpers'))
      .catch(e => add('Minecraft-wrapped (playit)', false, e.message === 'timeout' ? 'blocked by the tunnel (timeout)' : e.message)));
    jobs.push(mcclient.framedGet(ep.mc.host, ep.mc.port, 0).then(b => add('Server-list packets (playit)', b.length > 0, `${Math.round(b.length / 1024)} KB manifest`, 'helpers (slowest, always works)'))
      .catch(e => add('Server-list packets (playit)', false, e.message)));
  } else if (!fast.url) add('Minecraft tunnel', false, sync.urlNote || 'no address');
  if (config.syncShared === false && ep.syncUrl) jobs.push(fetch(ep.syncUrl + '/', { signal: AbortSignal.timeout(8000) }).then(async r => add('Separate TCP tunnel', /Blockhost Live Sync/.test(await r.text()), ep.syncUrl, 'helpers'))
    .catch(e => add('Separate TCP tunnel', false, e.cause ? e.cause.code || e.cause.message : e.message)));
  await Promise.all(jobs);
  const order = ['Fast lane (Cloudflare)', 'Minecraft-wrapped (playit)', 'Server-list packets (playit)', 'Separate TCP tunnel', 'Minecraft tunnel'];
  out.results.sort((x, y) => order.indexOf(x.name) - order.indexOf(y.name));
  out.ok = out.results.some(r => r.ok);
  out.summary = out.ok ? `Friends can sync via: ${out.results.filter(r => r.ok).map(r => r.name).join(', ')}` : 'No route works yet - is playit.gg running and is your server address right?';
  return out;
}

async function pushAll(body, p) {
  const mode = ['next', 'ask', 'now'].includes(body.mode) ? body.mode : 'next';
  const res = [];
  const step = async (name, fn) => { try { const r = await fn(); res.push({ name, ok: r.ok !== false, skipped: !!r.skipped, detail: r.detail || '' }); } catch (e) { res.push({ name, ok: false, detail: e.message }); } };
  p('1/4 Data packs...', 10);
  await step('Data packs (server)', async () => {
    const n = packs.listDatapacks().filter(d => !d.pending).length;
    if (mc.state === 'online') { mc.send('reload'); return { detail: `${n} data pack(s) reloaded - active for everyone now` }; }
    return { detail: `${n} data pack(s) - active when the server starts` };
  });
  p('2/4 Server texture pack...', 30);
  await step('Server texture pack (everyone, no install)', () => applyServerPack(m => p(m)));
  p('3/4 Live Sync (shaders, mods, fixes)...', 60);
  await step('Live Sync helpers (shaders, mods, settings, auto-fixes)', async () => {
    if (!config.syncEnabled) return { ok: false, detail: 'Live Sync is off - switch it on (Live Sync page).' };
    await sync.push(mode, body.message);
    const t = await testTransports().catch(e => ({ ok: false, summary: e.message }));
    const n = sync.status().clients.length;
    return { ok: t.ok, detail: `${t.summary}. ${n} friend PC(s) known.` };
  });
  p('4/4 Telling players...', 90);
  await step('Chat message', async () => {
    if (mc.state !== 'online') return { skipped: true, detail: 'server offline' };
    const extra = mode === 'now' ? ' Your game restarts in 60 s to install it.' : mode === 'ask' ? ' You will be asked to restart.' : ' It installs when you close Minecraft.';
    const sp = res.find(r => r.name.startsWith('Server texture pack'));
    const text = `[Update] New packs/mods from the host${body.message ? ': ' + String(body.message).slice(0, 120) : ''}.${extra}${sp && /restart/.test(sp.detail) ? ' New textures after the next restart.' : ''}`;
    mc.send(`tellraw @a ${JSON.stringify({ text, color: 'light_purple' })}`);
    return { detail: 'sent' };
  });
  const last = { at: new Date().toISOString(), mode, results: res };
  saveConfig({ lastPush: last });
  p(res.every(r => r.ok) ? 'Pushed everywhere.' : 'Pushed - some routes need attention.', 100);
  return last;
}

// ------------------------------------------------------------------ routes
const routes = {
  'GET /api/state': () => snapshot(),
  'GET /api/console': () => ({ lines: mc.lines.slice(-1000) }),
  'GET /api/stats/history': () => ({ history: statsHistory }),

  'POST /api/start': async () => {
    if (!mc.isRunning()) {
      const port = sharedActive() && front.listening() ? internalPort() : publicPort();
      if (await portInUse(port)) {
        let who = null; try { who = await ping(port); } catch { /* not minecraft */ }
        return { ok: false, code: 'PORT_BUSY', port, minecraft: !!who, players: who ? who.online : 0,
          error: who ? `Another Minecraft server is already running on port ${port} (probably the old run.bat window).` : `Port ${port} is used by another program.` };
      }
    }
    try { await mc.start(); }
    catch (e) { if (e.code) return { ok: false, code: e.code, need: e.need, error: e.message }; throw e; }
    return { ok: true };
  },
  'POST /api/stop': () => { mc.stop(); return { ok: true }; },
  'POST /api/external/stop': async () => {
    const port = Number(serverProps()['server-port']) || 25565;
    const how = await stopExternal(port);
    for (let i = 0; i < 60 && await portInUse(port); i++) await U.sleep(500);
    external = null; broadcast('state', snapshot());
    if (await portInUse(port)) throw new Error('The other server is still running. Close its window manually (type stop in it).');
    return { ok: true, how };
  },
  'POST /api/restart': () => { mc.restart(); return { ok: true }; },
  'POST /api/kill': () => { mc.kill(); return { ok: true }; },
  'POST /api/command': ({ body }) => { mc.send(body.command); return { ok: true }; },
  'POST /api/eula': () => {
    fs.writeFileSync(path.join(SERVER_DIR, 'eula.txt'), `#Accepted via Blockhost dashboard (https://aka.ms/MinecraftEULA)\n#${new Date().toString()}\neula=true\n`);
    return { ok: true };
  },

  // server.properties
  'GET /api/properties': () => ({ properties: serverProps() }),
  'POST /api/properties': ({ body }) => {
    const changes = body.changes || {};
    for (const k of Object.keys(changes)) if (!/^[\w.\-]+$/.test(k)) throw new Error('Bad key ' + k);
    props.setMany(path.join(SERVER_DIR, 'server.properties'), changes);
    broadcast('state', snapshot());
    return { ok: true, restartNeeded: mc.isRunning() };
  },

  // players & lists
  'GET /api/lists': () => readLists(),
  'POST /api/lists': async ({ body }) => { if (!LIST_FILES[body.list]) throw new Error('Bad list'); await listAction(body.list, body.action, body.name, body.reason); return readLists(); },

  'GET /api/players/inspect': ({ query }) => mc.inspect(String(query.get('name') || '')),

  // game rules
  'GET /api/gamerules': () => getGamerules(),
  'POST /api/gamerules': async ({ body }) => {
    const key = String(body.key || ''); const value = body.value;
    if (!/^[\w:.\-]+$/.test(key)) throw new Error('Bad rule');
    if (rpc.connected) {
      try { await rpcCall(['minecraft:gamerules/update'], [{ key, value }]); return { ok: true, via: 'api' }; } catch { /* use command */ }
    }
    mc.send(`gamerule ${key.replace(/^minecraft:/, '')} ${value}`);
    return { ok: true, via: 'command' };
  },

  // software / versions
  'GET /api/versions': async ({ query }) => updater.versions(query.get('snapshots') === '1'),
  'POST /api/install': ({ body }) => runTask(`Install ${body.version}`, p => updater.install(body.version, { force: !!body.force, reinstall: !!body.reinstall }, p)),
  'GET /api/java': () => { const info = mc.jarInfo(); const need = (info && info.java) || 21; const r = findJava(need, config.javaPath); return { need, ...r }; },
  'POST /api/java/install': ({ body }) => runTask(`Install Java ${body.need}`, async p => { const r = await installJava(Number(body.need) || 25, l => p(l.trim().slice(0, 120))); if (!r.ok) throw new Error(r.message); return r; }),

  // backups
  'GET /api/backups': () => ({ backups: backups.list(), keep: config.backupsToKeep }),
  'POST /api/backups': ({ body }) => runTask('Backup', p => backups.create(body.label || 'manual', 'manual', m => p(m))),
  'POST /api/backups/restore': ({ body }) => runTask('Restore backup', p => { requireOffline(); return backups.restore(body.name, m => p(m), !!body.includeConfig); }),
  'DELETE /api/backups': ({ query }) => { backups.delete(query.get('name')); return { ok: true }; },

  // world
  'POST /api/world/reset': ({ body }) => runTask('Reset world', async p => {
    requireOffline();
    p('Backing up current world...');
    await backups.create('before-reset', 'manual', m => p(m));
    await backups.removeWorlds();
    const ch = { 'level-seed': String(body.seed || '') };
    if (body.levelType) ch['level-type'] = body.levelType;
    props.setMany(path.join(SERVER_DIR, 'server.properties'), ch);
    p('World deleted. A new one is generated on next start.');
  }),

  // files
  'GET /api/files': ({ query }) => {
    const dir = U.safeJoin(SERVER_DIR, query.get('path'));
    const entries = fs.readdirSync(dir, { withFileTypes: true }).map(e => {
      let st = null; try { st = fs.statSync(path.join(dir, e.name)); } catch { /* ignore */ }
      return { name: e.name, dir: e.isDirectory(), size: st ? st.size : 0, mtime: st ? st.mtimeMs : 0 };
    }).sort((a, b) => (b.dir - a.dir) || a.name.localeCompare(b.name));
    return { path: path.relative(SERVER_DIR, dir).split(path.sep).join('/'), entries };
  },
  'GET /api/files/read': ({ query }) => {
    const f = U.safeJoin(SERVER_DIR, query.get('path'));
    const st = fs.statSync(f);
    if (st.size > 2 * 1024 * 1024) throw new Error('File too large to edit here (max 2 MB). Download it instead.');
    const buf = fs.readFileSync(f);
    if (buf.includes(0)) throw new Error('Binary file - download it instead.');
    return { content: buf.toString('utf8') };
  },
  'POST /api/files/write': ({ body }) => { fs.writeFileSync(U.safeJoin(SERVER_DIR, body.path), String(body.content ?? '')); return { ok: true }; },
  'POST /api/files/mkdir': ({ body }) => { fs.mkdirSync(U.safeJoin(SERVER_DIR, body.path), { recursive: true }); return { ok: true }; },
  'DELETE /api/files': async ({ query }) => {
    const f = U.safeJoin(SERVER_DIR, query.get('path'));
    if (f === path.resolve(SERVER_DIR) || f === path.resolve(DASH_DIR) || f.startsWith(path.resolve(DASH_DIR) + path.sep)) throw new Error('Refusing to delete this folder.');
    await fsp.rm(f, { recursive: true, force: true });
    return { ok: true };
  },

  // logs
  'GET /api/logs': () => {
    const dir = path.join(SERVER_DIR, 'logs');
    let files = []; try { files = fs.readdirSync(dir).filter(f => /\.(log|log\.gz)$/.test(f)); } catch { /* none */ }
    return { logs: files.map(f => ({ name: f, size: fs.statSync(path.join(dir, f)).size, mtime: fs.statSync(path.join(dir, f)).mtimeMs })).sort((a, b) => b.mtime - a.mtime) };
  },
  'GET /api/logs/read': ({ query }) => {
    const name = query.get('name');
    if (!/^[\w.\-]+$/.test(name)) throw new Error('Bad name');
    const f = path.join(SERVER_DIR, 'logs', name);
    let buf = fs.readFileSync(f);
    if (name.endsWith('.gz')) buf = require('zlib').gunzipSync(buf);
    const text = buf.toString('utf8');
    return { content: text.length > 1500000 ? text.slice(-1500000) : text };
  },

  // settings
  'GET /api/config': () => ({ config }),
  'POST /api/config': ({ body }) => {
    const next = { ...config };
    for (const k of Object.keys(DEFAULT_CONFIG)) if (k in (body.config || {})) next[k] = body.config[k];
    if (!/^\d+[MG]$/i.test(next.minRam) || !/^\d+[MG]$/i.test(next.maxRam)) throw new Error('RAM must look like 2G or 2048M');
    next.curseforgeKey = require('./lib/curseforge').cleanKey(next.curseforgeKey);
    config = next; U.writeJSONFile(CONFIG_FILE, config);
    sync._urlAt = 0; sync.invalidate();      // server address may have changed
    broadcast('state', snapshot());
    return { config };
  },

  // packs (Modrinth)
  'GET /api/packs/search': ({ query }) => packs.search(query.get('type'), query.get('q'), query.get('any') === '1' ? null : (query.get('version') || packs.gameVersion()), query.get('offset'), query.get('source') || 'modrinth'),
  'POST /api/packs/lookup': ({ body }) => require('./lib/importer').lookup(String(body.input || '').slice(0, 500), packs.gameVersion(), packs),
  'POST /api/packs/import': ({ body }) => require('./lib/importer').resolve(String(body.text || '').slice(0, 20000), packs.gameVersion(), packs),
  'GET /api/packs/state': () => ({ gameVersion: packs.gameVersion(), serverPack: packs.serverPack(), datapacks: packs.listDatapacks(), kit: packs.listKit() }),
  'POST /api/packs/server-pack': async ({ body }) => {
    let src = { url: body.url, sha1: body.sha1, name: body.name };
    if (body.id) { const f = await packs.bestFile('resourcepack', body.id, packs.gameVersion(), !!body.any); src = { url: f.url, sha1: f.sha1, name: body.name || f.filename }; }
    return runTask('Set server texture pack', p => packs.setServerPack({ ...src, require: !!body.require, prompt: body.prompt }, p).then(r => { broadcast('state', snapshot()); return r; }));
  },
  'DELETE /api/packs/server-pack': () => { packs.clearServerPack(); broadcast('state', snapshot()); return { ok: true, restartNeeded: mc.isRunning() }; },
  'POST /api/packs/datapack': ({ body }) => runTask('Install data pack', p => packs.installDatapack(body.id, !!body.any, p)),
  'DELETE /api/packs/datapack': ({ query }) => packs.removeDatapack(query.get('name')),
  'POST /api/packs/kit': ({ body }) => runTask('Add to player kit', p => packs.addToKit(['resourcepack', 'mod'].includes(body.type) ? body.type : 'shader', body.id, !!body.any, p, null, !!body.force)),
  'GET /api/packs/kit/check': () => packs.kitCheck(),
  'DELETE /api/packs/kit': async ({ query }) => { await packs.removeFromKit(query.get('folder'), query.get('name')); return { ok: true }; },

  // one-click setup wizard
  'POST /api/setup': ({ body }) => runTask('Create server', async p => {
    if (!body.eula) throw new Error('You need to accept the Minecraft EULA.');
    if (mc.isRunning()) { p('Stopping the running server...', 2); await mc.stop(); }
    fs.writeFileSync(path.join(SERVER_DIR, 'eula.txt'), `#Accepted via Blockhost setup (https://aka.ms/MinecraftEULA)\n#${new Date().toString()}\neula=true\n`);
    const allowed = ['motd', 'online-mode', 'enforce-secure-profile', 'gamemode', 'difficulty', 'max-players', 'level-seed', 'level-type', 'hardcore', 'white-list', 'pvp', 'server-port', 'view-distance'];
    const ch = {};
    for (const k of allowed) if (body.properties && body.properties[k] !== undefined) ch[k] = String(body.properties[k]);
    props.setMany(path.join(SERVER_DIR, 'server.properties'), ch);
    const cfgPatch = {};
    if (body.ram && /^\d+G$/.test(body.ram)) { cfgPatch.maxRam = body.ram; cfgPatch.minRam = body.ram; }
    if (typeof body.address === 'string') cfgPatch.serverAddress = body.address.trim();
    saveConfig(cfgPatch);
    const cur = mc.jarInfo();
    const m = await updater.manifest(true);
    const target = !body.version || body.version === 'latest' ? m.latest.release : body.version;
    if (!cur || cur.id !== target) await updater.install(target, { force: true }, (msg, pct) => p(msg, pct == null ? null : Math.round(pct * 0.9)));
    else p(`Minecraft ${target} is already installed.`, 90);
    if (body.shortcut && U.IS_WIN) { try { await createDesktopShortcut(path.join(DASH_DIR, '..', 'Start Dashboard.bat')); p('Desktop shortcut created.', 94); } catch (e) { p('Shortcut skipped: ' + e.message); } }
    if (body.startNow !== false) { p('Starting the server for the first time (the world is generated now)...', 96); await mc.start(); }
    saveConfig({ setupDone: true });
    p('Your server is ready!', 100);
    broadcast('state', snapshot());
  }),
  'POST /api/shortcut': async () => ({ ok: true, path: await createDesktopShortcut(path.join(DASH_DIR, '..', 'Start Dashboard.bat')) }),

  'GET /api/packs/installer/check': async () => {
    const version = packs.gameVersion();
    const kit = (await packs.migrateKit()).filter(e => e.url);
    let iris = null, sodium = null, loader = null;
    if (version) {
      try { [iris, sodium] = await Promise.all([packs.modFile('iris', version), packs.modFile('sodium', version)]); } catch { /* offline */ }
      try { const l = await U.fetchJSON(`${FABRIC_META}/v2/versions/loader/${encodeURIComponent(version)}`); loader = l.length ? l[0].loader.version : null; } catch { /* none */ }
    }
    return { version, shaders: kit.filter(e => e.folder === 'shaderpacks').length, resourcepacks: kit.filter(e => e.folder === 'resourcepacks').length, iris: !!iris, sodium: !!sodium, fabric: loader, legacy: packs.listKit().length - kit.length };
  },
  'GET /api/client/doctor': () => doctor.diagnose(packs.gameVersion()),
  'POST /api/client/doctor/disable': ({ body }) => doctor.disableMods((body.ids || []).map(String).filter(x => /^[a-z0-9_.\-]+$/.test(x)).slice(0, 10)),

  'POST /api/curseforge/test': ({ body }) => require('./lib/curseforge').test(body.key != null ? body.key : config.curseforgeKey),
  // Live Sync
  'GET /api/sync/status': async () => { await sync.url(); return sync.status(); },
  'POST /api/sync/settings': async ({ body }) => {
    const patch = {};
    if ('enabled' in body) patch.syncEnabled = !!body.enabled;
    if ('port' in body) { const p = Number(body.port); if (!(p >= 1024 && p <= 65535) || p === config.port) throw new Error('Pick a port between 1024 and 65535 (not the dashboard port).'); patch.syncPort = p; }
    if ('address' in body) {
      const a = String(body.address || '').trim().replace(/^https?:\/\//, '').replace(/\/+$/, '');
      if (a && !/^[\w.\-]+(:\d{1,5})?$/.test(a)) throw new Error('Address should look like name.ply.gg:12345');
      patch.syncAddress = a;
    }
    if ('defaultMode' in body) { if (!['next', 'ask', 'now'].includes(body.defaultMode)) throw new Error('Bad mode'); patch.syncDefaultMode = body.defaultMode; }
    if ('iris' in body) patch.syncIris = !!body.iris;
    if ('shared' in body) patch.syncShared = !!body.shared;
    if ('publicAddress' in body) {
      const a = String(body.publicAddress || '').trim().replace(/^\w+:\/\//, '').replace(/\/+$/, '');
      if (a && !/^[\w.\-]+:\d{1,5}$/.test(a)) throw new Error('Use host:port, like 147.185.221.225:64902');
      patch.syncPublicAddress = a;
    }
    if ('internalPort' in body) { const p = Number(body.internalPort); if (!(p >= 1024 && p <= 65535) || p === publicPort()) throw new Error('Pick a free port between 1024 and 65535 that is not the server port.'); patch.mcInternalPort = p; }
    saveConfig(patch);
    sync.invalidate(); sync._urlAt = 0;
    if ('enabled' in body || 'port' in body) sync.start();
    await applyFront();
    await sync.url();
    return sync.status();
  },
  'POST /api/sync/push': async ({ body }) => {
    if (!config.syncEnabled) throw new Error('Turn Live Sync on first.');
    const pol = await sync.push(body.mode || 'next', body.message);
    if (mc.state === 'online') {
      const extra = pol.mode === 'now' ? ' Your game restarts in 60 s to install it.' : pol.mode === 'ask' ? ' You will be asked to restart.' : ' It installs when you close Minecraft.';
      const text = `[Update] New packs/mods from the host${pol.message ? ': ' + pol.message : ''}.${extra}`;
      try { mc.send(`tellraw @a ${JSON.stringify({ text, color: 'light_purple' })}`); } catch { /* offline */ }
    }
    return sync.status();
  },
  'POST /api/sync/test': () => testTransports(),
  'POST /api/fastlane': ({ body }) => {
    saveConfig({ fastLane: !!body.enabled });
    if (!body.enabled) { fast.stop(); return { ok: true, fast: fast.status() }; }
    return runTask('Fast lane', async p => {
      await fast.install(p);
      p('Starting the Cloudflare quick tunnel...', 95); fast.start();
      const u = await fast.waitUrl(30000);
      if (!u) throw new Error('cloudflared started but no public address yet (' + (fast.error || 'check your internet / firewall') + ').');
      p('Fast lane online: ' + u, 100);
      return { url: u };
    });
  },
  'POST /api/push': ({ body }) => runTask('Push to everyone', p => pushAll(body, p)),
  'GET /api/push/last': () => config.lastPush,
  'POST /api/sync/token/reset': () => {
    saveConfig({ syncToken: '' }); sync.ensureSecrets();
    return { ok: true, note: 'Old Sync files stop working - send friends the new one.' };
  },
  'POST /api/packs/preset': async ({ body }) => {
    // Modrinth project ids (checked 2026-10): Complementary Reimagined, Complementary Unbound, BSL, MakeUp Ultra Fast
    const PRESETS = { complementary: 'HVnmMxH1', unbound: 'R6NEzAwj', bsl: 'Q1vvjJYV', makeup: 'izsIPI7a' };
    const slug = PRESETS[body.id];
    if (!slug) throw new Error('Unknown preset');
    saveConfig({ syncIris: true });
    return runTask('Shaders in one click', async p => {
      p('Adding the shader to the player kit...', 10);
      const r = await packs.addToKit('shader', slug, true, p);
      // make it the selected shader: first shader in the kit is the one switched on for friends
      const man = packs.kitManifest(); const i = man.findIndex(e => e.folder === 'shaderpacks' && e.name === r.file);
      if (i > 0) { const [e] = man.splice(i, 1); man.unshift(e); packs.saveKitManifest(man); }
      sync.invalidate();
      p('Done - friends get Fabric + Iris + Sodium + this shader, switched on.', 100);
    });
  },
  // playit
  'POST /api/playit/install': () => runTask('Install playit.gg', async p => {
    const exe = await installPlayit(DASH_DIR, p);
    if (exe) saveConfig({ playitPath: exe });
    const found = exe || sys.findPlayit(config.playitPath, SERVER_DIR, DASH_DIR);
    playit.path = found;
    if (found) { p('Opening playit.gg in its own window...', 98); sys.startPlayit(found); }
    p('playit.gg installed. Follow the claim link in its window.', 100);
    broadcast('state', snapshot());
    return { path: found };
  }),
  // playit
  'POST /api/playit/start': () => {
    const exe = sys.findPlayit(config.playitPath, SERVER_DIR, DASH_DIR);
    if (!exe) throw new Error('playit.exe not found. Set its path in Settings.');
    sys.startPlayit(exe);
    return { ok: true, path: exe };
  },
};

// Everything a friend's PC needs (shared by the one-time installer and Live Sync).
async function kitData(wantIrisFlag = true) {
  const version = packs.gameVersion();
  if (!version) throw new Error('Install Minecraft on the server first.');
  const kitDir = path.join(DASH_DIR, 'player-kit');
  const kit = (await packs.migrateKit()).filter(e => (e.url || e.local) && fs.existsSync(path.join(kitDir, e.folder, e.name)));
  if (!kit.length) throw new Error('The player kit is empty - add shaders, texture packs or mods first.');
  // CurseForge files need the host's secret API key to download (since July 2026), so friends get those
  // from the host instead (installer zip / Live Sync mirror) - never hand out the key.
  const pub = e => (e.url && !require('./lib/curseforge').isCfUrl(e.url) ? e.url : null);
  const item = e => ({ name: e.name, url: pub(e), sha1: e.sha1, local: !pub(e) });
  const shaders = kit.filter(e => e.folder === 'shaderpacks').map(item);
  const resourcepacks = kit.filter(e => e.folder === 'resourcepacks').map(item);
  const kitMods = kit.filter(e => e.folder === 'mods');
  const wantIris = wantIrisFlag && shaders.length > 0;
  let fabric = null, mods = [], note = '';
  if (wantIris || kitMods.length) {
    try {
      const loaders = await U.fetchJSON(`${FABRIC_META}/v2/versions/loader/${encodeURIComponent(version)}`);
      const pick = (loaders.find(l => l.loader && l.loader.stable) || loaders[0] || {}).loader;
      if (pick) fabric = { loader: pick.version, id: `fabric-loader-${pick.version}-${version}`, profileUrl: `${FABRIC_META}/v2/versions/loader/${encodeURIComponent(version)}/${encodeURIComponent(pick.version)}/profile/json` };
      else note = `Fabric is not available for ${version} yet`;
    } catch (e) { note = 'Could not look up Fabric: ' + e.message; }
    if (fabric && wantIris) {
      const [iris, sodium] = await Promise.all([packs.modFile('iris', version), packs.modFile('sodium', version)]).catch(() => [null, null]);
      if (iris && sodium) mods.push({ slug: 'iris', ...iris }, { slug: 'sodium', ...sodium });
      else note = `Iris/Sodium are not released for ${version} yet`;
    }
    for (const m of kitMods) {
      if (mods.some(x => x.filename === m.name || (m.slug && x.slug === m.slug))) continue;
      mods.push({ slug: m.slug || null, filename: m.name, url: pub(m), sha1: m.sha1, local: !pub(m), folder: 'mods' });
    }
    if (!fabric) mods = [];
  }
  const name = String(serverProps().motd || '').replace(/\\u00a7./gi, '').replace(/§./g, '').trim() || 'Minecraft Server';
  return { version, kit, shaders, resourcepacks, fabric, mods, note, name };
}

// Streaming routes (raw bodies / file downloads)
const streamRoutes = {
  'GET /api/backups/download': ({ res, query }) => sendFile(res, backups.file(query.get('name'))),
  'GET /api/files/download': ({ res, query }) => sendFile(res, U.safeJoin(SERVER_DIR, query.get('path'))),
  'POST /api/files/upload': async ({ req, res, query }) => {
    const dir = U.safeJoin(SERVER_DIR, query.get('path'));
    const name = path.basename(String(query.get('name') || ''));
    if (!name) throw new Error('Missing file name');
    await receiveFile(req, path.join(dir, name));
    U.sendJSON(res, 200, { ok: true });
  },
  'POST /api/icon': async ({ req, res }) => {
    const buf = await U.readBody(req, 512 * 1024);
    if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error('Icon must be a PNG');
    fs.writeFileSync(path.join(SERVER_DIR, 'server-icon.png'), buf);
    U.sendJSON(res, 200, { ok: true, restartNeeded: mc.isRunning() });
  },
  'GET /api/icon': ({ res }) => {
    const f = path.join(SERVER_DIR, 'server-icon.png');
    if (!fs.existsSync(f)) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'no-cache' });
    fs.createReadStream(f).pipe(res);
  },
  'GET /api/sync/client': async ({ res }) => {
    if (!config.syncEnabled) throw new Error('Turn Live Sync on first.');
    const url = await sync.url();
    if (!url) throw new Error(sync.urlNote || 'Enter the playit address of the sync tunnel first.');
    const name = String(serverProps().motd || '').replace(/\\u00a7./gi, '').replace(/§./g, '').trim() || 'Minecraft Server';
    const ep = await sync.endpoints();
    const bat = buildSyncBat({ serverName: name, urls: ep.urls, mc: ep.mc, mcHost: sync.mcHost(), token: config.syncToken, pub: sync.publicKey, keyId: sync.keyId });
    const base = `Blockhost-Sync-${name.replace(/[^\w\-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 30) || 'server'}`;
    res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Disposition': `attachment; filename="${base}.bat"` });
    res.end(bat);
  },
  'GET /api/packs/kit/download': async ({ res }) => {
    const zip = await packs.buildKit(config.serverAddress);
    res.on('close', () => fs.rm(zip, { force: true }, () => {}));
    sendFile(res, zip, `player-kit-${packs.gameVersion() || 'minecraft'}.zip`);
  },
  'GET /api/packs/installer': async ({ res, query }) => {
    const kitDir = path.join(DASH_DIR, 'player-kit');
    const d = await kitData(query.get('iris') !== '0');
    const { kit, mods, note, name } = d;
    const bat = buildInstaller({ serverName: name, version: d.version, address: config.serverAddress || '', shaders: d.shaders, resourcepacks: d.resourcepacks, fabric: d.fabric, mods });
    const base = `Install-${(name || 'server').replace(/[^\w\-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 30) || 'server'}-packs`;
    // bundle=1 (default): pack every kit file into the zip as a fallback, so it still works if a site is down
    const bundle = query.get('bundle') !== '0';
    const locals = bundle ? kit : kit.filter(e => !e.url || require('./lib/curseforge').isCfUrl(e.url));
    const headers = { 'X-Blockhost-Note': encodeURIComponent(note), 'Access-Control-Expose-Headers': 'X-Blockhost-Note' };
    if (!locals.length) {
      res.writeHead(200, { ...headers, 'Content-Type': 'application/octet-stream', 'Content-Disposition': `attachment; filename="${base}.bat"` });
      return res.end(bat);
    }
    // uploaded files can't be downloaded from the internet by friends, so ship them inside a zip with the .bat
    const tmp = path.join(SERVER_DIR, 'backups', `.installer-${Date.now()}`);
    await fsp.mkdir(tmp, { recursive: true });
    try {
      fs.writeFileSync(path.join(tmp, `${base}.bat`), bat);
      fs.writeFileSync(path.join(tmp, 'READ ME FIRST.txt'), 'Right-click this zip > Extract All, open the extracted folder, then double-click the .bat file.\r\n');
      for (const e of locals) { const dir = path.join(tmp, 'files', e.folder); await fsp.mkdir(dir, { recursive: true }); await fsp.copyFile(path.join(kitDir, e.folder, e.name), path.join(dir, e.name)); }
      if (bundle) {   // also pack Iris/Sodium so shaders work even if Modrinth is unreachable for a friend
        for (const m of mods) {
          const dest = path.join(tmp, 'files', 'mods', m.filename);
          if (fs.existsSync(dest) || !m.url) continue;
          await fsp.mkdir(path.dirname(dest), { recursive: true });
          try { const h = await U.download(m.url, dest); if (m.sha1 && h !== m.sha1) await fsp.rm(dest, { force: true }); } catch { await fsp.rm(dest, { force: true }); }
        }
      }
      const zip = tmp + '.zip';
      await createZip(tmp, fs.readdirSync(tmp), zip);
      res.on('close', () => fs.rm(zip, { force: true }, () => {}));
      res.writeHead(200, { ...headers, 'Content-Type': 'application/zip', 'Content-Length': fs.statSync(zip).size, 'Content-Disposition': `attachment; filename="${base}.zip"` });
      fs.createReadStream(zip).pipe(res);
    } finally { fs.rm(tmp, { recursive: true, force: true }, () => {}); }
  },
  'GET /api/packs/kit/download': async ({ res }) => {
    const zip = await packs.buildKit(config.serverAddress);
    res.on('close', () => fs.rm(zip, { force: true }, () => {}));
    sendFile(res, zip, `player-kit-${packs.gameVersion() || 'minecraft'}.zip`);
  },
  'POST /api/packs/kit/upload': async ({ req, res, query }) => {
    const tmp = path.join(SERVER_DIR, 'backups', `.kit-upload-${Date.now()}`);
    await receiveFile(req, tmp);
    try { const r = await packs.addUploadToKit(String(query.get('folder')), String(query.get('name') || ''), tmp); U.sendJSON(res, 200, { ok: true, ...r }); }
    finally { fs.rm(tmp, { force: true }, () => {}); }
  },
  'GET /api/world/download': async ({ res }) => {
    const items = backups.worldFolders();
    if (!items.length) throw new Error('No world yet');
    if (mc.state === 'online') { mc.send('save-all flush'); await mc.waitFor(/Saved the game|Saved the world/i, 30000); }
    const tmp = path.join(SERVER_DIR, 'backups', `.world-download-${Date.now()}.zip`);
    fs.mkdirSync(path.dirname(tmp), { recursive: true });
    await createZip(SERVER_DIR, items, tmp);
    res.on('close', () => fs.rm(tmp, { force: true }, () => {}));
    sendFile(res, tmp, `${backups.levelName()}-${U.stamp()}.zip`);
  },
  'POST /api/world/upload': async ({ req, res }) => {
    requireOffline();
    if (task && !task.done) throw new Error('Busy: ' + task.title);
    const up = path.join(SERVER_DIR, 'backups', '.upload.zip');
    await receiveFile(req, up);
    runTask('Import world', async p => {
      const tmp = path.join(SERVER_DIR, 'backups', '.upload-tmp');
      await fsp.rm(tmp, { recursive: true, force: true });
      p('Extracting upload...');
      await extractZip(up, tmp);
      const found = await findLevelDir(tmp);
      if (!found) throw new Error('No level.dat found in that zip - is it a Minecraft world?');
      p('Backing up current world...');
      if (backups.worldFolders().length) await backups.create('before-import', 'manual', m => p(m));
      await backups.removeWorlds();
      const lvl = backups.levelName();
      await fsp.rename(found, path.join(SERVER_DIR, lvl));
      for (const suffix of ['_nether', '_the_end']) {
        const sib = found + suffix;
        if (fs.existsSync(sib)) await fsp.rename(sib, path.join(SERVER_DIR, lvl + suffix));
      }
      await fsp.rm(tmp, { recursive: true, force: true });
      await fsp.rm(up, { force: true });
      p('World imported.');
    });
    U.sendJSON(res, 200, { ok: true });
  },
};

// ------------------------------------------------------------------ server
function hostAllowed(req) {
  const host = String(req.headers.host || '').toLowerCase();
  return host === `localhost:${config.port}` || host === `127.0.0.1:${config.port}` || host === `[::1]:${config.port}`;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  // DNS-rebinding + CSRF protection: only accept requests addressed to localhost, and
  // require a custom header on state-changing requests (browsers can't send it cross-site).
  if (!hostAllowed(req)) { res.writeHead(403); return res.end('Forbidden'); }
  if (req.method !== 'GET' && req.headers['x-blockhost'] !== '1') { res.writeHead(403); return res.end('Forbidden'); }

  if (url.pathname === '/api/events') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
    res.write(`event: hello\ndata: ${JSON.stringify({ snapshot: snapshot(), lines: mc.lines.slice(-500), history: statsHistory })}\n\n`);
    clients.add(res);
    req.on('close', () => clients.delete(res));
    return;
  }

  const key = `${req.method} ${url.pathname}`;
  try {
    if (streamRoutes[key]) return await streamRoutes[key]({ req, res, query: url.searchParams });
    if (routes[key]) {
      const body = (req.method === 'POST') ? await U.readJSONBody(req) : {};
      const result = await routes[key]({ req, body, query: url.searchParams });
      return U.sendJSON(res, 200, result ?? { ok: true });
    }
    if (url.pathname.startsWith('/api/')) return U.sendJSON(res, 404, { error: 'Unknown endpoint' });
    serveStatic(req, res, url.pathname);
  } catch (e) {
    if (!res.headersSent) U.sendJSON(res, 400, { error: e.message, code: e.code || null });
    else res.end();
  }
});

setInterval(() => { for (const c of clients) { try { c.write(': ping\n\n'); } catch { /* ignore */ } } }, 20000);
// Keep idle browser connections open longer than the browser does. With Node's 5 s default the server can close a
// connection at the same moment the browser reuses it, and Firefox then reports "NetworkError" for button clicks (POST).
server.keepAliveTimeout = 120000;
server.headersTimeout = 125000;

// The dashboard should never compete with Minecraft for CPU: run it below normal, give Java above normal.
try { require('os').setPriority(0, require('os').constants.priority.PRIORITY_BELOW_NORMAL); } catch { /* ignore */ }
mc.on('state', s => {
  if (s.state === 'starting' && mc.proc) { try { require('os').setPriority(mc.proc.pid, require('os').constants.priority.PRIORITY_ABOVE_NORMAL); } catch { /* needs no admin on Windows; ignore if refused */ } }
});

server.listen(config.port, '127.0.0.1', async () => {
  const url = `http://localhost:${config.port}`;
  console.log(`\n  Blockhost dashboard running at ${url}`);
  console.log(`  Server folder: ${SERVER_DIR}`);
  console.log('  Keep this window open. Closing it stops the Minecraft server too.\n');
  mc.log(`Dashboard started. Server folder: ${SERVER_DIR}`, 'dash');
  if (config.openBrowser && process.env.BLOCKHOST_NO_BROWSER !== '1') {
    if (U.IS_WIN) { const c = require('child_process').spawn('cmd.exe', ['/c', 'start', '""', url], { windowsVerbatimArguments: true, stdio: 'ignore', detached: true }); c.on('error', () => {}); c.unref(); }
  }
  if (config.checkUpdatesOnLaunch) {
    try { latestRelease = (await updater.manifest()).latest.release; broadcast('state', snapshot()); }
    catch (e) { mc.log('Could not check for updates: ' + e.message, 'warn'); }
  }
  if (config.autoStartPlayit) {
    const exe = sys.findPlayit(config.playitPath, SERVER_DIR, DASH_DIR);
    if (exe && !(await sys.playitRunning())) sys.startPlayit(exe);
  }
  sync.start();
  if (config.fastLane && config.syncEnabled) fast.start();
  if (sharedActive() && !mc.isRunning()) { if (!(await front.start())) mc.log('Live Sync front door: ' + front.error, 'warn'); }
  sync.url().catch(() => {});
  if (config.autoStartServer) mc.start().catch(e => mc.log('Auto-start failed: ' + e.message, 'error'));
});

server.on('error', e => {
  if (e.code === 'EADDRINUSE') {
    console.error(`\n  Port ${config.port} is already in use - the dashboard is probably already open.`);
    console.error(`  Open http://localhost:${config.port} in your browser.\n`);
    process.exit(2);
  }
  throw e;
});

// Keep the panel alive if something unexpected throws; log it to the console page instead.
process.on('uncaughtException', e => { console.error(e); try { fs.appendFileSync(path.join(DASH_DIR, 'blockhost-error.log'), `[${new Date().toISOString()}] ${e.stack || e}\n`); } catch { /* ignore */ } try { mc.log('Dashboard error: ' + e.message, 'error'); } catch { /* ignore */ } });
process.on('unhandledRejection', e => { console.error(e); try { mc.log('Dashboard error: ' + (e && e.message), 'error'); } catch { /* ignore */ } });

// Stop Minecraft cleanly when the dashboard window is closed / Ctrl+C.
let shuttingDown = false;
async function shutdown() {
  if (shuttingDown) return; shuttingDown = true;
  if (mc.isRunning()) { console.log('Stopping Minecraft server...'); await mc.stop(60000); }
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
process.on('SIGHUP', shutdown);
