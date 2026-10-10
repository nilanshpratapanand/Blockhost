'use strict';
// Baton Host: coordinator client + world sync engine.
// The world is stored as content-addressed blobs plus a manifest in free cloud storage. Only the lease holder may write.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

/** server.properties keys that belong to one PC and must never travel between hosts */
const LOCAL_PROP_KEYS = new Set(['server-port', 'server-ip', 'query.port', 'rcon.port', 'rcon.password', 'enable-rcon',
  'management-server-secret', 'management-server-port', 'management-server-host', 'management-server-enabled',
  'management-server-tls-enabled', 'management-server-tls-keystore', 'management-server-tls-keystore-password',
  'management-server-allowed-origins', 'enable-jmx-monitoring', 'max-players']);
const INCLUDE_FILES = ['server.jar', 'eula.txt', 'server.properties', 'ops.json', 'whitelist.json', 'banned-players.json', 'banned-ips.json', 'server-icon.png', 'usercache.json'];
const SKIP = /(^|\/)(session\.lock|[^/]*\.tmp|[^/]*\.baton-part)$/;

const CHUNK = 4 * 1024 * 1024;   // big files are stored as 4 MB pieces: small requests, and only the changed pieces re-upload
const sha256 = buf => crypto.createHash('sha256').update(buf).digest('hex');
const sleep = ms => new Promise(r => setTimeout(r, ms));
/** whole-file hash plus piece hashes for big files */
function hashBuf(buf) {
  const ent = { size: buf.length, sha: sha256(buf) };
  if (buf.length > CHUNK) { ent.chunks = []; for (let o = 0; o < buf.length; o += CHUNK) ent.chunks.push(sha256(buf.subarray(o, o + CHUNK))); }
  return ent;
}
const posix = p => p.split(path.sep).join('/');

// ------------------------------------------------------------------ group code
function encodeCode(url, secret) { return 'bh1.' + Buffer.from(JSON.stringify({ u: url.replace(/\/+$/, ''), s: secret })).toString('base64url'); }
function decodeCode(code) {
  const m = String(code || '').trim().match(/^bh1\.([A-Za-z0-9_-]+)$/);
  if (!m) throw new Error('That does not look like a Blockhost group code (it starts with bh1.)');
  let o; try { o = JSON.parse(Buffer.from(m[1], 'base64url').toString('utf8')); } catch { throw new Error('The group code is damaged - copy it again.'); }
  if (!/^https:\/\/[^\s/]+/i.test(o.u || '') && !/^http:\/\/(localhost|127\.0\.0\.1)/i.test(o.u || '')) throw new Error('The group code has no valid address.');
  if (!o.s || String(o.s).length < 8) throw new Error('The group code has no secret.');
  return { url: o.u, secret: o.s };
}

// ------------------------------------------------------------------ coordinator client
class Coord {
  constructor({ url, secret, fetchImpl, retries = 3 }) { this.url = url.replace(/\/+$/, ''); this.secret = secret; this.f = fetchImpl || ((u, i) => fetch(u, i)); this.retries = retries; }
  async req(method, p, { body, epoch, raw } = {}) {
    let last;
    for (let i = 0; i <= this.retries; i++) {
      try {
        const headers = { authorization: 'Bearer ' + this.secret };
        if (epoch) headers['x-epoch'] = String(epoch);
        if (body !== undefined && !Buffer.isBuffer(body)) headers['content-type'] = 'application/json';
        const r = await this.f(this.url + p, { method, headers, body: body === undefined ? undefined : (Buffer.isBuffer(body) ? body : JSON.stringify(body)) });
        if (r.status === 401) throw Object.assign(new Error('The group secret was rejected - ask the owner for a fresh group code.'), { fatal: true });
        if (r.status === 409) throw Object.assign(new Error('You no longer hold the host baton.'), { fatal: true, lost: true });
        if (r.status >= 500) throw new Error('Coordinator error ' + r.status);
        if (raw) return r;
        const text = await r.text(); let j; try { j = JSON.parse(text); } catch { j = { error: text.slice(0, 100) }; }
        if (r.status >= 400) throw Object.assign(new Error(j.error || 'Request failed (' + r.status + ')'), { fatal: r.status < 500 });
        return j;
      } catch (e) {
        last = e; if (e.fatal) throw e;
        if (i < this.retries) await sleep(400 * 2 ** i);
      }
    }
    throw new Error('Cannot reach the coordinator: ' + (last && last.message));
  }
  lease(op, extra = {}) { return this.req('POST', '/v1/lease', { body: { op, ...extra } }); }
  status() { return this.lease('status'); }
  acquire(id, name, ramGB) { return this.lease('acquire', { id, name, ramGB }); }
  heartbeat(epoch, info) { return this.lease('heartbeat', { epoch, ...info }); }
  release(epoch) { return this.lease('release', { epoch }); }
  request(name) { return this.lease('request', { name }); }
  getManifest() { return this.req('GET', '/v1/manifest'); }
  putManifest(epoch, m) { return this.req('PUT', '/v1/manifest', { body: Buffer.from(JSON.stringify(m)), epoch }); }
  async hasBlob(sha) { const r = await this.req('HEAD', '/v1/blob/' + sha, { raw: true }).catch(() => ({ status: 0 })); return r.status === 200; }
  putBlob(epoch, sha, buf) { return this.req('PUT', '/v1/blob/' + sha, { body: buf, epoch }); }
  async getBlob(sha) {
    const r = await this.req('GET', '/v1/blob/' + sha, { raw: true });
    if (r.status !== 200) throw new Error('A world file is missing from the cloud (' + sha.slice(0, 8) + ')');
    return Buffer.from(await r.arrayBuffer());
  }
  gc(epoch) { return this.req('POST', '/v1/gc', { epoch }); }
}

// ------------------------------------------------------------------ server.properties handling
function stripProps(text) {
  return text.split(/\r?\n/).filter(l => {
    if (!l.trim() || /^#/.test(l)) return false;                       // the timestamp comment changes on every save
    const m = l.match(/^\s*([^#!][^=]*?)\s*=/);
    return !(m && LOCAL_PROP_KEYS.has(m[1]));
  }).join('\n');
}
function mergeProps(remoteText, localText) {
  const local = {};
  for (const l of String(localText || '').split(/\r?\n/)) { const m = l.match(/^\s*([^#!][^=]*?)\s*=(.*)$/); if (m && LOCAL_PROP_KEYS.has(m[1])) local[m[1]] = m[2]; }
  const lines = remoteText.split(/\r?\n/).filter(l => l.trim());
  const seen = new Set();
  const out = lines.map(l => { const m = l.match(/^\s*([^#!][^=]*?)\s*=/); if (m && Object.prototype.hasOwnProperty.call(local, m[1])) { seen.add(m[1]); return m[1] + '=' + local[m[1]]; } return l; });
  for (const k of Object.keys(local)) if (!seen.has(k)) out.push(k + '=' + local[k]);
  return out.join('\n').replace(/\n+$/, '') + '\n';
}

// ------------------------------------------------------------------ sync engine
class Sync {
  /** opts: {dir, coord, stateFile, log, worldName() } */
  constructor(opts) {
    this.dir = opts.dir; this.coord = opts.coord; this.log = opts.log || (() => {}); this.worldName = opts.worldName || (() => 'world');
    this.stateFile = opts.stateFile || path.join(opts.dir, 'dashboard', 'baton-state.json');
    this.stageDir = path.join(opts.dir, '.baton-stage'); this.trashRoot = path.join(opts.dir, '.baton-trash');
    this.state = { lastVersion: 0, cache: {} };
    try { Object.assign(this.state, JSON.parse(fs.readFileSync(this.stateFile, 'utf8'))); } catch { /* first run */ }
  }
  saveState() { try { fs.mkdirSync(path.dirname(this.stateFile), { recursive: true }); const t = this.stateFile + '.tmp'; fs.writeFileSync(t, JSON.stringify(this.state)); fs.renameSync(t, this.stateFile); } catch (e) { this.log('Could not save sync state: ' + e.message); } }

  /** every file that belongs to the synced world, relative posix paths */
  list() {
    const out = [];
    const walk = (abs, rel) => {
      let ents; try { ents = fs.readdirSync(abs, { withFileTypes: true }); } catch { return; }
      for (const e of ents) {
        const r = rel + '/' + e.name;
        if (SKIP.test(r)) continue;
        if (e.isDirectory()) walk(path.join(abs, e.name), r);
        else if (e.isFile()) out.push(r.slice(1));
      }
    };
    walk(path.join(this.dir, this.worldName()), '/' + this.worldName());
    for (const f of INCLUDE_FILES) if (fs.existsSync(path.join(this.dir, f))) out.push(f);
    return out;
  }
  inScope(rel) {
    if (SKIP.test('/' + rel)) return false;
    if (rel.startsWith(this.worldName() + '/')) return true;
    return INCLUDE_FILES.includes(rel);
  }

  /** hash everything (using the stat cache); optionally stage copies of blobs the cloud lacks */
  scan(remoteShas) {
    const files = {}, cache = {}; let staged = 0;
    for (const rel of this.list()) {
      const abs = path.join(this.dir, rel);
      let st; try { st = fs.statSync(abs); } catch { continue; }
      let ent = this.state.cache[rel];
      let buf = null;
      if (rel === 'server.properties') {
        buf = Buffer.from(stripProps(fs.readFileSync(abs, 'utf8')) + '\n');
        ent = { ...hashBuf(buf), mtimeMs: st.mtimeMs };
      } else if (!ent || ent.size !== st.size || ent.mtimeMs !== st.mtimeMs) {
        try { buf = fs.readFileSync(abs); } catch { continue; }
        ent = { ...hashBuf(buf), mtimeMs: st.mtimeMs };
      }
      cache[rel] = ent;
      const pieces = ent.chunks || [ent.sha];
      if (remoteShas && pieces.some(x => !remoteShas.has(x))) {
        if (!buf) {
          try { buf = fs.readFileSync(abs); } catch { continue; }
          const again = hashBuf(buf);
          if (again.sha !== ent.sha) { ent = cache[rel] = { ...again, mtimeMs: st.mtimeMs }; }   // changed since the last scan
        }
        const ps = ent.chunks || [ent.sha];
        fs.mkdirSync(this.stageDir, { recursive: true });
        ps.forEach((x, i) => {
          if (remoteShas.has(x)) return;
          const sp = path.join(this.stageDir, x);
          if (!fs.existsSync(sp)) { fs.writeFileSync(sp, ent.chunks ? buf.subarray(i * CHUNK, (i + 1) * CHUNK) : buf); staged++; }
        });
      }
      files[rel] = { sha: ent.sha, size: ent.size, mtime: Math.round(st.mtimeMs) };
      if (ent.chunks) files[rel].chunks = ent.chunks;
    }
    this.state.cache = cache;
    return { files, staged };
  }

  /** step 1 of a push: take a consistent copy of what changed. Call while the server is frozen (save-off). */
  async prepare(known) {
    const remote = known || await this.coord.getManifest();
    const have = new Set(); for (const f of Object.values(remote.files || {})) for (const x of (f.chunks || [f.sha])) have.add(x);
    fs.rmSync(this.stageDir, { recursive: true, force: true });
    const { files, staged } = this.scan(have);
    return { remote, files, staged };
  }
  /** step 2: upload the staged blobs, then publish the manifest (the commit point) */
  async commit(epoch, prep, who, onProgress) {
    const need = [...new Set(Object.values(prep.files).flatMap(f => f.chunks || [f.sha]))].filter(sha => fs.existsSync(path.join(this.stageDir, sha)));
    let done = 0, bytes = 0;
    const q = need.slice();
    const worker = async () => {
      while (q.length) {
        const sha = q.shift();
        const buf = fs.readFileSync(path.join(this.stageDir, sha));
        await this.coord.putBlob(epoch, sha, buf);
        bytes += buf.length; done++;
        if (onProgress) onProgress({ phase: 'upload', done, total: need.length, bytes });
      }
    };
    await Promise.all([worker(), worker(), worker(), worker()]);
    const same = prep.remote.files && Object.keys(prep.remote.files).length === Object.keys(prep.files).length &&
      Object.entries(prep.files).every(([k, f]) => prep.remote.files[k] && prep.remote.files[k].sha === f.sha);
    let version = prep.remote.version || 0;
    if (!same) {
      version += 1;
      await this.coord.putManifest(epoch, { version, by: who || 'host', at: Date.now(), files: prep.files });
    }
    fs.rmSync(this.stageDir, { recursive: true, force: true });
    this.state.lastVersion = version; this.saveState();
    return { version, uploaded: done, bytes, changed: !same };
  }
  async push(epoch, who, onProgress) { return this.commit(epoch, await this.prepare(), who, onProgress); }

  /** make this folder match the cloud copy. Anything replaced or removed goes to .baton-trash first. */
  async pull(onProgress) {
    const remote = await this.coord.getManifest();
    const rfiles = remote.files || {};
    if (!Object.keys(rfiles).length) return { version: 0, empty: true, downloaded: 0, removed: 0 };
    const { files: local } = this.scan(null);
    const todo = Object.keys(rfiles).filter(rel => this.inScope(rel) && (!local[rel] || local[rel].sha !== rfiles[rel].sha));
    const trash = path.join(this.trashRoot, new Date().toISOString().replace(/[:.]/g, '-'));
    const toTrash = rel => {
      const abs = path.join(this.dir, rel); if (!fs.existsSync(abs)) return;
      const dst = path.join(trash, rel); fs.mkdirSync(path.dirname(dst), { recursive: true });
      try { fs.renameSync(abs, dst); } catch { fs.copyFileSync(abs, dst); fs.rmSync(abs, { force: true }); }
    };
    // download everything to temp files first and verify; only then touch the world
    const stagedTmp = {};
    const q = todo.slice(); let done = 0, bytes = 0;
    const worker = async () => {
      while (q.length) {
        const rel = q.shift(); const want = rfiles[rel];
        const parts = [];
        for (const x of (want.chunks || [want.sha])) {
          const piece = await this.coord.getBlob(x);
          if (sha256(piece) !== x) throw new Error('A downloaded world file failed its checksum (' + rel + '). Nothing was changed.');
          parts.push(piece);
        }
        const buf = parts.length === 1 ? parts[0] : Buffer.concat(parts);
        if (sha256(buf) !== want.sha) throw new Error('A downloaded world file failed its checksum (' + rel + '). Nothing was changed.');
        const tmp = path.join(this.dir, rel + '.baton-part'); fs.mkdirSync(path.dirname(tmp), { recursive: true }); fs.writeFileSync(tmp, buf);
        stagedTmp[rel] = tmp; bytes += buf.length; done++;
        if (onProgress) onProgress({ phase: 'download', done, total: todo.length, bytes });
      }
    };
    try { await Promise.all([worker(), worker(), worker(), worker()]); }
    catch (e) { for (const t of Object.values(stagedTmp)) fs.rmSync(t, { force: true }); throw e; }
    for (const rel of todo) {
      const abs = path.join(this.dir, rel);
      let localText = null; if (rel === 'server.properties' && fs.existsSync(abs)) localText = fs.readFileSync(abs, 'utf8');
      toTrash(rel);
      if (rel === 'server.properties') { fs.writeFileSync(abs, mergeProps(fs.readFileSync(stagedTmp[rel], 'utf8'), localText)); fs.rmSync(stagedTmp[rel], { force: true }); }
      else fs.renameSync(stagedTmp[rel], abs);
    }
    let removed = 0;
    for (const rel of Object.keys(local)) if (!rfiles[rel] && this.inScope(rel) && rel !== 'server.properties') { toTrash(rel); removed++; }
    this.state.lastVersion = remote.version || 0; this.state.cache = {};  // re-hash next scan (mtimes changed)
    this.saveState();
    this.sweepTrash();
    return { version: remote.version || 0, downloaded: todo.length, removed, bytes };
  }
  sweepTrash(days = 3) {
    try {
      for (const d of fs.readdirSync(this.trashRoot)) {
        const p = path.join(this.trashRoot, d);
        if (Date.now() - fs.statSync(p).mtimeMs > days * 86400000) fs.rmSync(p, { recursive: true, force: true });
      }
    } catch { /* none */ }
  }
}

module.exports = { Coord, Sync, CHUNK, hashBuf, encodeCode, decodeCode, stripProps, mergeProps, LOCAL_PROP_KEYS, sha256 };
