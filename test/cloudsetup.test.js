'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const { setup, parseWhoami, parseDeployUrl, explain } = require('../dashboard/lib/cloudsetup');

const WHO_OK = ` ⛅️ wrangler 4.149.0
👋 You are logged in with an OAuth Token, associated with the email a@b.com.
┌──────────────┬──────────────────────────────────┐
│ Account Name │ Account ID                       │
├──────────────┼──────────────────────────────────┤
│ Nil's Account│ 0123456789abcdef0123456789abcdef │
└──────────────┴──────────────────────────────────┘`;
const WHO_NO = 'You are not authenticated. Please run `wrangler login`.';
const DEPLOY = 'Uploaded blockhost-baton (2.1 sec)\nDeployed blockhost-baton triggers (0.5 sec)\n  https://blockhost-baton.nil.workers.dev\nCurrent Version ID: abc';

test('parseWhoami reads accounts and the logged-out state', () => {
  assert.deepStrictEqual(parseWhoami(WHO_OK), { loggedIn: true, accounts: [{ name: "Nil's Account", id: '0123456789abcdef0123456789abcdef' }] });
  assert.strictEqual(parseWhoami(WHO_NO).loggedIn, false);
});
test('parseDeployUrl finds the workers.dev address', () => {
  assert.strictEqual(parseDeployUrl(DEPLOY), 'https://blockhost-baton.nil.workers.dev');
  assert.strictEqual(parseDeployUrl('nothing here'), null);
});
test('explain turns Wrangler failures into plain advice', () => {
  assert.strictEqual(explain('X [ERROR] More than one account available').code, 'ACCOUNT');
  assert.strictEqual(explain('You need to register a workers.dev subdomain before publishing').code, 'SUBDOMAIN');
  assert.strictEqual(explain("'npx' is not recognized as an internal command").code, 'NODE');
  assert.strictEqual(explain('fetch failed ENOTFOUND api.cloudflare.com').code, 'NET');
});

function fakeRun({ loggedIn = true, deployOut = DEPLOY, deployCode = 0 } = {}) {
  const calls = []; let logged = loggedIn;
  const run = async (cmd, args, o = {}) => {
    const a = args.slice(2); calls.push({ a, env: o.env, secretFile: a.includes('--secrets-file') ? JSON.parse(fs.readFileSync(a[a.indexOf('--secrets-file') + 1], 'utf8')) : null });
    if (a[0] === '--version') return { code: 0, out: '4.149.0' };
    if (a[0] === 'whoami') return { code: 0, out: logged ? WHO_OK : WHO_NO };
    if (a[0] === 'login') { logged = true; return { code: 0, out: 'Successfully logged in.' }; }
    if (a[0] === 'deploy') return { code: deployCode, out: deployOut };
    return { code: 1, out: 'unexpected' };
  };
  return { run, calls };
}
const okFetch = async () => ({ status: 200, json: async () => ({ state: 'free' }) });
const noSleep = async () => {};

test('setup: already logged in -> deploys with a fresh secret file, returns url and secret', async () => {
  const f = fakeRun();
  const r = await setup({ cloudDir: '/x', run: f.run, fetch: okFetch, sleep: noSleep });
  assert.strictEqual(r.url, 'https://blockhost-baton.nil.workers.dev');
  const dep = f.calls.find(c => c.a[0] === 'deploy');
  assert.strictEqual(dep.secretFile.GROUP_SECRET, r.secret);
  assert.ok(r.secret.length >= 24);
  assert.strictEqual(dep.env.CLOUDFLARE_ACCOUNT_ID, '0123456789abcdef0123456789abcdef');
  assert.ok(!f.calls.some(c => c.a[0] === 'login'));
});
test('setup: not logged in -> runs login first', async () => {
  const f = fakeRun({ loggedIn: false });
  await setup({ cloudDir: '/x', run: f.run, fetch: okFetch, sleep: noSleep });
  assert.deepStrictEqual(f.calls.map(c => c.a[0]).filter(x => ['whoami', 'login', 'deploy'].includes(x)), ['whoami', 'login', 'whoami', 'deploy']);
});
test('setup: the secret file is deleted afterwards', async () => {
  const f = fakeRun(); let path;
  const run = async (c, a, o) => { if (a.includes('--secrets-file')) path = a[a.indexOf('--secrets-file') + 1]; return f.run(c, a, o); };
  await setup({ cloudDir: '/x', run, fetch: okFetch, sleep: noSleep });
  assert.ok(path && !fs.existsSync(path));
});
test('setup: deploy failure carries a readable code', async () => {
  const f = fakeRun({ deployCode: 1, deployOut: 'X [ERROR] You need to register a workers.dev subdomain' });
  await assert.rejects(setup({ cloudDir: '/x', run: f.run, fetch: okFetch, sleep: noSleep }), e => e.code === 'SUBDOMAIN');
});
test('setup: waits until the worker answers', async () => {
  let n = 0; const f = fakeRun();
  const r = await setup({ cloudDir: '/x', run: f.run, sleep: noSleep, fetch: async () => ({ status: ++n < 3 ? 404 : 200, json: async () => ({ state: 'free' }) }) });
  assert.ok(r.url && n === 5);
});

test('setup: if the secret never arrives with the deploy, it is set directly and verified', async () => {
  const f = fakeRun(); let secretSet = null, n = 0;
  const run = async (c, a, o) => { if (a.includes('secret')) { secretSet = o.input.trim(); return { code: 0, out: 'Success' }; } return f.run(c, a, o); };
  const fetchSecret = async (u, i) => { n++; return secretSet && i.headers.authorization === 'Bearer ' + secretSet ? { status: 200, json: async () => ({ state: 'free' }) } : { status: 401, json: async () => ({}) }; };
  const r = await setup({ cloudDir: '/x', run, fetch: fetchSecret, sleep: noSleep });
  assert.strictEqual(secretSet, r.secret);
});
test('setup: a 200 page that is not the coordinator is not accepted', async () => {
  const f = fakeRun();
  await assert.rejects(setup({ cloudDir: '/x', run: f.run, sleep: noSleep, fetch: async () => ({ status: 200, json: async () => ({}) }) }), e => e.code === 'WAIT');
});

test('setup: redeploy keeps the group secret and ships the owner-only admin secret', async () => {
  const f = fakeRun();
  const r = await setup({ cloudDir: '/x', run: f.run, fetch: okFetch, sleep: noSleep, secret: 'existing-group-secret-123', adminSecret: 'admin-secret-abcdef' });
  const dep = f.calls.find(c => c.a[0] === 'deploy');
  assert.strictEqual(r.secret, 'existing-group-secret-123');
  assert.deepStrictEqual(dep.secretFile, { GROUP_SECRET: 'existing-group-secret-123', ADMIN_SECRET: 'admin-secret-abcdef' });
});
test('setup: with an admin secret, "ready" waits until the owner-only door answers', async () => {
  const f = fakeRun(); let adminTries = 0;
  const fetchImpl = async (u, i) => {
    const body = JSON.parse(i.body);
    if (body.op === 'peek') { adminTries++; return { status: adminTries < 4 ? 403 : 200, json: async () => ({ state: 'free' }) }; }
    return { status: 200, json: async () => ({ state: 'free' }) };
  };
  await setup({ cloudDir: '/x', run: f.run, fetch: fetchImpl, sleep: noSleep, secret: 'existing-group-secret-123', adminSecret: 'admin-secret-abcdef' });
  assert.ok(adminTries >= 6, 'kept probing until three answers in a row succeeded (' + adminTries + ')');
});
