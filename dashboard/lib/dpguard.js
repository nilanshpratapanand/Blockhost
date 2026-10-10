'use strict';
// Data Pack Guard - finds data packs that Minecraft 26.x cannot load, BEFORE they stop the server from starting.
// One broken pack makes the whole server refuse to start ("Failed to load datapacks"), so this does three things:
//   1. inspect()   - reads each pack and spots the formats 26.x rejects (checked against 44 real packs: 0 false alarms)
//   2. preflight() - before every start, moves broken packs aside (never deletes) so the server comes up
//   3. healFromLog() - if a start still fails, reads Minecraft's own error log, names the exact packs and moves them aside
// Moved packs live in <server>/datapacks-disabled/ (outside the world, so Cloud Host never syncs them) and can be restored.
const fs = require('fs');
const path = require('path');
const { openZip } = require('./zipread');

const MAX_FILE = 3 * 1024 * 1024;           // skip absurdly large JSON files
const MAX_SCAN = 12000;                     // files read per pack

// Content signatures: [where, what, plain-English reason]. Each one is the exact thing the 26.x loader choked on in real packs.
const SIGS = [
  [/^data\/[^/]+\/worldgen\/(structure|biome)\//, /"minCount"/, 'mob spawn lists use the old minCount/maxCount fields (26.x needs "count")'],
  [/^data\/[^/]+\/worldgen\/(template_pool|processor_list)\//, /"Name"\s*:\s*"/, 'structure pieces store blocks in the old block-state format'],
  [/^data\/[^/]+\/worldgen\/placed_feature\//, /minecraft:random_offset/, 'uses the "random_offset" placement modifier, which no longer exists'],
  [/^data\/[^/]+\/(loot_table|predicate)\//, /"condition"\s*:\s*"/, 'loot conditions use the old "condition" key (26.x needs "type")'],
];

/** pack.mcmeta format fields come as a number, [major, minor] or {min_inclusive, max_inclusive} - reduce to a major number. */
function fmtNum(v) {
  if (v == null) return null;
  if (typeof v === 'number') return Math.floor(v);
  if (Array.isArray(v)) return typeof v[0] === 'number' ? Math.floor(v[0]) : null;
  if (typeof v === 'object') return fmtNum(v.max_inclusive != null ? v.max_inclusive : v.min_inclusive);
  return null;
}

function metaProblems(meta) {
  const out = [];
  const ov = meta && meta.overlays && Array.isArray(meta.overlays.entries) ? meta.overlays.entries : [];
  for (const e of ov) {
    if (!e || e.min_format != null || e.max_format != null) continue;
    const f = e.formats != null ? e.formats : e.supported_formats;    // [min, max] | number | {min_inclusive, max_inclusive}
    const top = Array.isArray(f) ? fmtNum(f.length > 1 ? f[1] : f[0]) : fmtNum(f);
    if (top != null && top > 81) out.push(`its pack.mcmeta overlay "${e.directory || '?'}" is missing min_format/max_format, so Minecraft 26.x cannot even read the pack`);
  }
  return out;
}

/** -> { level: 'ok' | 'likely' | 'broken', reasons: [string] }.  broken = certain, likely = matches a known-bad signature. */
function inspect(file) {
  const reasons = []; let level = 'ok';
  const rank = { ok: 0, likely: 1, broken: 2 };
  const mark = (lv, r) => { if (!reasons.includes(r)) reasons.push(r); if (rank[lv] > rank[level]) level = lv; };
  let z = null, names = [], dirRoot = null;
  try {
    if (fs.statSync(file).isDirectory()) {
      dirRoot = file;
      const walk = (d, rel) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const r = rel ? rel + '/' + e.name : e.name; if (e.isDirectory()) walk(path.join(d, e.name), r); else names.push(r); } };
      walk(file, '');
    } else { z = openZip(file); if (!z) return { level: 'broken', reasons: ['not a readable zip file'] }; names = z.names; }
  } catch { return { level: 'ok', reasons: [] }; }
  const read = n => { try { return dirRoot ? fs.readFileSync(path.join(dirRoot, n)) : z.read(n); } catch { return null; } };
  const size = n => { try { return dirRoot ? fs.statSync(path.join(dirRoot, n)).size : z.size(n); } catch { return 0; } };

  let meta = null;
  const m = read('pack.mcmeta');
  if (!m) mark('broken', 'no pack.mcmeta - Minecraft does not see it as a data pack');
  else { try { meta = JSON.parse(m.toString('utf8').replace(/^﻿/, '')); } catch { mark('broken', 'pack.mcmeta is not valid JSON'); } }
  if (meta) for (const r of metaProblems(meta)) mark('broken', r);

  if (names.some(n => /^data\/[^/]+\/worldgen\/configured_feature\//.test(n))) mark('broken', 'uses the pre-1.21 folder worldgen/configured_feature (now worldgen/feature), so its features never load');

  const found = new Map(); let scanned = 0;
  for (const n of names) {
    if (!n.endsWith('.json') || !n.startsWith('data/')) continue;
    for (let i = 0; i < SIGS.length; i++) {
      if (found.has(i) || !SIGS[i][0].test(n)) continue;
      if (++scanned > MAX_SCAN || size(n) > MAX_FILE) continue;
      const b = read(n);
      if (b && SIGS[i][1].test(b.toString('utf8'))) found.set(i, n);
    }
  }
  for (const [i] of found) mark('likely', 'made for an older Minecraft: ' + SIGS[i][2]);
  if (!reasons.length) level = 'ok';
  return { level, reasons };
}

/** Reads Minecraft's startup log: which packs failed to load, and why the world could not start. */
function parseLog(text) {
  const failed = new Map();
  const bump = (name, why) => { const o = failed.get(name) || { count: 0, why: '' }; o.count++; if (!o.why && why) o.why = why; failed.set(name, o); };
  const lines = String(text || '').split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    let m = lines[i].match(/Failed to parse \S+ from pack file\/(.+?)\s*$/);
    if (m) {
      let why = '';
      for (let j = i + 1; j < Math.min(i + 40, lines.length); j++) { const c = lines[j].match(/^Caused by: [\w.$]+: (.*)$/); if (c) { why = c[1].replace(/MapLike\[.*$/, '').slice(0, 140); break; } }
      bump(m[1], why); continue;
    }
    m = lines[i].match(/Failed to read pack file\/(.+?) metadata/);
    if (m) bump(m[1], 'its pack.mcmeta could not be read');
  }
  return { failed, blocked: /Failed to load datapacks|Failed to load registries due to errors/.test(text || '') };
}

class DpGuard {
  /** opts: { serverDir, packDir: () => path of world/datapacks, log: (msg, level) => void } */
  constructor(opts) {
    this.serverDir = opts.serverDir; this.packDir = opts.packDir; this.log = opts.log || (() => {});
    this.cache = new Map();
  }
  get disabledDir() { return path.join(this.serverDir, 'datapacks-disabled'); }
  get stateFile() { return path.join(this.disabledDir, 'blockhost-quarantine.json'); }
  state() { try { const s = JSON.parse(fs.readFileSync(this.stateFile, 'utf8')); return { moved: s.moved || {}, trusted: s.trusted || [] }; } catch { return { moved: {}, trusted: [] }; } }
  save(s) { fs.mkdirSync(this.disabledDir, { recursive: true }); fs.writeFileSync(this.stateFile, JSON.stringify(s, null, 2)); }

  packs() {
    const d = this.packDir();
    try { return fs.readdirSync(d, { withFileTypes: true }).filter(e => e.isDirectory() || /\.zip$/i.test(e.name)).map(e => e.name); } catch { return []; }
  }
  check(name) {
    const full = path.join(this.packDir(), name);
    let st; try { st = fs.statSync(full); } catch { return { level: 'ok', reasons: [] }; }
    const key = `${name}|${st.size}|${st.mtimeMs}`;
    const c = this.cache.get(name);
    if (c && c.key === key) return c.r;
    const r = inspect(full);
    this.cache.set(name, { key, r });
    return r;
  }
  /** Inspect a file that is not in the world folder yet (e.g. a fresh download). */
  checkFile(file) { return inspect(file); }

  list() {
    const s = this.state();
    return {
      packs: this.packs().map(name => ({ name, ...this.check(name), trusted: s.trusted.includes(name) })),
      quarantined: Object.entries(s.moved).filter(([n]) => fs.existsSync(path.join(this.disabledDir, n))).map(([name, v]) => ({ name, ...v })),
    };
  }

  move(name, why, source) {
    const base = path.basename(String(name));
    const from = path.join(this.packDir(), base);
    if (!fs.existsSync(from)) return false;
    fs.mkdirSync(this.disabledDir, { recursive: true });
    const to = path.join(this.disabledDir, base);
    if (fs.existsSync(to)) fs.rmSync(to, { recursive: true, force: true });
    try { fs.renameSync(from, to); }
    catch { fs.cpSync(from, to, { recursive: true }); fs.rmSync(from, { recursive: true, force: true }); }
    const s = this.state(); s.moved[base] = { why, source, at: Date.now() }; s.trusted = s.trusted.filter(n => n !== base); this.save(s);
    this.cache.delete(base);
    this.log(`Moved data pack "${base}" aside: ${why}`, 'warn');
    return true;
  }
  /** Put a pack back. The user knows better, so it is trusted (not moved again by the pre-start check; the error log can still catch it). */
  restore(name) {
    const base = path.basename(String(name));
    const from = path.join(this.disabledDir, base);
    if (!fs.existsSync(from)) throw new Error('That pack is not in the disabled folder.');
    fs.mkdirSync(this.packDir(), { recursive: true });
    const to = path.join(this.packDir(), base);
    if (fs.existsSync(to)) throw new Error('A pack with that name is already installed.');
    try { fs.renameSync(from, to); } catch { fs.cpSync(from, to, { recursive: true }); fs.rmSync(from, { recursive: true, force: true }); }
    const s = this.state(); delete s.moved[base]; if (!s.trusted.includes(base)) s.trusted.push(base); this.save(s);
    this.cache.delete(base);
    return { ok: true };
  }
  trust(name) { const s = this.state(); if (!s.trusted.includes(name)) { s.trusted.push(name); this.save(s); } }

  /** Before starting: move aside packs that cannot load. Returns the names moved. */
  preflight() {
    const s = this.state(), moved = [];
    for (const name of this.packs()) {
      if (s.trusted.includes(name)) continue;
      const r = this.check(name);
      if (r.level !== 'ok' && this.move(name, r.reasons[0], 'scan')) moved.push(name);
    }
    return moved;
  }
  /** After a failed start: read the error log and move exactly the packs Minecraft named. */
  healFromLog(logText) {
    const { failed, blocked } = parseLog(logText);
    const moved = [];
    for (const [name, v] of failed) if (this.move(name, 'Minecraft refused to load it' + (v.why ? ': ' + v.why : ''), 'log')) moved.push(name);
    return { moved, blocked, named: failed.size };
  }
}

module.exports = { DpGuard, inspect, parseLog, fmtNum };
