'use strict';
// "Front door" for the Minecraft port, so Live Sync works through the SAME free playit.gg tunnel.
//
// playit's free "Minecraft Java" tunnel only lets Minecraft-protocol connections through (plain HTTP gets reset),
// so friends' Sync helpers speak Minecraft first:
//   1. normal player / server-list ping            -> forwarded untouched to the real server (--port <internal>)
//   2. handshake with protocol = MAGIC_HTTP         -> handshake is eaten, the rest of the stream is HTTP to Live Sync
//   3. handshake with protocol = MAGIC_FRAMED + id  -> answered right here as a normal server-list "status" reply whose
//      JSON carries one chunk (port field = chunk number) of a resource (0 = manifest, 1 = agent, 100+n = kit file n).
//      This is 100% valid Minecraft protocol in both directions - the last-resort path if a proxy inspects packets.
//   4. connection starting with "GET "/"POST"      -> HTTP to Live Sync (LAN / direct connections)
// Bytes are piped straight through, so there is no measurable effect on gameplay.
const net = require('net');

const HTTP_START = /^(GET|POST|HEAD) /;
const MAGIC_HTTP = 0x0B10C7;          // 725191
const MAGIC_FRAMED = 0x0B20000;       // 11665408 (+ resource id)
const CHUNK = 22000;                  // bytes per status reply (base64 ~29.4k chars < 32767 string limit)

// ---- tiny Minecraft protocol helpers
function readVarInt(buf, off) {
  let val = 0, shift = 0, b;
  do {
    if (off >= buf.length) return null;
    b = buf[off++]; val |= (b & 0x7f) << shift; shift += 7;
    if (shift > 35) throw new Error('varint too big');
  } while (b & 0x80);
  return { val, off };
}
function varInt(n) { const o = []; n >>>= 0; do { let b = n & 0x7f; n >>>= 7; if (n) b |= 0x80; o.push(b); } while (n); return Buffer.from(o); }
function mcString(s) { const b = Buffer.from(s, 'utf8'); return Buffer.concat([varInt(b.length), b]); }
function packet(id, body) { const p = Buffer.concat([varInt(id), body]); return Buffer.concat([varInt(p.length), p]); }

/** Parse a complete handshake packet at the start of buf. null = need more bytes, false = not a handshake. */
function parseHandshake(buf) {
  try {
    const l = readVarInt(buf, 0); if (!l) return null;
    if (l.val < 3 || l.val > 1024) return false;
    if (buf.length < l.off + l.val) return null;
    let o = l.off; const end = l.off + l.val;
    const id = readVarInt(buf, o); if (!id || id.val !== 0) return false; o = id.off;
    const proto = readVarInt(buf, o); if (!proto) return false; o = proto.off;
    const sl = readVarInt(buf, o); if (!sl || sl.val > 300) return false; o = sl.off;
    const host = buf.subarray(o, o + sl.val).toString('utf8'); o += sl.val;
    if (o + 2 > end) return false;
    const port = buf.readUInt16BE(o); o += 2;
    const next = readVarInt(buf, o); if (!next) return false; o = next.off;
    if (o !== end) return false;
    return { protocol: proto.val, host, port, next: next.val, length: end };
  } catch { return false; }
}

class FrontDoor {
  /** o: {getPorts: () => ({publicPort, internalPort, httpPort, host}), framed: async (resId) => Buffer|null, log} */
  constructor(o) { this.o = o; this.server = null; this.port = null; this.error = null; this.conns = new Set(); this.stats = { mc: 0, wrapped: 0, framed: 0, http: 0 }; }

  listening() { return !!(this.server && this.server.listening); }

  /** Start (or keep) listening on the public port. Resolves true/false. */
  start() {
    const { publicPort, host } = this.o.getPorts();
    if (this.listening() && this.port === publicPort) return Promise.resolve(true);
    this.stop();
    return new Promise(resolve => {
      const srv = net.createServer(sock => this.route(sock));
      srv.on('error', e => {
        this.error = e.code === 'EADDRINUSE' ? `Port ${publicPort} is already in use (is another Minecraft server or old run.bat still open?)` : e.message;
        this.server = null; resolve(false);
      });
      srv.listen(publicPort, host || '0.0.0.0', () => {
        this.error = null; this.port = publicPort;
        this.o.log && this.o.log(`Front door on port ${publicPort}: Minecraft -> ${this.o.getPorts().internalPort}, Live Sync -> ${this.o.getPorts().httpPort}`);
        resolve(true);
      });
      this.server = srv;
    });
  }

  stop() {
    if (this.server) { try { this.server.close(); } catch { /* ignore */ } this.server = null; this.port = null; }
    for (const s of this.conns) s.destroy();
    this.conns.clear();
  }

  pipeTo(sock, port, first, kind) {
    this.stats[kind]++;
    const up = net.connect({ host: '127.0.0.1', port });
    this.conns.add(up);
    up.setNoDelay(true);
    up.on('connect', () => { if (first && first.length) up.write(first); sock.pipe(up); up.pipe(sock); sock.resume(); });
    up.on('error', () => sock.destroy());
    sock.on('error', () => up.destroy());
    up.on('close', () => { this.conns.delete(up); sock.destroy(); });
    sock.on('close', () => up.destroy());
  }

  route(sock) {
    this.conns.add(sock);
    sock.setNoDelay(true);
    sock.on('close', () => this.conns.delete(sock));
    sock.on('error', () => {});
    const t = setTimeout(() => sock.destroy(), 15000);   // nothing sent at all -> drop
    let buf = Buffer.alloc(0);
    const onData = d => {
      buf = Buffer.concat([buf, d]);
      const { internalPort, httpPort } = this.o.getPorts();
      const decide = (fn) => { sock.removeListener('data', onData); clearTimeout(t); sock.pause(); fn(); };
      const head = buf.subarray(0, 5).toString('latin1');
      if (HTTP_START.test(head)) return decide(() => this.pipeTo(sock, httpPort, buf, 'http'));
      if (buf.length < 4 && /^[A-Z]{1,3}$/.test(head)) return;            // maybe "GET" split across packets
      if (buf[0] === 0xfe) return decide(() => this.pipeTo(sock, internalPort, buf, 'mc'));   // legacy ping
      const hs = parseHandshake(buf);
      if (hs === null && buf.length < 1100) return;                      // wait for the whole handshake
      if (!hs) return decide(() => this.pipeTo(sock, internalPort, buf, 'mc'));
      if (hs.protocol === MAGIC_HTTP) return decide(() => this.pipeTo(sock, httpPort, buf.subarray(hs.length), 'wrapped'));
      if (hs.protocol >= MAGIC_FRAMED && hs.protocol < MAGIC_FRAMED + 100000 && hs.next === 1) return decide(() => this.framed(sock, hs.protocol - MAGIC_FRAMED, hs.port, buf.subarray(hs.length)));
      return decide(() => this.pipeTo(sock, internalPort, buf, 'mc'));
    };
    sock.on('data', onData);
  }

  /** Answer a server-list "status" exchange with one chunk of a Live Sync resource. */
  async framed(sock, resId, chunk, rest) {
    this.stats.framed++;
    let data = null;
    try { data = this.o.framed ? await this.o.framed(resId) : null; } catch { data = null; }
    let buf = Buffer.from(rest);
    sock.resume();
    const total = data ? Math.max(1, Math.ceil(data.length / CHUNK)) : 0;
    const status = JSON.stringify({
      version: { name: 'Blockhost', protocol: -1 }, players: { max: 0, online: 0 }, description: { text: 'Blockhost Live Sync' },
      bh: data ? { v: 1, t: total, c: chunk, n: data.length, d: chunk < total ? data.subarray(chunk * CHUNK, (chunk + 1) * CHUNK).toString('base64') : '' } : { v: 1, error: 'not found' },
    });
    const handle = () => {
      // packets from the client: status request (id 0, empty) then ping (id 1, 8-byte long)
      for (;;) {
        const l = readVarInt(buf, 0); if (!l || buf.length < l.off + l.val) return;
        const body = buf.subarray(l.off, l.off + l.val); buf = buf.subarray(l.off + l.val);
        const id = readVarInt(body, 0); if (!id) { sock.destroy(); return; }
        if (id.val === 0) sock.write(packet(0, mcString(status)));
        else if (id.val === 1) { sock.end(packet(1, body.subarray(id.off))); return; }
        else { sock.destroy(); return; }
      }
    };
    sock.on('data', d => { buf = Buffer.concat([buf, d]); handle(); });
    handle();
    setTimeout(() => sock.destroy(), 20000);
  }
}

module.exports = { FrontDoor, HTTP_START, MAGIC_HTTP, MAGIC_FRAMED, CHUNK, parseHandshake, varInt, mcString, packet, readVarInt };
