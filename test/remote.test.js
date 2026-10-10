'use strict';
const test = require('node:test');
const assert = require('node:assert');

/** run the real Lease Durable Object class against an in-memory storage */
async function lease(ttl) {
  const { Lease } = await import('../dashboard/cloud/worker.js');
  const mem = new Map();
  const l = new Lease({ storage: { get: async k => mem.get(k), put: async (k, v) => { mem.set(k, JSON.parse(JSON.stringify(v))); } } }, { TTL_MS: ttl });
  return op => l.fetch({ json: async () => op }).then(r => r.json());
}
const hostA = { id: 'a', name: 'Aarav' };

test('worker: telemetry from the host is stored and peek returns only new lines', async () => {
  const L = await lease();
  const a = await L({ op: 'acquire', ...hostA });
  await L({ op: 'heartbeat', epoch: a.epoch, address: 'x.ply.gg', players: 2, phase: 'hosting',
    tele: { state: 'online', version: '26.3', startedAt: 5, players: ['Nil', 'Ash'], lines: [{ id: 1, t: 1, text: 'one', level: 'info' }, { id: 2, t: 2, text: 'two', level: 'info' }] } });
  let p = await L({ op: 'peek', since: 0 });
  assert.deepStrictEqual(p.tele.players, ['Nil', 'Ash']);
  assert.deepStrictEqual(p.tele.lines.map(l => l.text), ['one', 'two']);
  assert.strictEqual(p.tele.lastId, 2);
  await L({ op: 'heartbeat', epoch: a.epoch, tele: { state: 'online', players: ['Nil'], lines: [{ id: 2, t: 2, text: 'two', level: 'info' }, { id: 3, t: 3, text: 'three', level: 'chat' }] } });
  p = await L({ op: 'peek', since: 2 });
  assert.deepStrictEqual(p.tele.lines.map(l => l.text), ['three'], 'already stored lines are not duplicated');
  assert.deepStrictEqual(p.tele.players, ['Nil']);
});

test('worker: commands queue for the host, come back on its next heartbeat, then clear', async () => {
  const L = await lease();
  const none = await L({ op: 'cmd', text: 'say hi' });
  assert.strictEqual(none.ok, false); assert.strictEqual(none.reason, 'nobody');
  const a = await L({ op: 'acquire', ...hostA });
  assert.strictEqual((await L({ op: 'cmd', text: '  ' })).ok, false);
  await L({ op: 'cmd', text: 'say hello\nop evil' });
  await L({ op: 'cmd', kind: 'handoff' });
  const hb = await L({ op: 'heartbeat', epoch: a.epoch });
  assert.strictEqual(hb.cmds.length, 2);
  assert.strictEqual(hb.cmds[0].text, 'say hello op evil', 'newlines cannot smuggle a second command');
  assert.strictEqual(hb.cmds[1].kind, 'handoff');
  assert.strictEqual((await L({ op: 'heartbeat', epoch: a.epoch })).cmds.length, 0, 'delivered once');
});

test('worker: heartbeat tells the host to pulse fast only while the owner is watching', async () => {
  const L = await lease();
  const a = await L({ op: 'acquire', ...hostA });
  assert.strictEqual((await L({ op: 'heartbeat', epoch: a.epoch })).watch, false);
  await L({ op: 'peek' });
  assert.strictEqual((await L({ op: 'heartbeat', epoch: a.epoch })).watch, true);
});

test('worker: a new host starts with a clean slate, and release clears it', async () => {
  const L = await lease();
  const a = await L({ op: 'acquire', ...hostA });
  await L({ op: 'heartbeat', epoch: a.epoch, tele: { state: 'online', players: ['X'], lines: [{ id: 9, t: 1, text: 'old', level: 'info' }] } });
  await L({ op: 'cmd', text: 'say stale' });
  await L({ op: 'release', epoch: a.epoch });
  assert.strictEqual((await L({ op: 'peek' })).tele, null);
  const b = await L({ op: 'acquire', id: 'b', name: 'Bela' });
  const hb = await L({ op: 'heartbeat', epoch: b.epoch, tele: { state: 'starting', players: [], lines: [{ id: 1, t: 1, text: 'fresh', level: 'info' }] } });
  assert.strictEqual(hb.cmds.length, 0, 'the previous host\'s queued commands never reach the next host');
  assert.deepStrictEqual((await L({ op: 'peek' })).tele.lines.map(l => l.text), ['fresh'], 'line ids restart for each host');
});

test('worker: peek and cmd need the owner-only admin secret; friends with the group secret are refused', async () => {
  const { default: w } = await import('../dashboard/cloud/worker.js');
  const calls = [];
  const env = (extra = {}) => ({ GROUP_SECRET: 'groupsecret1', ...extra, LEASE: { idFromName: () => 'g', get: () => ({ fetch: async (u, i) => { calls.push(JSON.parse(i.body).op); return new Response('{"ok":true}'); } }) } });
  const call = (e, op, admin) => w.fetch(new Request('https://w/v1/lease', { method: 'POST', headers: { authorization: 'Bearer groupsecret1', ...(admin ? { 'x-admin': admin } : {}) }, body: JSON.stringify({ op }) }), e);
  assert.strictEqual((await call(env(), 'cmd', 'whatever')).status, 403, 'not enabled until the owner deploys an admin secret');
  assert.strictEqual((await call(env({ ADMIN_SECRET: 'adminsecret1' }), 'peek')).status, 403);
  assert.strictEqual((await call(env({ ADMIN_SECRET: 'adminsecret1' }), 'cmd', 'wrong')).status, 403);
  assert.deepStrictEqual(calls, [], 'refused calls never reach the lease');
  assert.strictEqual((await call(env({ ADMIN_SECRET: 'adminsecret1' }), 'peek', 'adminsecret1')).status, 200);
  assert.strictEqual((await call(env({ ADMIN_SECRET: 'adminsecret1' }), 'heartbeat')).status, 200, 'normal host calls need no admin secret');
});

// ---------------------------------------------------------------- host side (BatonHost) and owner side (RemoteWatch)
const { EventEmitter } = require('events');
const { BatonHost } = require('../dashboard/lib/batonhost');
const { RemoteWatch } = require('../dashboard/lib/remote');
const sleep = ms => new Promise(r => setTimeout(r, ms));

function fakeMc() {
  const mc = new EventEmitter();
  Object.assign(mc, { lines: [], state: 'online', runningVersion: '26.3', onlineAt: 1000, running: true, sent: [], players: new Map([['Nil', { name: 'Nil' }]]) });
  mc.playerList = () => [...mc.players.values()];
  mc.isRunning = () => mc.running;
  mc.send = c => mc.sent.push(c);
  mc.log = (text, level = 'info') => { const l = { id: mc.lines.length + 1, t: Date.now(), text, level }; mc.lines.push(l); return l; };
  return mc;
}

test('host: reports state and only new console lines, runs the owner\'s commands, and pulses fast only while watched', async () => {
  const mc = fakeMc(); mc.log('Done (3s)!'); mc.log('<Nil> hi', 'chat');
  const beats = []; let watch = false; let queue = [];
  const coord = { heartbeat: async (epoch, info) => { beats.push({ at: Date.now(), info }); const cmds = queue; queue = []; return { ok: true, watch, cmds }; } };
  const b = new BatonHost({ mc, dir: '/x', getConfig: () => ({}), saveConfig: () => {}, timing: { heartbeatMs: 300, fastBeatMs: 20 } });
  b.coord = coord; b.epoch = 7; b.phase = 'hosting';
  const handed = []; b.handoff = async r => { handed.push(r); };
  b.startHeartbeat();
  await sleep(60);
  assert.strictEqual(beats.length, 1, 'slow pulse while nobody is watching');
  assert.deepStrictEqual(beats[0].info.tele.players, ['Nil']);
  assert.strictEqual(beats[0].info.tele.state, 'online');
  assert.deepStrictEqual(beats[0].info.tele.lines.map(l => l.text), ['Done (3s)!', '<Nil> hi']);
  watch = true; queue = [{ id: 1, kind: 'cmd', text: 'say hello' }];
  await sleep(330);                                   // the next slow beat learns it is being watched and receives the command
  assert.deepStrictEqual(mc.sent, ['say hello']);
  assert.ok(!beats[1].info.tele.lines.length, 'lines already reported are not sent again');
  mc.log('new line');
  const n = beats.length; await sleep(120);
  assert.ok(beats.length - n >= 3, 'fast pulse while watched (' + (beats.length - n) + ' beats in 120 ms)');
  assert.ok(beats.some(x => x.info.tele.lines.some(l => l.text === 'new line')));
  queue = [{ id: 2, kind: 'cmd', text: 'stop' }]; await sleep(60);
  assert.deepStrictEqual(handed, ['the owner asked'], '"stop" saves and hands off instead of just killing the server');
  queue = [{ id: 3, kind: 'handoff', text: '' }]; await sleep(60);
  assert.strictEqual(handed.length, 2);
  b.clearTimers();
  const after = beats.length; await sleep(80);
  assert.strictEqual(beats.length, after, 'no pulses after the baton is returned');
});

test('host: restarting the heartbeat (hand-off) never leaves two pulse loops running', async () => {
  const mc = fakeMc(); let n = 0;
  const b = new BatonHost({ mc, dir: '/x', getConfig: () => ({}), saveConfig: () => {}, timing: { heartbeatMs: 30, fastBeatMs: 30 } });
  b.coord = { heartbeat: async () => { n++; return { ok: true }; } }; b.epoch = 1;
  b.startHeartbeat(); await sleep(5); b.clearTimers(); b.startHeartbeat();
  await sleep(300); b.clearTimers();
  assert.ok(n <= 12, 'about one beat per 30 ms, not double (' + n + ')');
});

function ownerRig({ admin = 'adm', remoteState } = {}) {
  const mc = fakeMc(); mc.running = false; mc.lines = [];
  const logs = []; mc.log = (t, l) => logs.push([t, l]);
  const calls = [];
  const coord = {
    peek: async since => { calls.push(['peek', since]); if (coord.denied) throw Object.assign(new Error('Remote control is not switched on in your cloud yet - press "Update cloud".'), { admin: 'admin-not-enabled' }); return coord.next; },
    status: async () => { calls.push(['status']); return coord.next; },
    command: async (text, kind) => { calls.push(['command', text, kind]); return { ok: true }; },
  };
  const baton = { phase: 'off', configured: () => true, ensure: () => coord, cfg: () => ({ batonAdmin: admin }), ident: () => ({ id: 'me', name: 'Owner' }) };
  let watched = true;
  const w = new RemoteWatch({ baton, mc, watched: () => watched });
  const views = []; w.on('update', v => views.push(v));
  return { w, mc, logs, calls, coord, baton, views, setWatched: v => { watched = v; } };
}
const hosted = (extra = {}) => ({ state: 'hosted', epoch: 4, host: { id: 'f1', name: 'Aarav', address: 'x.ply.gg', players: 1, since: 5, phase: 'hosting' }, tele: { state: 'online', version: '26.3', players: ['Nil'], lastId: 2, lines: [{ id: 1, t: 1, text: 'Done', level: 'info' }, { id: 2, t: 2, text: '<Nil> hi', level: 'chat' }] }, ...extra });

test('owner: mirrors a friend-hosted server into the console and the player list, once', async () => {
  const r = ownerRig(); r.coord.next = hosted();
  await r.w.poll();
  assert.strictEqual(r.w.view().on, true);
  assert.strictEqual(r.w.view().state, 'online');
  assert.deepStrictEqual(r.w.view().players, ['Nil']);
  assert.deepStrictEqual(r.logs.map(l => l[0]), ["Connected to Aarav's server (it is running on their PC).", 'Done', '<Nil> hi']);
  await r.w.poll();                                    // same data again: nothing is duplicated
  assert.strictEqual(r.logs.length, 3);
  assert.deepStrictEqual(r.calls[1], ['peek', 2], 'asks only for lines after the last one it has');
  assert.strictEqual(r.views.length, 1, 'only changes are published');
  r.coord.next = { state: 'free', epoch: 4, host: null };
  await r.w.poll();
  assert.strictEqual(r.w.view().on, false);
  assert.match(r.logs[r.logs.length - 1][0], /no longer running/);
});

test('owner: commands and hand-off are queued through the cloud', async () => {
  const r = ownerRig(); r.coord.next = hosted(); await r.w.poll();
  await r.w.command('op Nil'); await r.w.handoff();
  assert.deepStrictEqual(r.calls.filter(c => c[0] === 'command'), [['command', 'op Nil', 'cmd'], ['command', '', 'handoff']]);
});

test('owner: not watching -> plain status (does not make the friend\'s PC pulse fast); nothing to control without a friend hosting', async () => {
  const r = ownerRig(); r.setWatched(false); r.coord.next = hosted(); await r.w.poll();
  assert.strictEqual(r.calls[0][0], 'status');
  await assert.rejects(ownerRig().w.command('say x'), /Nobody else is hosting/);
});

test('owner: cloud not updated yet -> falls back to status and says how to fix it', async () => {
  const r = ownerRig(); r.coord.denied = true; r.coord.next = hosted({ tele: undefined }); await r.w.poll();
  const v = r.w.view();
  assert.strictEqual(v.on, true); assert.strictEqual(v.needsUpdate, true); assert.strictEqual(v.control, false);
  await assert.rejects(r.w.command('say x'), /Update cloud/);
});

test('owner: nothing is mirrored while this PC hosts or runs the server itself', async () => {
  const r = ownerRig(); r.coord.next = hosted(); r.baton.phase = 'hosting'; await r.w.poll();
  assert.strictEqual(r.w.view().on, false); assert.strictEqual(r.calls.length, 0);
  r.baton.phase = 'off'; r.mc.running = true; await r.w.poll();
  assert.strictEqual(r.w.view().on, false);
  r.mc.running = false; r.coord.next = hosted({ host: { id: 'me', name: 'Owner', players: 0, phase: 'hosting' } }); await r.w.poll();
  assert.strictEqual(r.w.view().on, false, 'a server this PC itself holds is not "someone else\'s"');
});

// ---------------------------------------------------------------- Op Guard travels with the host
const fs = require('fs'), os = require('os'), path = require('path');
const { Sync, sha256 } = require('../dashboard/lib/baton');

test('guard: ops.json never reaches the cloud with names in it', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bh-ops-'));
  fs.mkdirSync(path.join(dir, 'world')); fs.writeFileSync(path.join(dir, 'world', 'level.dat'), 'x');
  fs.writeFileSync(path.join(dir, 'ops.json'), JSON.stringify([{ uuid: 'u', name: 'Nil', level: 4 }]));
  const on = new Sync({ dir, coord: {}, worldName: () => 'world', opsGuard: () => true, stateFile: path.join(dir, 's.json') });
  assert.strictEqual(on.scan(null).files['ops.json'].sha, sha256(Buffer.from('[]\n')));
  const off = new Sync({ dir, coord: {}, worldName: () => 'world', opsGuard: () => false, stateFile: path.join(dir, 's2.json') });
  assert.notStrictEqual(off.scan(null).files['ops.json'].sha, sha256(Buffer.from('[]\n')), 'guard off -> unchanged behaviour');
});

test('guard: an op the owner grants lasts only while that player is online, and is wiped from the friend\'s PC', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bh-guard-'));
  const mc = fakeMc(); const quiet = []; mc.sendQuiet = c => quiet.push(c);
  const b = new BatonHost({ mc, dir, getConfig: () => ({}), saveConfig: () => {}, hostGuard: true });
  fs.writeFileSync(path.join(dir, 'ops.json'), JSON.stringify([{ name: 'Nil' }, { name: 'Imposter' }]));
  b.runRemote({ kind: 'cmd', text: 'op Nil' });
  assert.deepStrictEqual(mc.sent, ['op Nil']);
  mc.emit('join', 'Nil'); assert.deepStrictEqual(quiet, [], 'the granted player keeps op while online');
  mc.emit('join', 'Imposter'); assert.deepStrictEqual(quiet, ['deop Imposter'], 'anyone opped without a grant is de-opped on join');
  mc.emit('leave', 'Nil'); assert.deepStrictEqual(quiet, ['deop Imposter', 'deop Nil'], 'op ends when the player leaves');
  b.scrubOps(); assert.strictEqual(fs.readFileSync(path.join(dir, 'ops.json'), 'utf8'), '[]\n');
});

test('guard: off means off (owner turned Op Guard off)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bh-guard-'));
  const mc = fakeMc(); const quiet = []; mc.sendQuiet = c => quiet.push(c);
  const b = new BatonHost({ mc, dir, getConfig: () => ({ opGuard: false }), saveConfig: () => {}, hostGuard: true });
  fs.writeFileSync(path.join(dir, 'ops.json'), JSON.stringify([{ name: 'Nil' }]));
  mc.emit('join', 'Nil'); mc.emit('leave', 'Nil'); b.scrubOps();
  assert.deepStrictEqual(quiet, []); assert.match(fs.readFileSync(path.join(dir, 'ops.json'), 'utf8'), /Nil/);
});
