'use strict';
// Server tuning that never touches visuals: JVM/GC flags, heap sizing, and optional chunk-IO / simulation settings.
// Everything is audited first, applied only on request, validated against the real Java, and undoable.
const fs = require('fs');
const { spawnSync } = require('child_process');

// Aikar's G1 flag set (https://docs.papermc.io/paper/aikar-flags). Applies to any Java server, vanilla included.
const AIKAR = [
  '-XX:+UseG1GC', '-XX:+ParallelRefProcEnabled', '-XX:MaxGCPauseMillis=200',
  '-XX:+UnlockExperimentalVMOptions', '-XX:+DisableExplicitGC', '-XX:+AlwaysPreTouch',
  '-XX:G1NewSizePercent=30', '-XX:G1MaxNewSizePercent=40', '-XX:G1HeapRegionSize=8M',
  '-XX:G1ReservePercent=20', '-XX:G1HeapWastePercent=5', '-XX:G1MixedGCCountTarget=4',
  '-XX:InitiatingHeapOccupancyPercent=15', '-XX:G1MixedGCLiveThresholdPercent=90',
  '-XX:G1RSetUpdatingPauseTimePercent=5', '-XX:SurvivorRatio=32', '-XX:+PerfDisableSharedMem',
  '-XX:MaxTenuringThreshold=1',
];
const GC_EXCLUSIVE = /^-XX:\+Use(Serial|Parallel|Z|Shenandoah|Epsilon)GC$/;

const flagName = t => { const m = t.match(/^-XX:[+-]?([A-Za-z0-9_]+)/); return m ? m[1] : t; };
const toMB = s => { const m = String(s).match(/^(\d+)([MG])$/i); return m ? parseInt(m[1], 10) * (/g/i.test(m[2]) ? 1024 : 1) : 0; };
const tokens = s => String(s || '').split(/\s+/).filter(Boolean);

/** Recommended flags: Aikar's set, plus any of the user's own tokens that don't clash with it. */
function buildFlags(current) {
  const have = new Set(AIKAR.map(flagName));
  const keep = tokens(current).filter(t => !have.has(flagName(t)) && !GC_EXCLUSIVE.test(t));
  return [...AIKAR, ...keep].join(' ');
}

/** Heap that fits the host: leaves room for Windows and the game client. */
function recommendHeap(totalBytes) {
  const gb = Math.floor(totalBytes / 1073741824);
  if (gb <= 6) return Math.max(2, gb - 3);
  if (gb <= 8) return 4;
  return Math.max(3, Math.min(6, Math.floor(gb * 0.3)));
}

function audit({ cfg, props, totalMem, javaMajor }) {
  const items = [];
  const heapRec = recommendHeap(totalMem || 16 * 1073741824);
  const minMB = toMB(cfg.minRam), maxMB = toMB(cfg.maxRam);
  const totalGB = Math.round((totalMem || 0) / 1073741824);

  // 1. JVM flags
  const want = buildFlags(cfg.jvmFlags);
  const haveSet = new Set(tokens(cfg.jvmFlags)), wantSet = new Set(tokens(want));
  const missing = [...wantSet].filter(t => !haveSet.has(t));
  items.push({
    id: 'jvm', kind: 'safe', title: 'Smoother garbage collection',
    state: missing.length ? 'improve' : 'good',
    current: `${tokens(cfg.jvmFlags).length} flags`, recommended: `${tokens(want).length} flags (Aikar G1 set)`,
    why: 'Shorter, rarer lag spikes when chunks load or players join. Pure memory management; nothing in rendering changes.',
    detail: missing.length ? `Adds ${missing.length} flag${missing.length > 1 ? 's' : ''}` : 'Already tuned',
    apply: missing.length ? { config: { jvmFlags: want } } : null,
  });

  // 2. Heap
  const sane = minMB === maxMB && maxMB >= 3072 && maxMB <= Math.max(heapRec + 2, 6) * 1024;
  items.push({
    id: 'heap', kind: 'safe', title: 'Right-sized memory',
    state: sane ? 'good' : 'improve',
    current: `${cfg.minRam} min / ${cfg.maxRam} max`, recommended: `${heapRec}G fixed`,
    why: `Equal min and max avoids resizing pauses. About ${heapRec} GB suits a friends server on a ${totalGB || '?'} GB PC and leaves room for the game and Windows.`,
    detail: sane ? 'Already fine' : `Set both to ${heapRec}G`,
    apply: sane ? null : { config: { minRam: heapRec + 'G', maxRam: heapRec + 'G' } },
  });

  // 3. Java version (informational)
  items.push({
    id: 'java', kind: 'info', title: 'Java version', state: javaMajor >= 21 ? 'good' : 'improve',
    current: javaMajor ? 'Java ' + javaMajor : 'not found', recommended: 'newest the server supports',
    why: 'Newer Java versions have faster garbage collectors and JIT. Blockhost already picks the lowest version the server needs, or your choice in Settings.',
    detail: '', apply: null,
  });

  // 4. Chunk compression (optional)
  const comp = props['region-file-compression'] || 'deflate';
  items.push({
    id: 'lz4', kind: 'optional', title: 'Faster chunk loading (LZ4)',
    state: comp === 'lz4' ? 'good' : 'optional', current: comp, recommended: 'lz4',
    why: 'LZ4 decompresses chunks much faster than the default, so joins and exploring cost less CPU. Applies to chunks as they are saved. Trade-off: world files get somewhat bigger. Visuals identical.',
    detail: comp === 'lz4' ? 'Already on' : 'Costs some disk space',
    apply: comp === 'lz4' ? null : { props: { 'region-file-compression': 'lz4' } },
  });

  // 5. Simulation distance (optional, gameplay not visuals)
  const sim = parseInt(props['simulation-distance'] || '10', 10), view = parseInt(props['view-distance'] || '10', 10);
  items.push({
    id: 'sim', kind: 'optional', title: 'Lighter world simulation (8 chunks)',
    state: sim <= 8 ? 'good' : 'optional', current: String(sim), recommended: '8',
    why: `Mobs, crops and redstone only tick within this range. You still SEE the full ${view} chunks, terrain and shaders look exactly the same. Far-away farms stop running sooner, so keep it at ${sim} if players use big far-off farms.`,
    detail: sim <= 8 ? 'Already low' : 'Gameplay effect, not visual',
    apply: sim <= 8 ? null : { props: { 'simulation-distance': '8' } },
  });

  // 6. Deliberately untouched (explained so nothing looks forgotten)
  const keepers = [
    ['view-distance', view + ' chunks', 'This sets how far players see. Left alone on purpose.'],
    ['entity-broadcast-range-percentage', (props['entity-broadcast-range-percentage'] || '100') + '%', 'Lower values make far mobs vanish from view. Left alone on purpose.'],
    ['sync-chunk-writes', props['sync-chunk-writes'] || 'true', 'Keeps the world safe if the PC crashes or loses power. Turning it off risks corrupted chunks.'],
  ];
  for (const [k, cur, why] of keepers) items.push({ id: 'keep-' + k, kind: 'kept', title: k, state: 'kept', current: cur, recommended: 'unchanged', why, detail: 'Kept', apply: null });

  const todo = items.filter(i => i.kind === 'safe' && i.apply).length;
  return { items, safeTodo: todo, heapRec, totalGB };
}

/** Try the flags with the real Java. If it rejects some, drop only those. Returns {flags, dropped}. */
function validateFlags(javaPath, flags, heap) {
  // probe with the real heap size (some flags are size-dependent) but without pre-touching all that memory
  const probe = list => spawnSync(javaPath, [`-Xmx${heap || '2G'}`, ...list.filter(t => t !== '-XX:+AlwaysPreTouch'), '-version'], { encoding: 'utf8', timeout: 30000, windowsHide: true });
  const ok = r => r.status === 0 && !/Unrecognized|Could not create|Error occurred|Invalid/i.test((r.stderr || '') + (r.stdout || ''));
  const all = tokens(flags);
  if (ok(probe(all))) return { flags: all.join(' '), dropped: [] };
  const good = [], dropped = [];
  const lead = all.filter(t => t === '-XX:+UnlockExperimentalVMOptions');
  for (const t of all) {
    if (lead.includes(t)) { good.push(t); continue; }
    (ok(probe([...lead, t])) ? good : dropped).push(t);
  }
  // combined check again, in case of conflicting pairs
  if (!ok(probe(good))) return { flags: null, dropped: all };
  return { flags: good.join(' '), dropped };
}

/** Apply selected item ids. ctx: {cfg, props, setConfig(patch), setProps(changes), javaPath, undoFile, writeJSON, readJSON, totalMem, javaMajor} */
function apply(ctx, ids) {
  const a = audit(ctx);
  const chosen = a.items.filter(i => ids.includes(i.id) && i.apply);
  if (!chosen.length) throw new Error('Nothing to change - already tuned.');
  const cfgPatch = {}, propPatch = {};
  for (const i of chosen) { Object.assign(cfgPatch, i.apply.config || {}); Object.assign(propPatch, i.apply.props || {}); }
  let dropped = [];
  if (cfgPatch.jvmFlags && ctx.javaPath) {
    const v = validateFlags(ctx.javaPath, cfgPatch.jvmFlags, cfgPatch.maxRam || ctx.cfg.maxRam);
    if (!v.flags) throw new Error('Java rejected the tuned flags, so nothing was changed.');
    cfgPatch.jvmFlags = v.flags; dropped = v.dropped;
  }
  const undo = { at: Date.now(), ids: chosen.map(i => i.id), config: {}, props: {} };
  for (const k of Object.keys(cfgPatch)) undo.config[k] = ctx.cfg[k];
  for (const k of Object.keys(propPatch)) undo.props[k] = ctx.props[k] === undefined ? null : ctx.props[k];
  ctx.writeJSON(ctx.undoFile, undo);          // saved first: a failure after this can still be rolled back
  if (Object.keys(cfgPatch).length) ctx.setConfig(cfgPatch);
  if (Object.keys(propPatch).length) ctx.setProps(propPatch);
  return { applied: undo.ids, config: cfgPatch, props: propPatch, droppedFlags: dropped };
}

function undo(ctx) {
  const u = ctx.readJSON(ctx.undoFile, null);
  if (!u) throw new Error('Nothing to undo.');
  if (Object.keys(u.config || {}).length) ctx.setConfig(u.config);
  const pc = {}; for (const [k, v] of Object.entries(u.props || {})) if (v !== null) pc[k] = v;
  if (Object.keys(pc).length) ctx.setProps(pc);
  try { fs.unlinkSync(ctx.undoFile); } catch { /* already gone */ }
  return { restored: u.ids };
}

module.exports = { audit, apply, undo, buildFlags, validateFlags, recommendHeap, AIKAR };
