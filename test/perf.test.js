'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { audit, buildFlags, recommendHeap, apply, undo } = require('../dashboard/lib/perf');

const GB = 1073741824;

test('recommendHeap leaves room for the OS', () => {
  assert.strictEqual(recommendHeap(4 * GB), 2);
  assert.strictEqual(recommendHeap(8 * GB), 4);
  assert.ok(recommendHeap(64 * GB) <= 6);
});

test('buildFlags keeps user flags and drops clashing GC choices', () => {
  const out = buildFlags('-XX:+UseParallelGC -Dfoo=bar');
  assert.ok(out.includes('-XX:+UseG1GC'));
  assert.ok(!out.includes('UseParallelGC'));
  assert.ok(out.includes('-Dfoo=bar'));
});

test('audit never proposes touching view distance', () => {
  const a = audit({ cfg: { minRam: '2G', maxRam: '8G', jvmFlags: '' }, props: { 'view-distance': '12' }, totalMem: 16 * GB, javaMajor: 21 });
  const ids = a.items.filter(i => i.apply).map(i => i.id);
  assert.ok(!ids.some(i => i.includes('view')));
  assert.ok(a.items.some(i => i.id === 'keep-view-distance'));
});

test('apply then undo restores config and properties', () => {
  const store = { cfg: { minRam: '2G', maxRam: '8G', jvmFlags: '' }, props: { 'simulation-distance': '10' }, files: {} };
  const ctx = {
    cfg: store.cfg, props: store.props, totalMem: 16 * GB, javaMajor: 21, undoFile: 'u',
    setConfig: p => Object.assign(store.cfg, p), setProps: p => Object.assign(store.props, p),
    writeJSON: (f, o) => { store.files[f] = JSON.stringify(o); }, readJSON: f => (store.files[f] ? JSON.parse(store.files[f]) : null),
  };
  const r = apply(ctx, ['jvm', 'heap', 'sim']);
  assert.deepStrictEqual(r.applied.sort(), ['heap', 'jvm', 'sim']);
  assert.strictEqual(store.props['simulation-distance'], '8');
  undo(ctx);
  assert.strictEqual(store.cfg.maxRam, '8G');
  assert.strictEqual(store.props['simulation-distance'], '10');
});
