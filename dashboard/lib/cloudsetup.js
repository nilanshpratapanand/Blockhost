'use strict';
// One-button Cloud Host setup: logs in to Cloudflare, deploys the coordinator Worker and stores the group secret,
// by driving Wrangler (Cloudflare's official CLI) from the right folder so the user never types a command.
// Flags used are the documented ones: `wrangler deploy --config --secrets-file`, `wrangler whoami`, `wrangler login`.
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

const IS_WIN = process.platform === 'win32';
const ENV = { WRANGLER_SEND_METRICS: 'false', WRANGLER_SEND_ERROR_REPORTS: 'false', NO_COLOR: '1', FORCE_COLOR: '0' };

const stripAnsi = s => String(s || '').replace(/\u001b\[[0-9;?]*[A-Za-z]/g, '').replace(/\r/g, '');

/** Run a command, collect output, call onLine for each line. Resolves {code, out}. */
function run(cmd, args, { cwd, env, timeoutMs = 180000, onLine } = {}) {
  return new Promise(resolve => {
    let out = '', done = false, buf = '';
    let p;
    try { p = spawn(cmd, args, { cwd, env: { ...process.env, ...ENV, ...(env || {}) }, shell: IS_WIN, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }); }
    catch (e) { return resolve({ code: -1, out: String(e.message) }); }
    const finish = (code, extra) => { if (done) return; done = true; clearTimeout(t); resolve({ code, out: stripAnsi(out + (extra || '')) }); };
    const t = setTimeout(() => { try { p.kill(); } catch { /* gone */ } finish(-2, '\n[timed out]'); }, timeoutMs);
    const feed = d => {
      const s = d.toString(); out += s; buf += s;
      const lines = buf.split('\n'); buf = lines.pop();
      if (onLine) for (const l of lines) { const c = stripAnsi(l).trim(); if (c) onLine(c); }
    };
    p.stdout.on('data', feed); p.stderr.on('data', feed);
    p.on('error', e => finish(-1, '\n' + e.message));
    p.on('close', code => finish(code));
  });
}

/** `wrangler whoami` text -> { loggedIn, accounts: [{name, id}] } */
function parseWhoami(text) {
  const t = stripAnsi(text);
  if (/not authenticated|not logged in|You are not/i.test(t)) return { loggedIn: false, accounts: [] };
  const accounts = [];
  for (const m of t.matchAll(/│?\s*([^│\n]+?)\s*│\s*([0-9a-f]{32})\s*│?/gi)) accounts.push({ name: m[1].trim(), id: m[2].toLowerCase() });
  const loggedIn = accounts.length > 0 || /logged in|associated with the email|OAuth Token/i.test(t);
  return { loggedIn, accounts };
}
/** First workers.dev address printed by `wrangler deploy`. */
function parseDeployUrl(text) { const m = stripAnsi(text).match(/https:\/\/[a-z0-9][a-z0-9-]*(?:\.[a-z0-9-]+)*\.workers\.dev/i); return m ? m[0].toLowerCase() : null; }

/** Turn Wrangler's failure text into something a person can act on. */
function explain(text) {
  const t = stripAnsi(text);
  if (/more than one account/i.test(t)) return { code: 'ACCOUNT', message: 'Your Cloudflare login has more than one account. Pick one in the box and try again.' };
  if (/workers\.dev subdomain|register.*subdomain|subdomain.*(not|register)/i.test(t)) return { code: 'SUBDOMAIN', message: 'Cloudflare needs you to pick a free workers.dev name once. Open https://dash.cloudflare.com/?to=/:account/workers/onboarding , choose any name, then press the button again.' };
  if (/not authenticated|not logged in|login/i.test(t) && /error/i.test(t)) return { code: 'LOGIN', message: 'Cloudflare login did not finish. Press the button again and approve it in the browser tab that opens.' };
  if (/ENOTFOUND|ECONNREFUSED|ETIMEDOUT|fetch failed|network/i.test(t)) return { code: 'NET', message: 'Could not reach Cloudflare. Check your internet connection and try again.' };
  if (/'npx' is not recognized|npx: command not found|ENOENT/i.test(t)) return { code: 'NODE', message: 'Node.js with npx was not found. Install Node.js from nodejs.org, then try again.' };
  const err = t.split('\n').map(l => l.trim()).filter(l => /error/i.test(l)).slice(0, 3).join(' ').slice(0, 300);
  return { code: 'WRANGLER', message: 'Cloudflare setup failed' + (err ? ': ' + err : '.') };
}
const fail = (info, raw) => Object.assign(new Error(info.message), { code: info.code, raw });

/**
 * opts: { cloudDir, log(msg,pct), accountId?, run? (injectable for tests), sleep? }
 * Resolves { url, secret, account }.
 */
async function setup(opts) {
  const { cloudDir, log = () => {}, accountId } = opts;
  const exec = opts.run || run;
  const sleep = opts.sleep || (ms => new Promise(r => setTimeout(r, ms)));
  const W = ['--yes', 'wrangler@4'];
  const wr = (args, o = {}) => exec('npx', [...W, ...args], { cwd: cloudDir, ...o });

  log('Checking Wrangler (Cloudflare\'s official tool)...', 5);
  const v = await wr(['--version'], { timeoutMs: 240000 });
  if (v.code !== 0) throw fail(explain(v.out), v.out);

  log('Checking your Cloudflare login...', 15);
  let who = await wr(['whoami']);
  let info = parseWhoami(who.out);
  if (!info.loggedIn) {
    log('A browser tab opens - press Allow to let Blockhost use your Cloudflare account.', 20);
    const l = await wr(['login'], { timeoutMs: 240000 });
    if (l.code !== 0) throw fail({ code: 'LOGIN', message: 'Cloudflare login did not finish. Press the button again and approve it in the browser tab that opens.' }, l.out);
    who = await wr(['whoami']); info = parseWhoami(who.out);
    if (!info.loggedIn) throw fail({ code: 'LOGIN', message: 'Still not logged in to Cloudflare - try again.' }, who.out);
  }
  let account = accountId || '';
  if (!account) {
    if (info.accounts.length === 1) account = info.accounts[0].id;
    else if (info.accounts.length > 1) { const e = fail({ code: 'ACCOUNT', message: 'Your Cloudflare login has more than one account. Pick one and try again.' }); e.accounts = info.accounts; throw e; }
  }
  const env = account ? { CLOUDFLARE_ACCOUNT_ID: account } : {};

  const secret = crypto.randomBytes(24).toString('base64url');
  const sf = path.join(os.tmpdir(), `bh-secret-${crypto.randomBytes(6).toString('hex')}.json`);
  fs.writeFileSync(sf, JSON.stringify({ GROUP_SECRET: secret }), { mode: 0o600 });
  let dep;
  try {
    log('Deploying your private coordinator to Cloudflare (free plan)...', 45);
    dep = await wr(['deploy', '--config', 'wrangler.toml', '--secrets-file', sf], { env, timeoutMs: 240000, onLine: l => { if (/uploaded|deployed|current version|workers\.dev/i.test(l)) log(l.slice(0, 120)); } });
  } finally { try { fs.rmSync(sf, { force: true }); } catch { /* temp file */ } }
  if (dep.code !== 0) throw fail(explain(dep.out), dep.out);
  const url = parseDeployUrl(dep.out);
  if (!url) throw fail({ code: 'WRANGLER', message: 'Deployed, but Cloudflare did not print the worker address. Open the Cloudflare dashboard > Workers to copy it, then use "Advanced".' }, dep.out);

  log('Waiting for it to come online...', 80);
  const f = opts.fetch || fetch;
  let ok = false, last = '';
  for (let i = 0; i < 20 && !ok; i++) {
    try { const r = await f(`${url}/?k=${encodeURIComponent(secret)}`); if (r.status === 200) ok = true; else last = 'HTTP ' + r.status; } catch (e) { last = e.message; }
    if (!ok) await sleep(2000);
  }
  if (!ok) throw fail({ code: 'WAIT', message: `Deployed to ${url} but it did not answer yet (${last}). Wait a minute and press "Test connection".` });
  return { url, secret, account };
}

module.exports = { setup, run, parseWhoami, parseDeployUrl, explain };
