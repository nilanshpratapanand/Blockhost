'use strict';
// "Shader doctor": inspects a Minecraft client folder on this PC and explains why shaders are / aren't working,
// using the client's own logs/latest.log (written every time the game starts).
const fs = require('fs');
const path = require('path');

function gameDir() {
  const appdata = process.env.APPDATA || path.join(require('os').homedir(), 'AppData', 'Roaming');
  let dir = path.join(appdata, '.minecraft');
  for (const f of ['tlauncher-2.0.properties', 'tlauncher.properties']) {
    try {
      const txt = fs.readFileSync(path.join(appdata, '.tlauncher', f), 'utf8');
      const m = txt.match(/^\s*minecraft\.gamedir\s*=\s*(.+)$/m);
      if (m) { const g = m[1].trim().replace(/\\:/g, ':').replace(/\\\\/g, '\\'); if (fs.existsSync(g)) dir = g; }
    } catch { /* no TLauncher settings */ }
  }
  return dir;
}

const ls = d => { try { return fs.readdirSync(d); } catch { return []; } };

// Every mods folder the game might load from (TLauncher's custom game folder, the default one, per-version folders)
function modDirs() {
  const appdata = process.env.APPDATA || path.join(require('os').homedir(), 'AppData', 'Roaming');
  const roots = [...new Set([gameDir(), path.join(appdata, '.minecraft')])];
  const out = [];
  for (const r of roots) {
    out.push(path.join(r, 'mods'));
    for (const v of ls(path.join(r, 'versions'))) out.push(path.join(r, 'versions', v, 'mods'));
  }
  return [...new Set(out)].filter(d => fs.existsSync(d));
}
// mod id -> jar files (reads fabric.mod.json inside each jar)
function jarsById() {
  const map = {};
  for (const d of modDirs()) for (const f of ls(d).filter(x => /\.jar$/i.test(x))) {
    let id = null;
    try { id = JSON.parse(String(require('./zipread').readZipEntry(path.join(d, f), 'fabric.mod.json') || '{}')).id || null; } catch { /* not a fabric jar */ }
    if (!id) id = f.toLowerCase().replace(/[-_].*$/, '');
    (map[id] = map[id] || []).push({ dir: d, file: f, id });
  }
  return map;
}
// libraries that only exist for one content mod - remove them together
const COMPANIONS = { biomesoplenty: ['terrablender', 'glitchcore'], terrablender: ['glitchcore'] };

/** Move mods out of the mods folder (Minecraft must be closed). */
function disableMods(ids) {
  const want = new Set(); for (const id of ids) { want.add(id); for (const c of COMPANIONS[id] || []) want.add(c); }
  const map = jarsById(); const moved = [];
  for (const id of want) for (const j of map[id] || []) {
    const dest = path.join(j.dir, '_disabled-by-blockhost');
    fs.mkdirSync(dest, { recursive: true });
    try { fs.renameSync(path.join(j.dir, j.file), path.join(dest, j.file)); moved.push(j.file); }
    catch (e) { const err = new Error(`Couldn't move ${j.file} (${e.code}) - close Minecraft and TLauncher first, then try again.`); throw err; }
  }
  return { moved, folder: '_disabled-by-blockhost (inside the mods folder)' };
}

function diagnose(gameVersion) {
  const dir = gameDir();
  const out = { dir, exists: fs.existsSync(dir), checks: [], verdict: null, fix: null, logTail: [] };
  const add = (ok, label, detail) => out.checks.push({ ok, label, detail: detail || '' });
  if (!out.exists) { out.verdict = 'No Minecraft folder found on this PC.'; out.fix = 'Start the game once in TLauncher.'; return out; }

  const shaders = ls(path.join(dir, 'shaderpacks')).filter(f => /\.zip$/i.test(f) || fs.statSync(path.join(dir, 'shaderpacks', f)).isDirectory());
  add(shaders.length > 0, 'Shader packs in shaderpacks folder', shaders.join(', ') || 'none');
  const mods = ls(path.join(dir, 'mods')).filter(f => /\.jar$/i.test(f));
  const iris = mods.filter(f => /^iris/i.test(f)), sodium = mods.filter(f => /^sodium/i.test(f));
  add(iris.length === 1, 'Iris mod', iris.join(', ') || 'missing');
  add(sodium.length === 1, 'Sodium mod', sodium.join(', ') || 'missing');
  if (iris.length > 1 || sodium.length > 1) add(false, 'Duplicate mod versions', 'More than one Iris/Sodium jar - Fabric refuses to start. Keep only the newest.');
  const fabricVersions = ls(path.join(dir, 'versions')).filter(v => /fabric/i.test(v) && (!gameVersion || v.includes(gameVersion)));
  add(fabricVersions.length > 0, `Fabric version for ${gameVersion || 'this Minecraft'}`, fabricVersions.join(', ') || 'none installed');
  let props = '';
  try { props = fs.readFileSync(path.join(dir, 'config', 'iris.properties'), 'utf8'); } catch { /* none */ }
  const pack = (props.match(/^shaderPack=(.*)$/m) || [])[1];
  const enabled = /^enableShaders=true/m.test(props);
  add(!!pack && enabled, 'Iris settings (shader selected + on)', props ? `shaderPack=${pack || '(none)'}, enableShaders=${enabled}` : 'not created yet');

  // options.txt written by an older installer on Windows PowerShell 5.1: resourcePacks:[{"value":[..],"Count":n}]
  try {
    const opt = path.join(dir, 'options.txt'); const txt = fs.readFileSync(opt, 'utf8');
    const m = txt.match(/^resourcePacks:(.*)$/m);
    let ok = true; try { const a = JSON.parse(m ? m[1] : '[]'); ok = Array.isArray(a) && a.every(x => typeof x === 'string'); } catch { ok = false; }
    if (m && !ok) {
      const ids = []; const re = /"((?:[^"\\]|\\.)*)"/g; let x;
      while ((x = re.exec(m[1]))) { if (!/^\s*:/.test(m[1].slice(re.lastIndex))) ids.push(JSON.parse('"' + x[1] + '"')); }
      const fixed = txt.replace(/^resourcePacks:.*$/m, 'resourcePacks:' + JSON.stringify([...new Set(ids.length ? ids : ['vanilla'])]));
      fs.copyFileSync(opt, opt + '.blockhost-backup'); fs.writeFileSync(opt, fixed);
      add(true, 'options.txt', 'The texture pack list was broken (Minecraft was ignoring all your settings) - repaired. Restart Minecraft.');
    }
  } catch { /* no options.txt yet */ }

  // What happened the last time the game was started?
  let log = '';
  try { log = fs.readFileSync(path.join(dir, 'logs', 'latest.log'), 'utf8'); } catch { /* never launched */ }
  if (!log) {
    out.verdict = 'The game has not been started since installing (no latest.log).';
    out.fix = `In TLauncher choose ${fabricVersions[0] || 'the Fabric version'} and press Play.`;
    return out;
  }
  const lines = log.split(/\r?\n/);
  const fabricLine = lines.find(l => /Loading Minecraft .* with Fabric Loader/i.test(l));
  const mcLine = lines.find(l => /Minecraft Version|Loading Minecraft|Setting user:|Backend library/i.test(l));
  const modsLoaded = /^\s*-\s*iris\s/im.test(log);
  const errLines = lines.filter(l => /Incompatible mods? found|Mod resolution failed|requires .* which is missing|Failed to load shader ?pack|Exception|crash/i.test(l)).slice(0, 8);
  const shaderLine = lines.reverse().find(l => /Using shaderpack|Shader pack|shaderpack/i.test(l));
  add(!!fabricLine, 'Last launch used Fabric', fabricLine ? fabricLine.replace(/^.*?\]: ?/, '') : (mcLine ? 'No - it was a vanilla/OptiFine launch' : 'unknown'));
  add(modsLoaded, 'Iris loaded in last launch', modsLoaded ? 'yes' : 'no');
  if (shaderLine) add(!/fail/i.test(shaderLine), 'Shader status in log', shaderLine.replace(/^.*?\]: ?/, '').slice(0, 160));
  out.logTail = errLines.map(l => l.slice(0, 220));

  // "Connection lost: Network Protocol Error" -> the client and server disagree about a packet,
  // almost always because a client mod adds content (blocks/mobs/items) the vanilla server doesn't have.
  const proto = log.split(/\r?\n/).filter(l => /Network Protocol Error|Failed to decode packet|Failed to handle packet|Missing element ResourceKey|Failed to load registries|Error receiving packet|Packet .* was larger than I expected|Unknown custom packet identifier|registry .* mismatch|IndexOutOfBounds.*packet/i.test(l)).slice(0, 6);
  // "Missing element ResourceKey[minecraft:trim_material / biomesoplenty:glowworm_silk]" names the guilty mod directly
  const installed = jarsById();
  let culprits = [...new Set([...log.matchAll(/Missing element ResourceKey\[[\w:\/]+ \/ ([a-z0-9_.\-]+):/gi)].map(m => m[1]).filter(ns => ns !== 'minecraft'))];
  // "Failed to load registries" with "Unbound tags" / "Failed to parse value ... from server": registry-changing client mods
  const regFail = /Failed to load registries|Unbound tags in registry|Failed to parse value .* from server/i.test(log);
  if (regFail || culprits.length) for (const id of ['biomesoplenty', 'terrablender']) if (installed[id] && !culprits.includes(id)) culprits.push(id);
  culprits = culprits.filter(c => installed[c] || !regFail);
  culprits = culprits.filter(c => !culprits.some(o => (COMPANIONS[o] || []).includes(c)));   // TerraBlender is part of BOP
  out.culprits = culprits;
  out.culpritJars = [...new Set(culprits.flatMap(c => [c, ...(COMPANIONS[c] || [])]).flatMap(id => installed[id] || []).map(j => j.file))];
  if ((proto.length || regFail) && culprits.length) {
    add(false, 'Joining the server', `Network Protocol Error caused by: ${culprits.join(', ')}`);
    out.logTail = proto.map(l => l.slice(0, 260)).concat(out.logTail).slice(0, 10);
    out.verdict = `Network Protocol Error: ${culprits.map(c => c === 'biomesoplenty' ? "Biomes O' Plenty" : c).join(', ')} adds new content (biomes/items) - your server is vanilla, so joining fails.`;
    out.fix = out.culpritJars.length ? `Press "Move them out for me" (Minecraft and TLauncher closed). It moves ${out.culpritJars.join(', ')} to mods\\_disabled-by-blockhost. If they come back after starting TLauncher, TLauncher's mod manager re-installs them - remove them there too.` : 'Remove those mods from the mods folder, then join again.';
    return out;
  }
  if (proto.length) {
    add(false, 'Joining the server', 'Network Protocol Error in the last session');
    out.logTail = proto.map(l => l.slice(0, 260)).concat(out.logTail).slice(0, 10);
    const contentMods = mods.filter(f => { try { const j = JSON.parse(String(require('./zipread').readZipEntry(path.join(dir, 'mods', f), 'fabric.mod.json') || '{}')); return j.environment !== 'client' && !/^(fabric-?api|iris|sodium|indium|cloth|modmenu|fabric-language)/i.test(j.id || f); } catch { return false; } });
    out.verdict = 'Network Protocol Error: a mod on this PC doesn\'t match the (vanilla) server.';
    out.fix = contentMods.length ? `Most likely one of these (not client-only): ${contentMods.join(', ')}. Move them out of the mods folder (or remove them from the kit) and join again.` : 'Check the error lines below for the packet/mod name.';
    return out;
  }
  if (!fabricLine) { out.verdict = 'Minecraft was started WITHOUT Fabric, so Iris (the shader mod) never loaded.'; out.fix = `In TLauncher pick "${fabricVersions[0] || 'Fabric ' + (gameVersion || '')}" instead of plain ${gameVersion || 'Minecraft'}.`; }
  else if (errLines.some(l => /Incompatible|resolution failed|requires/i.test(l))) { out.verdict = 'Fabric started but a mod problem stopped Iris.'; out.fix = 'See the error lines below - usually an old or duplicate mod in the mods folder. Move other .jar files out of mods and try again.'; }
  else if (!modsLoaded) { out.verdict = 'Fabric started but Iris was not loaded.'; out.fix = 'Iris/Sodium are missing from the mods folder that this launcher uses - run the friend installer again.'; }
  else if (!pack || !enabled) { out.verdict = 'Iris is working, but no shader is switched on.'; out.fix = 'In game: Options > Video Settings > Shader Packs > pick one > Apply.'; }
  else out.verdict = 'Everything looks right. If the world still looks normal, press Options > Video Settings > Shader Packs and check the selected pack.';
  return out;
}

module.exports = { diagnose, gameDir, disableMods, modDirs };
