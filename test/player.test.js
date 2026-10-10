'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const http = require('http');
const { BatonHost } = require('../dashboard/lib/batonhost');
const { createPlayer } = require('../dashboard/lib/player');
const { encodeCode } = require('../dashboard/lib/baton');
const { extractZip } = require('../dashboard/lib/provision');

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
const tmp = p => fs.mkdtempSync(path.join(os.tmpdir(), 'bh-' + p + '-'));

/** In-memory stand-in for the Cloudflare coordinator (same wire format as cloud/worker.js) */
function fakeCloud(secret) {
  const s = { epoch: 0, host: null, expiresAt: 0, wanted: null }; const blobs = new Map(); let manifest = {};
  const view = () => { const live = !!s.host && s.expiresAt > Date.now(); return { state: live ? 'hosted' : 'free', epoch: s.epoch, host: live ? s.host : null, wanted: s.wanted, now: Date.now() }; };
  const j = (o, code = 200) => new Response(JSON.stringify(o), { status: code });
  const f = async (url, init = {}) => {
    const u = new URL(url); const h = init.headers || {};
    if (h.authorization !== 'Bearer ' + secret) return new Response('no', { status: 401 });
    const m = init.method || 'GET';
    if (u.pathname === '/v1/lease') {
      const b = JSON.parse(init.body); const live = !!s.host && s.expiresAt > Date.now();
      if (b.op === 'status') return j(view());
      if (b.op === 'acquire') { if (live && s.host.id !== b.id) return j({ ok: false, reason: 'busy', ...view() }); s.epoch++; s.host = { id: b.id, name: b.name, players: 0 }; s.expiresAt = Date.now() + 60000; s.wanted = null; return j({ ok: true, epoch: s.epoch }); }
      if (b.op === 'heartbeat') { if (b.epoch !== s.epoch) return j({ ok: false, reason: 'lost' }); s.expiresAt = Date.now() + 60000; return j({ ok: true }); }
      if (b.op === 'release') { s.expiresAt = 0; return j({ ok: true }); }
      if (b.op === 'request') { s.wanted = { by: b.name, at: Date.now() }; return j({ ok: true, ...view() }); }
    }
    if (u.pathname === '/v1/manifest') { if (m === 'GET') return j(manifest); manifest = JSON.parse(Buffer.from(init.body).toString()); return j({ ok: true }); }
    if (u.pathname === '/v1/gc') return j({ ok: true });
    const bm = u.pathname.match(/^\/v1\/blob\/(.+)$/);
    if (bm) { if (m === 'PUT') { blobs.set(bm[1], Buffer.from(init.body)); return j({ ok: true }); } const b = blobs.get(bm[1]); if (!b) return new Response('', { status: 404 }); return m === 'HEAD' ? new Response(null, { status: 200 }) : new Response(b); }
    return new Response('?', { status: 404 });
  };
  return { f, s };
}

const FAKE_JAVA = `#!/bin/sh
case "$1" in -version) echo 'openjdk version "25.0.1" 2026-01-01' 1>&2; exit 0;; esac
echo "[12:00:00] [Server thread/INFO]: Done (0.5s)! For help, type \\"help\\""
while read l; do case "$l" in stop) echo "[12:00:01] [Server thread/INFO]: Stopping server"; exit 0;; esac; done
`;

const call = (ctl, method, p, body) => new Promise((resolve, reject) => {
  const r = http.request({ host: '127.0.0.1', port: ctl.port, path: p, method, headers: { 'x-bh-token': ctl.token, 'content-type': 'application/json' } }, res => {
    let d = ''; res.on('data', c => d += c); res.on('end', () => resolve({ status: res.statusCode, body: d ? JSON.parse(d) : {} }));
  });
  r.on('error', reject); r.end(body ? JSON.stringify(body) : undefined);
});
const until = async (fn, ms = 15000) => { const t = Date.now(); while (Date.now() - t < ms) { const v = await fn(); if (v) return v; await new Promise(r => setTimeout(r, 100)); } throw new Error('timed out'); };

test('extractZip drops the top folder and refuses paths that escape', () => {
  const d = tmp('zip'); makeZip(path.join(d, 'a.zip'), { 'jdk-25/bin/java': 'x', 'jdk-25/lib/m': 'y' });
  assert.strictEqual(extractZip(path.join(d, 'a.zip'), path.join(d, 'out')), 2);
  assert.ok(fs.existsSync(path.join(d, 'out', 'bin', 'java')));
  makeZip(path.join(d, 'b.zip'), { 'a/x': 'y', '../evil': 'x' });
  assert.throws(() => extractZip(path.join(d, 'b.zip'), path.join(d, 'out2')), /Unsafe/);
});

test('a friend PC pulls the world, hosts, is protected by the token, and hands back after everyone leaves', { skip: process.platform === 'win32' }, async () => {
  const secret = 'secretsecretsecret1';
  const cloud = fakeCloud(secret); const url = 'https://x.example.workers.dev';
  const fetchImpl = (u, i) => cloud.f(u, i);
  // owner uploads a world
  const od = tmp('owner'); fs.mkdirSync(path.join(od, 'world'));
  fs.writeFileSync(path.join(od, 'world', 'level.dat'), 'LEVEL-1');
  fs.writeFileSync(path.join(od, 'eula.txt'), 'eula=true\n');
  fs.writeFileSync(path.join(od, 'server.properties'), 'level-name=world\nmotd=hi\n');
  makeZip(path.join(od, 'server.jar'), { 'version.json': JSON.stringify({ id: '26.3', java_version: 25 }) });
  const stub = { on() {}, isRunning: () => false };
  const owner = new BatonHost({ mc: stub, dir: od, getConfig: () => ({}), saveConfig() {}, fetchImpl, worldName: () => 'world', stateFile: path.join(od, 'st.json') });
  let ocfg = {}; owner.o.getConfig = () => ocfg; owner.o.saveConfig = p => { ocfg = { ...ocfg, ...p }; };
  await owner.seed(url, secret);

  // friend PC
  const fd = tmp('friend'); const javaDir = path.join(fd, 'fakejava'); fs.mkdirSync(javaDir, { recursive: true });
  const javaPath = path.join(javaDir, 'java'); fs.writeFileSync(javaPath, FAKE_JAVA, { mode: 0o755 });
  fs.writeFileSync(path.join(fd, 'host.json'), JSON.stringify({ code: encodeCode(url, secret), address: 'play.example:1234', world: 'world', port: 25599, name: 'Test' }));
  const p = createPlayer({ dir: fd, fetchImpl, ensureJre: async () => javaPath, installPlayit: async () => {}, pingAddress: async () => ({ ok: true }), reachDelayMs: 50, noExit: true, config: { batonMinHostGB: 1, batonName: 'Friend' }, idleMsOverride: 300, timing: { tickMs: 100, heartbeatMs: 500, crashMs: 400 } });
  const ctl = await p.listen();
  try {
    assert.strictEqual((await call({ ...ctl, token: 'wrong' }, 'GET', '/state')).status, 403);
    const st = await call(ctl, 'GET', '/state?fresh=1');
    assert.strictEqual(st.body.phase, 'off'); assert.strictEqual(st.body.remote.state, 'free'); assert.strictEqual(st.body.address, 'play.example:1234');
    await call(ctl, 'POST', '/start');
    await until(async () => (await call(ctl, 'GET', '/state')).body.phase === 'hosting');
    assert.strictEqual(fs.readFileSync(path.join(fd, 'server', 'world', 'level.dat'), 'utf8'), 'LEVEL-1');
    assert.strictEqual(cloud.s.host.name, 'Friend');
    assert.match(fs.readFileSync(path.join(fd, 'server', 'server.properties'), 'utf8'), /server-port=25599/);
    await until(async () => ((await call(ctl, 'GET', '/state')).body.reach || {}).state === 'ok');
    // server sits empty -> saved and handed back
    await until(async () => (await call(ctl, 'GET', '/state')).body.phase === 'off' && cloud.s.expiresAt === 0, 20000);
    assert.ok(!p.mc.isRunning());
  } finally { await p.shutdown(); }
  assert.ok(!fs.existsSync(path.join(fd, 'control.json')));
});

test('host bundle ships every local module the player needs, and reads the playit key', () => {
  const hb = require('../dashboard/lib/hostbundle');
  const files = hb.runtimeFiles();
  for (const [name, b64] of Object.entries(files)) {
    const src = Buffer.from(b64, 'base64').toString('utf8');
    for (const m of src.matchAll(/require\('\.\/([\w-]+)'\)/g)) assert.ok(files[m[1] + '.js'], `${name} needs ${m[1]}.js which is not in the bundle`);
  }
  assert.strictEqual(hb.parseSecret('# x\nsecret_key = "abcdef0123456789abcd"\n'), 'abcdef0123456789abcd');
  assert.strictEqual(hb.parseSecret('nothing'), '');
  assert.strictEqual(hb.findPlayitKey('  mykeymykeymykeymykey ', {}).key, 'mykeymykeymykeymykey');
});
