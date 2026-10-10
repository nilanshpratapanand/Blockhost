'use strict';
// Minecraft "Server List Ping" - the same status request the multiplayer menu sends.
// Works no matter who started the server, and returns the real online count + player sample.
const net = require('net');

function varInt(n) {
  const out = [];
  n >>>= 0;
  do { let b = n & 0x7f; n >>>= 7; if (n) b |= 0x80; out.push(b); } while (n);
  return Buffer.from(out);
}
function readVarInt(buf, off) {
  let n = 0, shift = 0, b;
  do {
    if (off >= buf.length) return null;
    b = buf[off++]; n |= (b & 0x7f) << shift; shift += 7;
    if (shift > 35) throw new Error('VarInt too big');
  } while (b & 0x80);
  return { value: n, off };
}
function packet(id, payload) {
  const body = Buffer.concat([varInt(id), payload]);
  return Buffer.concat([varInt(body.length), body]);
}

function ping(port, host = '127.0.0.1', timeoutMs = 2500) {
  return new Promise((resolve, reject) => {
    const sock = net.createConnection({ host, port });
    let buf = Buffer.alloc(0), done = false;
    const finish = (err, val) => { if (done) return; done = true; sock.destroy(); err ? reject(err) : resolve(val); };
    sock.setTimeout(timeoutMs, () => finish(new Error('timeout')));
    sock.on('error', e => finish(e));
    sock.on('connect', () => {
      const h = Buffer.from(host, 'utf8');
      const portBuf = Buffer.alloc(2); portBuf.writeUInt16BE(port);
      sock.write(packet(0x00, Buffer.concat([varInt(-1), varInt(h.length), h, portBuf, varInt(1)])));
      sock.write(packet(0x00, Buffer.alloc(0)));
    });
    sock.on('data', d => {
      buf = Buffer.concat([buf, d]);
      try {
        const len = readVarInt(buf, 0); if (!len) return;
        if (buf.length < len.off + len.value) return;
        const id = readVarInt(buf, len.off);
        if (id.value !== 0) return finish(new Error('unexpected packet'));
        const sl = readVarInt(buf, id.off);
        const json = JSON.parse(buf.toString('utf8', sl.off, sl.off + sl.value));
        const players = json.players || {};
        finish(null, {
          online: Number(players.online) || 0,
          max: Number(players.max) || 0,
          sample: (players.sample || []).filter(p => p && p.name && p.id !== '00000000-0000-0000-0000-000000000000').map(p => ({ name: p.name, id: p.id })),
          version: json.version ? json.version.name : null,
        });
      } catch (e) { finish(e); }
    });
    sock.on('close', () => finish(new Error('closed')));
  });
}

module.exports = { ping };
