'use strict';
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { Readable } = require('stream');
const { pipeline } = require('stream/promises');

const IS_WIN = process.platform === 'win32';

function sendJSON(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}

function readBody(req, limit = 5 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0;
    req.on('data', c => {
      size += c.length;
      if (size > limit) { reject(new Error('Request body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function readJSONBody(req) {
  const buf = await readBody(req);
  if (!buf.length) return {};
  return JSON.parse(buf.toString('utf8'));
}

function readJSONFile(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

function writeJSONFile(file, data) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file);
}

/** Run a process and collect output. Never rejects; returns {code, stdout, stderr}. */
function run(cmd, args, opts = {}) {
  return new Promise(resolve => {
    let stdout = '', stderr = '';
    let p;
    try {
      p = spawn(cmd, args, { windowsHide: true, ...opts });
    } catch (e) { resolve({ code: -1, stdout, stderr: String(e.message) }); return; }
    p.stdout && p.stdout.on('data', d => { stdout += d; if (opts.onData) opts.onData(String(d)); });
    p.stderr && p.stderr.on('data', d => { stderr += d; if (opts.onData) opts.onData(String(d)); });
    p.on('error', e => resolve({ code: -1, stdout, stderr: stderr + e.message }));
    p.on('close', code => resolve({ code, stdout, stderr }));
  });
}

const UA = 'blockhost-dashboard/1.1 (local Minecraft server panel; github.com/nilanshpratapanand)';

async function fetchJSON(url, timeoutMs = 20000) {
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), headers: { 'User-Agent': UA } });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.json();
}

/** Download url -> dest, returns sha1 hex. onProgress(pct). */
async function download(url, dest, onProgress, headers) {
  const res = await fetch(url, { signal: AbortSignal.timeout(15 * 60 * 1000), headers: { 'User-Agent': UA, ...(headers || {}) }, redirect: 'follow' });
  if (!res.ok) throw new Error(res.status === 401 || res.status === 403 ? `Download refused (HTTP ${res.status}) - CurseForge needs a valid API key in Settings.` : `Download failed: HTTP ${res.status}`);
  const total = Number(res.headers.get('content-length')) || 0;
  const hash = crypto.createHash('sha1');
  let got = 0, lastPct = -1;
  const src = Readable.fromWeb(res.body);
  src.on('data', c => {
    hash.update(c); got += c.length;
    if (total && onProgress) { const pct = Math.floor(got * 100 / total); if (pct !== lastPct) { lastPct = pct; onProgress(pct); } }
  });
  await pipeline(src, fs.createWriteStream(dest));
  return hash.digest('hex');
}

/** Move a file, riding out Windows locks (antivirus scanning a fresh download, Explorer previews...).
 *  Retries EPERM/EBUSY/EACCES for ~6 s, then falls back to copy + delete. */
async function moveFile(src, dest) {
  let last;
  for (let i = 0; i < 12; i++) {
    try { await fsp.rename(src, dest); return; }
    catch (e) {
      last = e;
      if (e.code === 'EXDEV') break;
      if (!['EPERM', 'EBUSY', 'EACCES'].includes(e.code)) throw e;
      await new Promise(r => setTimeout(r, 250 + i * 200));
    }
  }
  try { await fsp.copyFile(src, dest); await fsp.rm(src, { force: true }); return; }
  catch (e) { const err = new Error(`Windows won't let Blockhost write ${path.basename(dest)} (${e.code || last && last.code}). It is probably open in Minecraft or being scanned by antivirus.`); err.code = 'LOCKED'; throw err; }
}

/** Resolve a user supplied relative path inside root; throws if it escapes. */
function safeJoin(root, rel) {
  const target = path.resolve(root, '.' + path.sep + String(rel || '').replace(/^[\\/]+/, ''));
  const r = path.resolve(root);
  if (target !== r && !target.startsWith(r + path.sep)) throw new Error('Path outside server folder');
  return target;
}

async function dirSize(dir) {
  let total = 0;
  let entries;
  try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { return 0; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    try {
      if (e.isDirectory()) total += await dirSize(p);
      else total += (await fsp.stat(p)).size;
    } catch { /* ignore */ }
  }
  return total;
}

/** Offline-mode UUID, same algorithm as the vanilla server (UUID v3 of "OfflinePlayer:<name>"). */
function offlineUUID(name) {
  const md5 = crypto.createHash('md5').update('OfflinePlayer:' + name, 'utf8').digest();
  md5[6] = (md5[6] & 0x0f) | 0x30;
  md5[8] = (md5[8] & 0x3f) | 0x80;
  const h = md5.toString('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

function stamp(d = new Date()) {
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}`;
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

module.exports = {
  moveFile, UA, IS_WIN, sendJSON, readBody, readJSONBody, readJSONFile, writeJSONFile, run, fetchJSON, download, safeJoin, dirSize, offlineUUID, stamp, sleep };
