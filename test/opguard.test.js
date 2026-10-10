'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { OpGuard } = require('../dashboard/lib/opguard');

function setup(opsNames = ['nitin', 'nilansh', '<nilansh>'], cfg = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bh-op-'));
  fs.writeFileSync(path.join(dir, 'ops.json'), JSON.stringify(opsNames.map(n => ({ uuid: 'x', name: n, level: 4 }))));
  const sent = []; let config = { ...cfg };
  const g = new OpGuard({ dir, getConfig: () => config, saveConfig: p => { config = { ...config, ...p }; }, send: c => sent.push(c) });
  return { dir, g, sent, cfg: () => config, ops: () => JSON.parse(fs.readFileSync(path.join(dir, 'ops.json'), 'utf8')) };
}

test('scrub empties ops.json and remembers the names', () => {
  const t = setup(); t.g.scrub();
  assert.deepStrictEqual(t.ops(), []);
  assert.deepStrictEqual(t.cfg().opGuardNames, ['nitin', 'nilansh', '<nilansh>']);
});

test('grant requires the player to be online', () => {
  const t = setup([]);
  assert.throws(() => t.g.grant('nilansh', false), /session-only/);
  t.g.grant('nilansh', true);
});

test('joining as an op name without a grant gets de-opped; granted session is kept', () => {
  const t = setup(['nilansh']);
  t.g.onJoin('nilansh');
  assert.deepStrictEqual(t.sent, ['deop nilansh']);
  const u = setup(['nilansh']); u.g.grant('nilansh', true); u.g.onJoin('nilansh');
  assert.deepStrictEqual(u.sent, []);
});

test('op is revoked when the player leaves, and on stop the file is scrubbed', () => {
  const t = setup(['nilansh']); t.g.grant('nilansh', true);
  t.g.onLeave('nilansh');
  assert.deepStrictEqual(t.sent, ['deop nilansh']);
  t.g.onStop();
  assert.deepStrictEqual(t.ops(), []);
  assert.strictEqual(t.g.session.size, 0);
});

test('opGuard:false disables everything', () => {
  const t = setup(['nilansh'], { opGuard: false });
  t.g.scrub(); t.g.onJoin('nilansh'); t.g.grant('x', false);
  assert.strictEqual(t.ops().length, 1); assert.deepStrictEqual(t.sent, []);
});
