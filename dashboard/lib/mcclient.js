'use strict';
// Node side of the Minecraft-wrapped Live Sync transports (used by "Test from the internet" and tests).
// The friend-side PowerShell agent implements the same two calls.
const net = require('net');
const { MAGIC_HTTP, MAGIC_FRAMED, varInt, mcString, packet, readVarInt } = require('./frontdoor');

function handshake(protocol, host, port, next = 1) {
  const p = Buffer.alloc(2); p.writeUInt16BE(port & 0xffff);
  return packet(0, Buffer.concat([varInt(protocol), mcString(host), p, varInt(next)]));
}

/** HTTP request tunnelled behind a Minecraft handshake. Resolves {status, headers, body}. */
function wrappedHttp(host, port, path, { method = 'GET', headers = {}, body = null, timeout = 15000 } = {}) {
  return new Promise((resolve, reject) => {
    const s = net.connect({ host, port });
    const chunks = [];
    const t = setTimeout(() => { s.destroy(); reject(new Error('timeout')); }, timeout);
    s.on('connect', () => {
      const b = body ? Buffer.from(body) : null;
      const h = Object.entries({ Host: 'blockhost', Connection: 'close', ...headers, ...(b ? { 'Content-Length': b.length } : {}) }).map(([k, v]) => `${k}: ${v}\r\n`).join('');
      s.write(Buffer.concat([handshake(MAGIC_HTTP, host, port), Buffer.from(`${method} ${path} HTTP/1.0\r\n${h}\r\n`), b || Buffer.alloc(0)]));
    });
    s.on('data', d => chunks.push(d));
    s.on('error', e => { clearTimeout(t); reject(e); });
    s.on('close', () => {
      clearTimeout(t);
      const all = Buffer.concat(chunks); const i = all.indexOf('\r\n\r\n');
      if (i < 0) return reject(new Error(all.length ? 'bad reply' : 'connection closed without a reply (the tunnel may block it)'));
      const head = all.subarray(0, i).toString('latin1').split('\r\n');
      const status = Number((head[0].match(/^HTTP\/\d\.\d (\d+)/) || [])[1]) || 0;
      resolve({ status, headers: head.slice(1), body: all.subarray(i + 4) });
    });
  });
}

/** One server-list "status" exchange returning chunk `chunk` of resource `resId`. */
function framedChunk(host, port, resId, chunk, timeout = 15000) {
  return new Promise((resolve, reject) => {
    const s = net.connect({ host, port });
    let buf = Buffer.alloc(0);
    const t = setTimeout(() => { s.destroy(); reject(new Error('timeout')); }, timeout);
    s.on('connect', () => s.write(Buffer.concat([handshake(MAGIC_FRAMED + resId, host, chunk), packet(0, Buffer.alloc(0))])));
    s.on('data', d => {
      buf = Buffer.concat([buf, d]);
      const l = readVarInt(buf, 0); if (!l || buf.length < l.off + l.val) return;
      const body = buf.subarray(l.off, l.off + l.val);
      const id = readVarInt(body, 0); const sl = readVarInt(body, id.off);
      const json = JSON.parse(body.subarray(sl.off, sl.off + sl.val).toString('utf8'));
      const ping = Buffer.alloc(8); s.write(packet(1, ping)); clearTimeout(t); s.end();
      if (!json.bh || json.bh.error) return reject(new Error((json.bh && json.bh.error) || 'not a Blockhost server'));
      resolve(json.bh);
    });
    s.on('error', e => { clearTimeout(t); reject(e); });
    s.on('close', () => { clearTimeout(t); reject(new Error('closed')); });
  });
}

async function framedGet(host, port, resId) {
  const first = await framedChunk(host, port, resId, 0);
  const parts = [Buffer.from(first.d, 'base64')];
  for (let c = 1; c < first.t; c++) parts.push(Buffer.from((await framedChunk(host, port, resId, c)).d, 'base64'));
  const out = Buffer.concat(parts);
  if (out.length !== first.n) throw new Error('incomplete');
  return out;
}

module.exports = { wrappedHttp, framedChunk, framedGet, handshake };
