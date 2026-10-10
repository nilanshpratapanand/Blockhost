'use strict';
// Mod Guard - looks inside every mod .jar and finds what would crash the game or stop friends joining:
//   wrong loader (Forge/NeoForge/Quilt jar on a Fabric setup), wrong Minecraft version, missing required libraries,
//   mods that declare they break each other, two copies of the same mod, and a few famous crash combos.
// Pure local analysis (reads fabric.mod.json etc.), no network.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { readZipEntry } = require('./zipread');

// mixinextras: bundled inside Fabric Loader itself (0.15+), so mods like Lithium need no separate jar
const BUILTIN = new Set(['minecraft', 'java', 'fabricloader', 'fabric-loader', 'mixinextras']);
const LOADER_NAME = { fabric: 'Fabric', quilt: 'Quilt', forge: 'Forge', neoforge: 'NeoForge' };

// [mod to remove, the mod it can't live with, why, level]
// 'error' only for combos confirmed by the mods' own authors; the rest are just a heads-up and never block anything.
const PAIRS = [
  [/^starlight$/i, /^phosphor$/i, 'Starlight and Phosphor both replace the lighting engine - their authors state they are completely incompatible (Phosphor shuts the game down if both are present).', 'error'],
  [/^(optifine|optifabric)$/i, /^(sodium|iris|indium)$/i, 'OptiFine and Sodium/Iris both replace the renderer, which commonly breaks the game. Usually you keep Sodium + Iris (they run shaders).', 'warn'],
  [/^quilted_fabric_api$/i, /^fabric-api$/i, 'Quilted Fabric API and Fabric API do the same job - normally you only need one.', 'warn'],
];

// ---------------------------------------------------------------- version predicates (Fabric syntax)
const parseVer = s => { const m = String(s == null ? '' : s).trim().replace(/^v/i, '').match(/^\d+(\.\d+)*/); return m ? m[0].split('.').map(Number) : null; };
const cmp = (a, b) => { for (let i = 0; i < Math.max(a.length, b.length); i++) { const d = (a[i] || 0) - (b[i] || 0); if (d) return d > 0 ? 1 : -1; } return 0; };

function atom(v, op, rest) {
  rest = String(rest).trim();
  if (!rest || rest === '*') return true;
  if (/(^|\.)[xX*]($|\.)/.test(rest)) {
    const fixed = [];
    for (const p of rest.split('.')) { if (/^[xX*]$/.test(p)) break; if (!/^\d+$/.test(p)) return null; fixed.push(+p); }
    return fixed.every((n, i) => (v[i] || 0) === n);
  }
  const t = parseVer(rest); if (!t) return null;
  const c = cmp(v, t);
  switch (op || '=') {
    case '>=': return c >= 0; case '>': return c > 0; case '<=': return c <= 0; case '<': return c < 0; case '=': return c === 0;
    case '~': return c >= 0 && (v[0] || 0) === (t[0] || 0) && (t.length < 2 || (v[1] || 0) === (t[1] || 0));
    case '^': return c >= 0 && (v[0] || 0) === (t[0] || 0);
  }
  return null;
}
/** true / false, or null when we can't tell (then we stay quiet instead of crying wolf). */
function satisfies(version, pred) {
  const v = parseVer(version); if (!v) return null;
  let unknown = false;
  for (const alt of Array.isArray(pred) ? pred : [pred]) {
    const re = /(>=|<=|>|<|=|~|\^)?\s*([^\s<>=~^]+)/g; let m, ok = true, unk = false, any = false;
    while ((m = re.exec(String(alt)))) { any = true; const r = atom(v, m[1], m[2]); if (r === null) unk = true; else if (!r) ok = false; }
    if (!any) continue;
    if (ok && !unk) return true;
    if (ok && unk) unknown = true;
  }
  return unknown ? null : false;
}
const fmtPred = p => (Array.isArray(p) ? p : [p]).join(' or ');

// ---------------------------------------------------------------- reading one jar
function readJson(file, entry) {
  let b; try { b = readZipEntry(file, entry); } catch { return { exists: true, json: null }; }
  if (!b) return { exists: false, json: null };
  try { return { exists: true, json: JSON.parse(b.toString('utf8').replace(/^﻿/, '')) }; } catch { return { exists: true, json: null }; }
}
const ids = arr => (Array.isArray(arr) ? arr : []).map(p => (typeof p === 'string' ? p : p && p.id)).filter(Boolean);

function inspectRaw(file, st) {
  const out = { file, name: path.basename(file), size: st.size, mtime: st.mtimeMs, loader: null, id: null, version: null, title: null,
    depends: {}, breaks: {}, conflicts: {}, provides: [], nestedIds: [], env: '*', broken: false };
  try {
    const head = Buffer.alloc(4); const fd = fs.openSync(file, 'r'); fs.readSync(fd, head, 0, 4, 0); fs.closeSync(fd);
    if (head.readUInt32LE(0) !== 0x04034b50) { out.broken = true; return out; }
  } catch { out.broken = true; return out; }

  const fab = readJson(file, 'fabric.mod.json');
  if (fab.exists) {
    const j = fab.json;
    if (!j || typeof j !== 'object') { out.broken = true; return out; }
    out.loader = 'fabric'; out.id = j.id; out.version = String(j.version || ''); out.title = j.name || j.id;
    const obj = o => (o && typeof o === 'object' && !Array.isArray(o) ? o : {});
    out.depends = obj(j.depends); out.breaks = obj(j.breaks); out.conflicts = obj(j.conflicts);
    out.provides = ids(j.provides); out.env = j.environment || '*';
    const nested = Array.isArray(j.jars) ? j.jars.slice(0, 300) : [];
    if (nested.length) {
      let dir; try { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bh-guard-')); } catch { dir = null; }
      if (dir) {
        try {
          nested.forEach((n, i) => {
            const f = n && n.file; if (!f) return;
            const b = readZipEntry(file, f); if (!b) return;
            const tmp = path.join(dir, i + '.jar'); fs.writeFileSync(tmp, b);
            const nj = readJson(tmp, 'fabric.mod.json').json;
            if (nj && nj.id) out.nestedIds.push(nj.id, ...ids(nj.provides));
          });
        } catch { /* nested jars unreadable - not fatal */ } finally { fs.rmSync(dir, { recursive: true, force: true }); }
      }
    }
    return out;
  }
  const q = readJson(file, 'quilt.mod.json');
  if (q.exists) { out.loader = 'quilt'; const ql = q.json && q.json.quilt_loader; out.id = ql && ql.id; out.title = (ql && ql.metadata && ql.metadata.name) || out.id; return out; }
  for (const [entry, loader] of [['META-INF/neoforge.mods.toml', 'neoforge'], ['META-INF/mods.toml', 'forge'], ['mcmod.info', 'forge']]) {
    let b = null; try { b = readZipEntry(file, entry); } catch { /* */ }
    if (b) { out.loader = loader; const m = b.toString('utf8').match(/modId\s*=\s*"([^"]+)"/); out.id = m ? m[1] : null; out.title = out.id; return out; }
  }
  return out;
}

const cache = new Map();
function inspect(file) {
  let st; try { st = fs.statSync(file); } catch { return null; }
  const c = cache.get(file);
  if (c && c.m === st.mtimeMs && c.s === st.size) return c.v;
  const v = inspectRaw(file, st);
  cache.set(file, { m: st.mtimeMs, s: st.size, v });
  return v;
}

// ---------------------------------------------------------------- scan a set of folders
/** dirs: [{ dir, kind: 'kit' | 'server' }]. Returns { gameVersion, total, mods, issues }. */
function scan(dirs, gv, rules = {}) {
  const allow = new Set((rules.allow || []).map(s => String(s).toLowerCase()));
  const okMod = m => allow.has(String(m.id || '').toLowerCase()) || allow.has(m.name.toLowerCase());
  const mods = [];
  for (const d of dirs) {
    let names = []; try { names = fs.readdirSync(d.dir); } catch { continue; }
    for (const n of names) if (/\.jar$/i.test(n)) { const i = inspect(path.join(d.dir, n)); if (i) mods.push({ ...i, where: d.kind }); }
  }
  const issues = [];
  const add = (level, code, m, title, why, fix, others = [], extra = {}) => issues.push({ level, code, mod: m.name, modId: m.id || null, where: m.where, title, why, fix, others, ...extra });
  const rm = m => ({ action: 'remove', file: m.name, where: m.where });
  const label = m => m.title || m.id || m.name;

  const fabric = mods.filter(m => m.loader === 'fabric');
  const provided = new Map();
  for (const m of fabric) for (const id of [m.id, ...m.provides, ...m.nestedIds]) { if (!id) continue; if (!provided.has(id)) provided.set(id, []); provided.get(id).push(m); }
  const hasFabricApi = provided.has('fabric-api') || provided.has('fabric');

  for (const m of mods) {
    if (okMod(m)) continue;   // the host said this one is fine
    if (m.broken) { add('error', 'broken', m, `${m.name} is damaged`, 'This file is not a readable mod (corrupt download, or a .rar/.zip renamed to .jar). The game would fail to start with it.', rm(m)); continue; }
    if (m.loader && m.loader !== 'fabric') {
      add('error', 'wrong-loader', m, `${label(m)} is a ${LOADER_NAME[m.loader]} mod`, `Your setup runs Fabric. A ${LOADER_NAME[m.loader]} jar can't be loaded by Fabric - the game crashes or the mod is silently ignored. Find the Fabric version of it, or remove it.`, rm(m));
      continue;
    }
    if (!m.loader) { add('warn', 'unknown', m, `${m.name} has no mod info`, 'It is not a Fabric mod (no fabric.mod.json). It may be a plain library or the wrong kind of file.', rm(m)); continue; }

    const mcp = m.depends.minecraft;
    if (mcp != null && gv && satisfies(gv, mcp) === false) add('error', 'wrong-mc', m, `${label(m)} is not for Minecraft ${gv}`, `It was built for Minecraft ${fmtPred(mcp)}. A mod made for another version usually crashes on launch. Get the ${gv} build, or remove it.`, rm(m));

    for (const [dep, pred] of Object.entries(m.depends)) {
      if (BUILTIN.has(dep)) continue;
      const provs = (provided.get(dep) || []).filter(x => x !== m);
      const satisfied = provs.length || (/^fabric-/.test(dep) && hasFabricApi) || (dep === 'fabric' && hasFabricApi);
      if (!satisfied) { add('error', 'missing-dep', m, `${label(m)} needs “${dep}”`, `${label(m)} requires the library/mod “${dep}”, which isn't installed. The game stops at startup with “Mod ${m.id} requires ${dep}”.`, { action: 'addDep', dep: dep === 'fabric' ? 'fabric-api' : dep, where: m.where }); continue; }
      const direct = provs.find(x => x.id === dep);
      if (direct && direct.version && satisfies(direct.version, pred) === false) add('warn', 'dep-version', m, `${label(m)} wants ${dep} ${fmtPred(pred)}`, `You have ${dep} ${direct.version}. It may refuse to load - update ${dep}.`, null, [direct.name], { dep });
    }
    for (const [kind, level] of [['breaks', 'error'], ['conflicts', 'warn']]) {
      for (const [id, pred] of Object.entries(m[kind])) {
        for (const p of (provided.get(id) || []).filter(x => x !== m && !okMod(x))) {
          const r = p.id === id && p.version ? satisfies(p.version, pred) : true;
          if (r === false) continue;
          add(level, kind, m, `${label(m)} can't be used with ${label(p)}`, `${label(m)} says it ${kind === 'breaks' ? 'breaks' : 'conflicts with'} ${label(p)}. Remove one of them (suggested: ${label(p)}).`, level === 'error' ? rm(p) : null, [p.name]);
        }
      }
    }
    if (m.where === 'kit' && m.env === 'server') add('warn', 'server-only', m, `${label(m)} is server-side only`, 'It does nothing on players\' PCs. Install it on the server instead of the player kit.', rm(m));
  }

  // two copies of the same mod id: keep the newest
  const byId = new Map();
  for (const m of fabric) if (m.id) { if (!byId.has(m.id)) byId.set(m.id, []); byId.get(m.id).push(m); }
  for (const list of byId.values()) {
    if (list.length < 2) continue;
    list.sort((a, b) => { const va = parseVer(a.version), vb = parseVer(b.version); const c = va && vb ? cmp(vb, va) : 0; return c || b.mtime - a.mtime; });
    for (const old of list.slice(1).filter(x => !okMod(x))) add('error', 'duplicate', old, `${label(old)} is installed twice`, `${old.name} and ${list[0].name} are the same mod. Two copies make Fabric stop with “duplicate mod”. Keeping the newest (${list[0].name}).`, rm(old), [list[0].name]);
  }
  // famous crash combos
  const pairs = PAIRS.map(([b, o, why, lvl]) => [b, o, why, lvl]);
  for (const r of rules.pairs || []) pairs.push([new RegExp('^' + String(r.bad).replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$', 'i'), new RegExp('^' + String(r.other).replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$', 'i'), r.why || 'You marked these two as incompatible.', 'error']);
  for (const [bad, other, why, lvl] of pairs) {
    const a = fabric.filter(m => bad.test(m.id || '') && !okMod(m)), b = fabric.filter(m => other.test(m.id || '') && !okMod(m));
    if (a.length && b.length) for (const m of a) add(lvl, 'incompatible-pair', m, `${label(m)} + ${label(b[0])} don't work together`, why, lvl === 'error' ? rm(m) : null, [b[0].name]);
  }
  const order = { error: 0, warn: 1 };
  issues.sort((x, y) => order[x.level] - order[y.level]);
  const ignored = mods.filter(okMod).map(m => ({ name: m.name, id: m.id }));
  return { gameVersion: gv || null, total: mods.length, ignored, rules: { allow: [...(rules.allow || [])], pairs: rules.pairs || [] },
    mods: mods.map(m => ({ name: m.name, where: m.where, loader: m.loader, id: m.id, version: m.version, title: m.title, env: m.env,
      needs: Object.keys(m.depends || {}), provides: [m.id, ...(m.provides || []), ...(m.nestedIds || [])].filter(Boolean) })), issues };
}

// ---------------------------------------------------------------- crash log analyzer
/** Paste a crash report / latest.log (yours or a friend's): finds which installed mods it points at. */
function analyze(text, installed) {
  text = String(text || '').slice(0, 500000);
  const why = new Map(); const pairs = [];
  const add = (id, w) => { id = String(id).toLowerCase(); if (!why.has(id)) why.set(id, new Set()); why.get(id).add(w); };
  let m;
  const sus = text.match(/Suspected Mods?:[ \t]*([^\n]*(?:\n[ \t]+[^\n]*)*)/i);
  if (sus && !/^\s*none/i.test(sus[1])) for (const x of sus[1].matchAll(/\(([a-z0-9_\-]+)\)/gi)) add(x[1], 'named as a suspect in the crash report');
  for (const x of text.matchAll(/Mixin apply for mod ([a-z0-9_\-]+) failed/gi)) add(x[1], 'one of its Mixins failed to apply (usually wrong version or a clash with another mod)');
  for (const x of text.matchAll(/\bfrom mod ([a-z0-9_\-]+)\b/gi)) add(x[1], 'a Mixin from this mod failed');
  const re = /Mod '[^']*' \(([\w\-]+)\)[^\n]*?\b(requires|is incompatible with|conflicts with|breaks)\b[^\n]*?'[^']*' \(([\w\-]+)\)/gi;
  while ((m = re.exec(text))) {
    if (/requires/i.test(m[2])) { add(m[1], `needs “${m[3]}” (missing or wrong version)`); }
    else { add(m[1], `reported as incompatible with “${m[3]}”`); add(m[3], `reported as incompatible with “${m[1]}”`); pairs.push([m[1], m[3]]); }
  }
  const byId = new Map(installed.filter(i => i.id).map(i => [String(i.id).toLowerCase(), i]));
  const suspects = [], unmatched = [];
  for (const [id, set] of why) {
    if (id === 'minecraft' || id === 'java' || id === 'fabricloader') continue;
    const mod = byId.get(id);
    if (mod) suspects.push({ id, name: mod.name, title: mod.title || id, where: mod.where, reasons: [...set] }); else unmatched.push({ id, reasons: [...set] });
  }
  return { suspects, unmatched, pairs, nothing: !suspects.length && !unmatched.length };
}

module.exports = { scan, inspect, satisfies, parseVer, analyze };
