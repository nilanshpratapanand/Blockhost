// Blockhost Baton coordinator - runs free on Cloudflare Workers (Durable Object + R2).
// One host at a time (lease with fencing epoch); the world lives in R2 as content-addressed blobs + a manifest.
const TTL_MS = 150000;          // a host that misses ~3 heartbeats loses the baton
const WATCH_MS = 25000;         // the owner's dashboard counts as "watching" this long after its last peek
const MAX_BLOB = 95 * 1024 * 1024;   // Workers Free request bodies are capped at 100 MB

const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
const safeEq = (a, b) => { if (a.length !== b.length) return false; let d = 0; for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i); return d === 0; };

export class Lease {
  constructor(state, env) { this.state = state; this.ttl = Number(env && env.TTL_MS) || TTL_MS; }
  async load() {
    const s = (await this.state.storage.get('s')) || { epoch: 0, host: null, expiresAt: 0, wanted: null };
    return s;
  }
  view(s, now) {
    const live = !!s.host && s.expiresAt > now;
    return {
      state: live ? 'hosted' : 'free', epoch: s.epoch,
      host: live ? s.host : null, lastHost: s.host ? s.host.name : null,
      expiresInMs: live ? s.expiresAt - now : 0,
      wanted: s.wanted && now - s.wanted.at < 30 * 60000 ? s.wanted : null, now,
      roster: live && s.tele && Array.isArray(s.tele.players) ? s.tele.players.slice(0, 20) : [],
    };
  }
  async fetch(req) {
    const b = await req.json().catch(() => ({}));
    const now = Date.now();
    const s = await this.load();
    const live = !!s.host && s.expiresAt > now;
    const save = () => this.state.storage.put('s', s);
    switch (b.op) {
      case 'status': return json(this.view(s, now));
      case 'acquire': {
        if (live && s.host.id !== b.id) return json({ ok: false, reason: 'busy', ...this.view(s, now) });
        s.epoch += 1;
        s.host = { id: String(b.id).slice(0, 64), name: String(b.name || 'Host').slice(0, 40), ramGB: Number(b.ramGB) || 0, address: '', players: 0, since: now };
        s.expiresAt = now + this.ttl; s.wanted = null; s.tele = null; s.cmds = [];
        await save();
        return json({ ok: true, epoch: s.epoch, ttlMs: this.ttl });
      }
      case 'heartbeat': {
        if (b.epoch !== s.epoch || !s.host) return json({ ok: false, reason: 'lost' });
        s.host.address = String(b.address || s.host.address || '').slice(0, 120);
        s.host.players = Math.max(0, Number(b.players) || 0);
        s.host.phase = String(b.phase || '').slice(0, 20);
        s.expiresAt = now + this.ttl;
        if (b.tele && typeof b.tele === 'object') {
          // what the owner's dashboard shows while a friend hosts: state, who is online, and the last console lines
          const t = s.tele || (s.tele = { lines: [], lastId: 0 });
          t.state = String(b.tele.state || '').slice(0, 20); t.version = String(b.tele.version || '').slice(0, 40);
          t.startedAt = Number(b.tele.startedAt) || 0; t.at = now;
          t.players = (Array.isArray(b.tele.players) ? b.tele.players : []).slice(0, 100).map(n => String(n).slice(0, 40));
          for (const l of (Array.isArray(b.tele.lines) ? b.tele.lines : []).slice(0, 120)) {
            if (!l || !(l.id > t.lastId)) continue;
            t.lines.push({ id: l.id, t: Number(l.t) || now, text: String(l.text || '').slice(0, 300), level: String(l.level || 'info').slice(0, 8) });
            t.lastId = l.id;
          }
          if (t.lines.length > 200) t.lines.splice(0, t.lines.length - 200);
        }
        const cmds = (s.cmds || []).filter(c => now - c.at < 120000); s.cmds = [];
        await save();
        return json({ ok: true, wanted: !!s.wanted, watch: !!s.watchAt && now - s.watchAt < WATCH_MS, cmds });
      }
      case 'peek': {                                    // admin only (checked in the Worker): look at the running server
        s.watchAt = now; await save();
        const v = this.view(s, now);
        if (!live || !s.tele) return json({ ...v, tele: null });
        const since = Number(b.since) || 0;
        const t = s.tele;
        return json({ ...v, tele: { state: t.state, version: t.version, startedAt: t.startedAt, at: t.at, players: t.players, lastId: t.lastId, lines: t.lines.filter(l => l.id > since) } });
      }
      case 'cmd': {                                     // admin only: queue a console command or a hand-off for the host to run
        if (!live) return json({ ok: false, reason: 'nobody' });
        const kind = b.kind === 'handoff' ? 'handoff' : 'cmd';
        const text = String(b.text || '').replace(/[\r\n]/g, ' ').trim().slice(0, 256);
        if (kind === 'cmd' && !text) return json({ ok: false, reason: 'empty' });
        s.cmds = (s.cmds || []).filter(c => now - c.at < 120000).slice(-24);
        s.cmdSeq = (s.cmdSeq || 0) + 1;
        s.cmds.push({ id: s.cmdSeq, kind, text, at: now });
        s.watchAt = now; await save();
        return json({ ok: true, id: s.cmdSeq });
      }
      case 'release': {
        if (b.epoch !== s.epoch) return json({ ok: false, reason: 'lost' });
        s.expiresAt = 0; s.tele = null; s.cmds = []; await save();
        return json({ ok: true });
      }
      case 'check': return json({ ok: b.epoch === s.epoch && !!s.host && s.expiresAt > now - this.ttl });  // allow a short grace for slow uploads
      case 'request': {
        if (!live) { s.wanted = { by: String(b.name || 'A player').slice(0, 40), at: now }; await save(); }
        return json({ ok: true, ...this.view(s, now) });
      }
      default: return json({ ok: false, reason: 'bad-op' }, 400);
    }
  }
}


// ---- storage backends -------------------------------------------------------------------------------------------
// Default ("no card" mode): the world lives in a SQLite Durable Object (Workers Free: 5 GB). If an R2 bucket is bound
// as WORLD it is used instead. Both expose the same small interface.
const CHUNK = 1024 * 1024;

export class Store {
  constructor(state) {
    this.sql = state.storage.sql;
    this.sql.exec('CREATE TABLE IF NOT EXISTS obj (key TEXT NOT NULL, idx INTEGER NOT NULL, data BLOB NOT NULL, PRIMARY KEY (key, idx))');
    this.sql.exec('CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, size INTEGER NOT NULL)');
  }
  has(key) { return this.sql.exec('SELECT 1 FROM meta WHERE key = ?', key).toArray().length > 0; }
  del(key) { this.sql.exec('DELETE FROM obj WHERE key = ?', key); this.sql.exec('DELETE FROM meta WHERE key = ?', key); }
  async fetch(req) {
    const u = new URL(req.url); const key = u.searchParams.get('key'); const op = u.pathname.slice(1);
    if (op === 'head') return new Response(null, { status: this.has(key) ? 200 : 404 });
    if (op === 'get') {
      if (!this.has(key)) return new Response(null, { status: 404 });
      const sql = this.sql; let i = 0;
      return new Response(new ReadableStream({
        pull(c) { const r = sql.exec('SELECT data FROM obj WHERE key = ? AND idx = ?', key, i++).toArray(); if (!r.length) c.close(); else c.enqueue(new Uint8Array(r[0].data)); },
      }));
    }
    if (op === 'put') {
      const sha = u.searchParams.get('sha');
      this.del(key);
      const ds = sha ? new crypto.DigestStream('SHA-256') : null; const dw = ds ? ds.getWriter() : null;
      let idx = 0, size = 0, buf = new Uint8Array(CHUNK), fill = 0;
      const flush = () => { if (fill) { this.sql.exec('INSERT INTO obj (key, idx, data) VALUES (?, ?, ?)', key, idx++, buf.slice(0, fill)); fill = 0; } };
      try {
        const reader = req.body ? req.body.getReader() : null;
        while (reader) {
          const { done, value } = await reader.read(); if (done) break;
          if (dw) await dw.write(value);
          size += value.length;
          for (let o = 0; o < value.length;) { const n = Math.min(CHUNK - fill, value.length - o); buf.set(value.subarray(o, o + n), fill); fill += n; o += n; if (fill === CHUNK) flush(); }
        }
        flush();
        if (dw) {
          await dw.close();
          const hex = [...new Uint8Array(await ds.digest)].map(b => b.toString(16).padStart(2, '0')).join('');
          if (hex !== sha) { this.del(key); return new Response('hash mismatch', { status: 400 }); }
        }
        this.sql.exec('INSERT OR REPLACE INTO meta (key, size) VALUES (?, ?)', key, size);
      } catch (e) { this.del(key); return new Response(String(e && e.message || e), { status: 500 }); }
      return new Response('ok');
    }
    if (op === 'list') {
      const prefix = u.searchParams.get('prefix') || '';
      return new Response(JSON.stringify(this.sql.exec('SELECT key FROM meta WHERE key LIKE ?', prefix.replace(/[%_]/g, '') + '%').toArray().map(r => r.key)));
    }
    if (op === 'delete') { for (const k of await req.json()) this.del(k); return new Response('ok'); }
    return new Response('bad op', { status: 400 });
  }
}

function storage(env) {
  if (env.WORLD) return {          // R2
    head: async k => !!(await env.WORLD.head(k)),
    get: async k => { const o = await env.WORLD.get(k); return o ? o.body : null; },
    getText: async k => { const o = await env.WORLD.get(k); return o ? o.text() : null; },
    put: async (k, req, len, sha) => { await env.WORLD.put(k, len > 0 ? req.body : await req.arrayBuffer(), sha ? { sha256: sha } : undefined); },
    putText: (k, t) => env.WORLD.put(k, t),
    list: async prefix => { const out = []; let cursor; do { const l = await env.WORLD.list({ prefix, cursor, limit: 500 }); out.push(...l.objects.map(o => o.key)); cursor = l.truncated ? l.cursor : undefined; } while (cursor); return out; },
    del: async keys => { for (let i = 0; i < keys.length; i += 500) await env.WORLD.delete(keys.slice(i, i + 500)); },
  };
  const st = () => env.STORE.get(env.STORE.idFromName('world'));
  const call = (op, key, init = {}, extra = '') => st().fetch(`https://store/${op}?key=${encodeURIComponent(key || '')}${extra}`, init);
  return {                          // Durable Object (no card needed)
    head: async k => (await call('head', k)).status === 200,
    get: async k => { const r = await call('get', k); return r.status === 200 ? r.body : null; },
    getText: async k => { const r = await call('get', k); return r.status === 200 ? r.text() : null; },
    put: async (k, req, len, sha) => { const r = await call('put', k, { method: 'PUT', body: req.body }, sha ? '&sha=' + sha : ''); if (r.status !== 200) throw new Error(await r.text()); },
    putText: async (k, t) => { const r = await call('put', k, { method: 'PUT', body: t }); if (r.status !== 200) throw new Error(await r.text()); },
    list: async prefix => (await call('list', '', {}, '&prefix=' + encodeURIComponent(prefix))).json(),
    del: async keys => { if (keys.length) await call('delete', '', { method: 'POST', body: JSON.stringify(keys) }); },
  };
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const stub = () => env.LEASE.get(env.LEASE.idFromName('group'));
    const lease = async body => (await stub().fetch('https://lease/', { method: 'POST', body: JSON.stringify(body) })).json();
    const auth = req.headers.get('authorization') || '';
    const key = auth.startsWith('Bearer ') ? auth.slice(7) : (url.searchParams.get('k') || '');
    const secret = String(env.GROUP_SECRET || '');
    if (!secret || !safeEq(key, secret)) {
      if (url.pathname === '/') return new Response('Blockhost Baton coordinator. Open with ?k=<group secret> to see status.', { status: 401, headers: { 'content-type': 'text/plain' } });
      return json({ error: 'unauthorized' }, 401);
    }
    const p = url.pathname;
    const store = storage(env);

    if (p === '/' && req.method === 'GET') return new Response(statusPage(await lease({ op: 'status' })), { headers: { 'content-type': 'text/html; charset=utf-8' } });

    if (p === '/v1/lease' && req.method === 'POST') {
      const b = await req.json().catch(() => ({}));
      if (!['status', 'acquire', 'heartbeat', 'release', 'request', 'peek', 'cmd'].includes(b.op)) return json({ error: 'bad op' }, 400);
      if (b.op === 'peek' || b.op === 'cmd') {
        // owner-only: friends hold the group secret, so watching and commanding needs a second secret that never leaves the owner's PC
        const admin = String(env.ADMIN_SECRET || '');
        if (!admin) return json({ error: 'admin-not-enabled' }, 403);
        if (!safeEq(req.headers.get('x-admin') || '', admin)) return json({ error: 'admin' }, 403);
      }
      return json(await lease(b));
    }

    // fenced writes: the caller must hold the current epoch
    const fenced = async () => {
      const epoch = Number(req.headers.get('x-epoch'));
      if (!epoch) return false;
      return (await lease({ op: 'check', epoch })).ok === true;
    };

    if (p === '/v1/manifest') {
      if (req.method === 'GET') {
        const t = await store.getText('manifest.json');
        return t ? new Response(t, { headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } }) : json({ version: 0, files: {} });
      }
      if (req.method === 'PUT') {
        if (!(await fenced())) return json({ error: 'lease lost' }, 409);
        const text = await req.text();
        let m; try { m = JSON.parse(text); } catch { return json({ error: 'bad manifest' }, 400); }
        if (!m || typeof m.files !== 'object') return json({ error: 'bad manifest' }, 400);
        const prev = await store.getText('manifest.json');
        if (prev) await store.putText('manifest.prev.json', prev);
        await store.putText('manifest.json', text);
        return json({ ok: true });
      }
    }

    const mb = p.match(/^\/v1\/blob\/([0-9a-f]{64})$/);
    if (mb) {
      const k = 'blobs/' + mb[1];
      if (req.method === 'HEAD') return new Response(null, { status: (await store.head(k)) ? 200 : 404 });
      if (req.method === 'GET') { const b = await store.get(k); return b ? new Response(b, { headers: { 'content-type': 'application/octet-stream' } }) : json({ error: 'missing' }, 404); }
      if (req.method === 'PUT') {
        if (!(await fenced())) return json({ error: 'lease lost' }, 409);
        const len = Number(req.headers.get('content-length') || 0);
        if (len > MAX_BLOB) return json({ error: 'file too large for the free plan (95 MB max)' }, 413);
        if (await store.head(k)) return json({ ok: true, stored: false });
        try { await store.put(k, req, len, mb[1]); }          // the hash is verified while storing; a mismatch is rejected
        catch (e) { return json({ error: 'upload rejected: ' + (e && e.message || e) }, 400); }
        return json({ ok: true, stored: true });
      }
    }

    // housekeeping: delete blobs the current and previous manifest no longer use
    if (p === '/v1/gc' && req.method === 'POST') {
      if (!(await fenced())) return json({ error: 'lease lost' }, 409);
      const keep = new Set();
      for (const name of ['manifest.json', 'manifest.prev.json']) {
        const t = await store.getText(name); if (!t) continue;
        try { for (const f of Object.values(JSON.parse(t).files || {})) for (const x of (f.chunks || [f.sha])) keep.add('blobs/' + x); } catch { /* ignore */ }
      }
      const all = await store.list('blobs/');
      const dead = all.filter(k => !keep.has(k));
      await store.del(dead);
      return json({ ok: true, deleted: dead.length, kept: all.length - dead.length });
    }
    return json({ error: 'not found' }, 404);
  },
};

function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
function statusPage(s) {
  const on = s.state === 'hosted';
  return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Blockhost</title>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0d0f1a;color:#e8eaf6;font:16px system-ui,sans-serif}
.c{width:min(440px,92vw);padding:28px;border:1px solid #2a2f4a;border-radius:18px;background:#141830}
h1{margin:0 0 6px;font-size:20px}.d{display:inline-block;width:10px;height:10px;border-radius:50%;margin-right:8px;background:${on ? '#34d99a' : '#6b7090'}}
code{display:block;margin-top:12px;padding:12px;border-radius:10px;background:#0d0f1a;font-size:18px;word-break:break-all}p{color:#9aa0c3}</style>
<div class=c><h1><span class=d></span>${on ? 'Server is online' : 'Server is asleep'}</h1>
${on ? `<p>Hosted by <b>${esc(s.host.name)}</b> - ${esc(s.host.players)} playing</p><code>${esc(s.host.address || 'starting...')}</code>` : `<p>Nobody is hosting right now. Open Blockhost, go to <b>Cloud Host</b> and press <b>Start server</b>.${s.wanted ? `<br><br><b>${esc(s.wanted.by)}</b> is waiting to play.` : ''}</p>`}</div>
<script>setTimeout(()=>location.reload(),15000)</script>`;
}
