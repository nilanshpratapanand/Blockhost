'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const { DpGuard, inspect, parseLog } = require('../dashboard/lib/dpguard');

/** Tiny store-only zip writer so the tests need no zip tool. */
function makeZip(file, files) {
  const parts = [], cd = []; let off = 0;
  for (const [name, content] of Object.entries(files)) {
    const nm = Buffer.from(name), data = Buffer.from(content), crc = zlib.crc32(data);
    const lh = Buffer.alloc(30); lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(data.length, 18); lh.writeUInt32LE(data.length, 22); lh.writeUInt16LE(nm.length, 26);
    const ch = Buffer.alloc(46); ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt32LE(crc, 16); ch.writeUInt32LE(data.length, 20); ch.writeUInt32LE(data.length, 24); ch.writeUInt16LE(nm.length, 28); ch.writeUInt32LE(off, 42);
    parts.push(lh, nm, data); cd.push(ch, nm); off += 30 + nm.length + data.length;
  }
  const cdBuf = Buffer.concat(cd), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(Object.keys(files).length, 8); end.writeUInt16LE(Object.keys(files).length, 10); end.writeUInt32LE(cdBuf.length, 12); end.writeUInt32LE(off, 16);
  fs.writeFileSync(file, Buffer.concat([...parts, cdBuf, end]));
}
const MCMETA = JSON.stringify({ pack: { min_format: 121, max_format: 121, description: 'x' } });
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'bh-dp-'));

test('a clean pack passes', () => {
  const d = tmp(); makeZip(path.join(d, 'a.zip'), { 'pack.mcmeta': MCMETA, 'data/x/worldgen/feature/f.json': '{}' });
  assert.deepStrictEqual(inspect(path.join(d, 'a.zip')), { level: 'ok', reasons: [] });
});

test('pre-1.21 configured_feature folder is broken', () => {
  const d = tmp(); makeZip(path.join(d, 'a.zip'), { 'pack.mcmeta': MCMETA, 'data/x/worldgen/configured_feature/f.json': '{}' });
  assert.strictEqual(inspect(path.join(d, 'a.zip')).level, 'broken');
});

test('old spawn fields and loot conditions are flagged as likely', () => {
  const d = tmp();
  makeZip(path.join(d, 'a.zip'), { 'pack.mcmeta': MCMETA, 'data/x/worldgen/structure/s.json': '{"spawns":[{"minCount":1,"maxCount":2}]}' });
  makeZip(path.join(d, 'b.zip'), { 'pack.mcmeta': MCMETA, 'data/x/loot_table/l.json': '{"conditions":[{"condition":"minecraft:random_chance"}]}' });
  assert.strictEqual(inspect(path.join(d, 'a.zip')).level, 'likely');
  assert.strictEqual(inspect(path.join(d, 'b.zip')).level, 'likely');
});

test('overlay without min_format/max_format above format 81 is broken', () => {
  const d = tmp();
  const mc = { pack: { pack_format: 48 }, overlays: { entries: [{ formats: [61, 99], directory: 'o' }] } };
  makeZip(path.join(d, 'a.zip'), { 'pack.mcmeta': JSON.stringify(mc) });
  assert.strictEqual(inspect(path.join(d, 'a.zip')).level, 'broken');
  mc.overlays.entries[0] = { min_format: 61, max_format: 99, directory: 'o' };
  makeZip(path.join(d, 'b.zip'), { 'pack.mcmeta': JSON.stringify(mc) });
  assert.strictEqual(inspect(path.join(d, 'b.zip')).level, 'ok');
});

test('unzipped pack folders are inspected too', () => {
  const d = tmp(); const p = path.join(d, 'pk'); fs.mkdirSync(path.join(p, 'data/x/worldgen/configured_feature'), { recursive: true });
  fs.writeFileSync(path.join(p, 'pack.mcmeta'), MCMETA); fs.writeFileSync(path.join(p, 'data/x/worldgen/configured_feature/f.json'), '{}');
  assert.strictEqual(inspect(p).level, 'broken');
});

test('parseLog names the packs Minecraft refused', () => {
  const log = ['[1] Failed to parse t:a from pack file/Ships 3.0.4.zip', '\tat x', 'Caused by: java.lang.IllegalStateException: No key type in MapLike[{"a":1}]',
    '[2] Failed to read pack file/Terraphilic v1.2.0.zip metadata', '[3] Failed to load datapacks, can\'t proceed with server load.'].join('\n');
  const r = parseLog(log);
  assert.ok(r.blocked);
  assert.deepStrictEqual([...r.failed.keys()], ['Ships 3.0.4.zip', 'Terraphilic v1.2.0.zip']);
  assert.match(r.failed.get('Ships 3.0.4.zip').why, /No key type/);
});

test('preflight moves bad packs aside, restore trusts them, heal follows the log', () => {
  const root = tmp(), dp = path.join(root, 'world', 'datapacks'); fs.mkdirSync(dp, { recursive: true });
  makeZip(path.join(dp, 'good.zip'), { 'pack.mcmeta': MCMETA });
  makeZip(path.join(dp, 'old.zip'), { 'pack.mcmeta': MCMETA, 'data/x/worldgen/configured_feature/f.json': '{}' });
  makeZip(path.join(dp, 'odd.zip'), { 'pack.mcmeta': MCMETA });
  const g = new DpGuard({ serverDir: root, packDir: () => dp });
  assert.deepStrictEqual(g.preflight(), ['old.zip']);
  assert.ok(fs.existsSync(path.join(root, 'datapacks-disabled', 'old.zip')) && !fs.existsSync(path.join(dp, 'old.zip')));
  g.restore('old.zip');
  assert.deepStrictEqual(g.preflight(), [], 'a pack the user put back is trusted');
  const r = g.healFromLog('Failed to parse t:a from pack file/odd.zip\nFailed to load datapacks');
  assert.deepStrictEqual(r.moved, ['odd.zip']);
  assert.deepStrictEqual(g.list().quarantined.map(q => q.name), ['odd.zip']);
  assert.ok(fs.existsSync(path.join(dp, 'good.zip')), 'good packs are never touched');
});
