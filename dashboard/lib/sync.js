'use strict';
// Live Sync - host side.
// A tiny read-only HTTP server (separate port, 127.0.0.1 only - reached by friends through a playit.gg TCP tunnel)
// that tells each friend's Blockhost Sync agent what should be in their Minecraft folder.
//  * Every response that tells the agent what to install is SIGNED (RSA-2048 / SHA-256). The agent only trusts
//    the host key it got from the installer, so nobody on the way can swap a mod or a pack.
//  * A token (header X-BH-Token) keeps strangers from browsing the kit.
//  * Only files listed in the player kit can be downloaded - no paths, no directory listing.
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const FOLDERS = new Set(['mods', 'resourcepacks', 'shaderpacks']);
const AGENT_VERSION = 1;

/** SRV lookup that also works when the PC's own DNS doesn't answer SRV queries:
 *  system DNS -> Cloudflare/Google DNS servers -> DNS-over-HTTPS. */
async function resolveSrv(name) {
  const dns = require('dns');
  const pick = r => (r && r.length ? { name: String(r[0].name || '').replace(/\.$/, ''), port: r[0].port } : null);
  try { const r = pick(await dns.promises.resolveSrv(name)); if (r) return r; } catch { /* next */ }
  try { const res = new dns.promises.Resolver({ timeout: 3000, tries: 1 }); res.setServers(['1.1.1.1', '8.8.8.8']); const r = pick(await res.resolveSrv(name)); if (r) return r; } catch { /* next */ }
  for (const url of [`https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(name)}&type=SRV`, `https://dns.google/resolve?name=${encodeURIComponent(name)}&type=SRV`]) {
    try {
      const j = await (await fetch(url, { headers: { accept: 'application/dns-json' }, signal: AbortSignal.timeout(5000) })).json();
      const ans = (j.Answer || []).find(x => x.type === 33);
      if (ans) { const [, , port, target] = String(ans.data).trim().split(/\s+/); if (Number(port)) return { name: String(target || '').replace(/\.$/, ''), port: Number(port) }; }
    } catch { /* next */ }
  }
  return null;
}

class SyncHost {
  /** o: {dashDir, getConfig, saveConfig, kitData: async(iris)=>data, agentScript: ()=>string, log, onChange} */
  constructor(o) {
    Object.assign(this, o);
    this.kitDir = path.join(o.dashDir, 'player-kit');
    this.keyFile = path.join(o.dashDir, 'sync-key.pem');
    this.clientsFile = path.join(o.dashDir, 'sync-clients.json');
    this.clients = new Map();       // id -> {name, rev, state, seen, ...} (kept across dashboard restarts)
    try { for (const c of JSON.parse(fs.readFileSync(this.clientsFile, 'utf8'))) this.clients.set(c.id, c); } catch { /* none yet */ }
    this.server = null;
    this.error = null;
    this.cache = null;              // {key, at, payload, rev, data}
    this.ensureSecrets();
  }

  ensureSecrets() {
    const c = this.getConfig();
    if (!c.syncToken) this.saveConfig({ syncToken: crypto.randomBytes(18).toString('base64url') });
    if (!fs.existsSync(this.keyFile)) {
      const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
      fs.writeFileSync(this.keyFile, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
    }
    this.key = crypto.createPrivateKey(fs.readFileSync(this.keyFile));
    const jwk = crypto.createPublicKey(this.key).export({ format: 'jwk' });
    const b64 = s => Buffer.from(s, 'base64url').toString('base64');
    this.publicKey = { n: b64(jwk.n), e: b64(jwk.e) };
    this.keyId = crypto.createHash('sha1').update(jwk.n).digest('hex').slice(0, 8);
  }

  /** {payload: base64(bytes), sig: base64} */
  envelope(buf) {
    const sig = crypto.sign('sha256', buf, this.key);
    return { payload: buf.toString('base64'), sig: sig.toString('base64') };
  }

  /** Host part of the Minecraft address (for the agent's SRV fallback). */
  mcHost() { return String(this.getConfig().serverAddress || '').trim().replace(/:\d+$/, ''); }

  /** Cached public URL friends use. Shared mode: the Minecraft tunnel's real host:port (SRV lookup). */
  syncUrl() { return this._url || ''; }

  async resolveUrl() {
    const c = this.getConfig();
    let a = '';
    if (c.syncShared !== false) {
      const addr = String(c.serverAddress || '').trim().replace(/^\w+:\/\//, '');
      if (!addr) { this.urlNote = 'Set your server address (Settings or Overview) - e.g. jacobs-calls.tun.ply.gg'; this._url = ''; return ''; }
      if (c.syncPublicAddress) a = String(c.syncPublicAddress).trim().replace(/^\w+:\/\//, '').replace(/\/+$/, '');
      else if (/:\d+$/.test(addr)) a = addr;
      else {
        const srv = await resolveSrv('_minecraft._tcp.' + addr);
        if (srv) a = `${srv.name || addr}:${srv.port}`;
        else if (/\.ply\.gg$|joinmc\.link$/i.test(addr)) {
          this.urlNote = `Couldn't look up playit's real port for ${addr}. Open playit.gg > Tunnels > your Minecraft tunnel, copy the address with the port (like 147.185.221.225:12345) and paste it under "Public address" below.`;
          this._url = ''; this._urlAt = Date.now(); return '';
        } else a = `${addr}:25565`;
      }
      this.urlNote = '';
    } else {
      a = String(c.syncAddress || '').trim().replace(/^https?:\/\//, '').replace(/\/+$/, '');
      this.urlNote = a ? '' : 'Enter the address of your separate sync tunnel.';
    }
    this._url = a ? `http://${a}` : '';
    this._urlAt = Date.now();
    return this._url;
  }

  /** Where friends' helpers can reach us: direct web URLs (fast lane / premium tunnel) + the Minecraft target. */
  async endpoints() {
    const c = this.getConfig();
    const u = await this.url();
    const urls = [];
    if (this.fastUrl) urls.push(this.fastUrl);                 // Cloudflare quick tunnel (https)
    if (c.syncShared === false && u) urls.push(u);             // separate premium TCP tunnel
    let mc = null;
    if (c.syncShared !== false && u) { const m = u.match(/^http:\/\/(.+):(\d+)$/); if (m) mc = { host: m[1], port: Number(m[2]) }; }
    return { urls, mc, syncUrl: u };
  }

  async url() { if (!this._urlAt || Date.now() - this._urlAt > 10 * 60 * 1000) await this.resolveUrl(); return this._url; }

  // ---------------------------------------------------------------- manifest
  async manifest(force) {
    await this.url();
    const c = this.getConfig();
    let mt = 0; try { mt = fs.statSync(path.join(this.kitDir, 'kit.json')).mtimeMs; } catch { /* empty kit */ }
    const key = `${this._url}|${mt}|${this.versionKey ? this.versionKey() : ''}|${c.syncIris !== false}|${c.syncAddress}|${JSON.stringify(c.syncPolicy || null)}|${c.syncDefaultMode}`;
    if (!force && this.cache && this.cache.key === key && Date.now() - this.cache.at < 15 * 60 * 1000) return this.cache;
    let d;
    try { d = await this.kitData(c.syncIris !== false); }
    catch (e) { if (/kit is empty/.test(e.message)) d = null; else throw e; }
    const files = [];
    const hasMirror = (folder, name) => fs.existsSync(path.join(this.kitDir, folder, name));
    if (d) {
      for (const f of d.shaders) files.push({ folder: 'shaderpacks', name: f.name, url: f.url, sha1: f.sha1, mirror: hasMirror('shaderpacks', f.name) });
      for (const f of d.resourcepacks) files.push({ folder: 'resourcepacks', name: f.name, url: f.url, sha1: f.sha1, mirror: hasMirror('resourcepacks', f.name) });
      for (const m of d.mods) files.push({ folder: 'mods', name: m.filename, url: m.url || null, sha1: m.sha1, slug: m.slug || null, mirror: hasMirror('mods', m.filename) });
    }
    for (let i = files.length - 1; i >= 0; i--) if (files.findIndex(f => f.folder === files[i].folder && f.name === files[i].name) !== i) files.splice(i, 1);
    const content = { version: d ? d.version : null, fabric: d ? d.fabric : null, files: files.map(({ mirror, ...f }) => f), shader: d && d.shaders[0] ? d.shaders[0].name : null };
    const rev = crypto.createHash('sha1').update(JSON.stringify(content)).digest('hex').slice(0, 12);
    const pol = c.syncPolicy && c.syncPolicy.rev === rev ? c.syncPolicy : { id: 'auto-' + rev, rev, mode: c.syncDefaultMode || 'next', message: '', at: null };
    const data = {
      v: 1, rev, keyId: this.keyId, agentVersion: AGENT_VERSION, serverName: d ? d.name : 'Minecraft Server',
      address: c.serverAddress || '', mcHost: this.mcHost(), ...(await this.endpoints()), version: content.version, fabric: content.fabric,
      shader: content.shader, files, policy: pol, issued: new Date().toISOString(),
    };
    const payload = this.envelope(Buffer.from(JSON.stringify(data), 'utf8'));
    this.cache = { key, at: Date.now(), payload, rev, data, note: d ? d.note : '' };
    return this.cache;
  }

  invalidate() { this.cache = null; }

  /** Resources for the Minecraft-framed transport (front door): 0 = manifest, 1 = agent, 100+n = kit file n. */
  async framed(resId) {
    if (!this.getConfig().syncEnabled) return null;
    if (resId === 0) return Buffer.from(JSON.stringify((await this.manifest()).payload));
    if (resId === 1) return Buffer.from(JSON.stringify({ version: AGENT_VERSION, ...this.envelope(Buffer.from(this.agentScript(), 'utf8')) }));
    if (resId >= 100) {
      const { data } = await this.manifest();
      const f = data.files[resId - 100];
      if (!f || !f.mirror) return null;
      const key = `${f.folder}/${f.name}/${f.sha1}`;
      if (!this._fileCache || this._fileCache.key !== key) this._fileCache = { key, buf: fs.readFileSync(path.join(this.kitDir, f.folder, f.name)) };
      return this._fileCache.buf;
    }
    return null;
  }

  /** Host pressed "Push update". mode: next | ask | now */
  async push(mode, message) {
    if (!['next', 'ask', 'now'].includes(mode)) throw new Error('Unknown mode');
    this.invalidate();
    const m = await this.manifest(true);
    const policy = { id: crypto.randomBytes(6).toString('hex'), rev: m.rev, mode, message: String(message || '').slice(0, 140), at: new Date().toISOString() };
    this.saveConfig({ syncPolicy: policy });
    this.invalidate();
    await this.manifest(true);
    this.onChange && this.onChange();
    return policy;
  }

  // ---------------------------------------------------------------- HTTP server for agents
  start() {
    const c = this.getConfig();
    this.stop();
    this.error = null;
    if (!c.syncEnabled) return;
    const port = Number(c.syncPort) || 25570;
    const srv = http.createServer((req, res) => this.handle(req, res).catch(e => {
      if (!res.headersSent) { res.writeHead(500, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: e.message })); } else res.end();
    }));
    srv.keepAliveTimeout = 5000;
    srv.requestTimeout = 60000;
    srv.on('error', e => { this.error = e.code === 'EADDRINUSE' ? `Port ${port} is already in use - pick another sync port.` : e.message; this.server = null; this.onChange && this.onChange(); });
    srv.listen(port, '127.0.0.1', () => { this.log && this.log(`Live Sync listening on 127.0.0.1:${port}`); this.onChange && this.onChange(); });
    this.server = srv;
  }

  stop() { if (this.server) { try { this.server.close(); } catch { /* ignore */ } this.server = null; } }

  tokenOk(req) {
    const want = Buffer.from(String(this.getConfig().syncToken || ''));
    const got = Buffer.from(String(req.headers['x-bh-token'] || ''));
    return want.length > 0 && got.length === want.length && crypto.timingSafeEqual(got, want);
  }

  async handle(req, res) {
    const url = new URL(req.url, 'http://x');
    const json = (code, obj) => { const b = JSON.stringify(obj); res.writeHead(code, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(b), 'Cache-Control': 'no-store' }); res.end(b); };
    if (url.pathname === '/' && req.method === 'GET') { res.writeHead(200, { 'Content-Type': 'text/plain' }); return res.end('Blockhost Live Sync is running.\n'); }
    // the merged server texture pack is public (Minecraft clients download it without a token)
    const rp = url.pathname.match(/^\/rp\/([0-9a-f]{40})\.zip$/);
    if (rp && (req.method === 'GET' || req.method === 'HEAD')) {
      const f = this.serverPackFile && this.serverPackFile(rp[1]);
      if (!f) return json(404, { error: 'no such pack' });
      const st = fs.statSync(f);
      res.writeHead(200, { 'Content-Type': 'application/zip', 'Content-Length': st.size, 'Cache-Control': 'public, max-age=31536000, immutable' });
      if (req.method === 'HEAD') return res.end();
      return fs.createReadStream(f).pipe(res);
    }
    if (!this.tokenOk(req)) return json(403, { error: 'bad token' });

    if (req.method === 'GET' && url.pathname === '/m') return json(200, (await this.manifest()).payload);

    if (req.method === 'GET' && url.pathname === '/agent') {
      return json(200, { version: AGENT_VERSION, ...this.envelope(Buffer.from(this.agentScript(), 'utf8')) });
    }

    const fm = url.pathname.match(/^\/f\/([a-z]+)\/([^/]+)$/);
    if (req.method === 'GET' && fm) {
      const folder = fm[1]; const name = decodeURIComponent(fm[2]);
      const { data } = await this.manifest();
      const entry = data.files.find(f => f.folder === folder && f.name === name && f.mirror);
      if (!FOLDERS.has(folder) || !entry || name !== path.basename(name)) return json(404, { error: 'not in kit' });
      const file = path.join(this.kitDir, folder, name);
      let st; try { st = fs.statSync(file); } catch { return json(404, { error: 'missing' }); }
      res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': st.size });
      return fs.createReadStream(file).pipe(res);
    }

    if (req.method === 'POST' && url.pathname === '/hello') {
      const body = await new Promise((ok, bad) => {
        let b = ''; req.on('data', d => { b += d; if (b.length > 4096) { bad(new Error('too big')); req.destroy(); } });
        req.on('end', () => ok(b)); req.on('error', bad);
      });
      let h; try { h = JSON.parse(body); } catch { return json(400, { error: 'bad json' }); }
      const id = String(h.id || '').replace(/[^\w-]/g, '').slice(0, 24);
      if (!id) return json(400, { error: 'no id' });
      const clean = s => String(s == null ? '' : s).replace(/[^\w .\-:/()]/g, '').slice(0, 60);
      const prev = this.clients.get(id) || {};
      this.clients.set(id, {
        id, name: clean(h.name) || prev.name || 'Friend', pc: clean(h.pc), rev: clean(h.rev), state: clean(h.state),
        game: !!h.game, pending: Number(h.pending) || 0, agent: Number(h.agent) || 0, error: String(h.error == null ? '' : h.error).replace(/[^\w .\-:/()\[\],'"=]/g, '').slice(0, 160), seen: Date.now(),
      });
      if (this.clients.size > 200) this.clients.delete(this.clients.keys().next().value);
      clearTimeout(this._saveT);
      this._saveT = setTimeout(() => { try { fs.writeFileSync(this.clientsFile, JSON.stringify([...this.clients.values()])); } catch { /* ignore */ } }, 5000);
      this.onChange && this.onChange();
      return json(200, { ok: true });
    }
    return json(404, { error: 'not found' });
  }

  status() {
    const c = this.getConfig();
    const now = Date.now();
    return {
      enabled: !!c.syncEnabled, running: !!(this.server && this.server.listening), port: Number(c.syncPort) || 25570,
      address: c.syncAddress || '', publicAddress: c.syncPublicAddress || '', shared: c.syncShared !== false, url: this._url || '', urlNote: this.urlNote || '',
      front: this.front ? { listening: this.front.listening(), error: this.front.error, port: this.front.port } : null,
      restartNeeded: this.restartNeeded ? !!this.restartNeeded() : false, internalPort: this.internalPort ? this.internalPort() : null, defaultMode: c.syncDefaultMode || 'next', iris: c.syncIris !== false, error: this.error,
      rev: this.cache ? this.cache.rev : null, fast: this.fast ? this.fast.status() : null, policy: c.syncPolicy || null, keyId: this.keyId,
      clients: [...this.clients.values()].map(x => ({ ...x, online: now - x.seen < 3 * 60 * 1000, ago: Math.round((now - x.seen) / 1000) })).sort((a, b) => b.seen - a.seen),
    };
  }
}

module.exports = { SyncHost, AGENT_VERSION };
