'use strict';
// Tiny WebSocket client (RFC 6455) used for Minecraft's management API.
// Why not the built-in WebSocket? It can't send an Authorization header, and when the secret is sent as a
// sub-protocol Minecraft doesn't echo it back, so browsers/Node treat the handshake as failed and drop it.
const net = require('net');
const crypto = require('crypto');
const EventEmitter = require('events');

class WsClient extends EventEmitter {
  constructor(host, port, headers = {}) {
    super();
    this.open = false;
    this.buf = Buffer.alloc(0);
    this.frag = [];
    const key = crypto.randomBytes(16).toString('base64');
    this.sock = net.createConnection({ host, port }, () => {
      const extra = Object.entries(headers).map(([k, v]) => `${k}: ${v}\r\n`).join('');
      this.sock.write(`GET / HTTP/1.1\r\nHost: ${host}:${port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n`
        + `Sec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n${extra}\r\n`);
    });
    this.expectAccept = crypto.createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
    this.sock.setNoDelay(true);
    this.sock.on('data', d => this._data(d));
    this.sock.on('error', e => this.emit('error', e));
    this.sock.on('close', () => { const was = this.open; this.open = false; this.emit('close', was); });
  }

  _data(d) {
    this.buf = Buffer.concat([this.buf, d]);
    if (!this.open) {
      const end = this.buf.indexOf('\r\n\r\n');
      if (end < 0) return;
      const head = this.buf.toString('latin1', 0, end);
      this.buf = this.buf.subarray(end + 4);
      const status = Number((head.match(/^HTTP\/1\.1 (\d+)/) || [])[1]);
      const accept = (head.match(/^sec-websocket-accept:\s*(.+)$/im) || [])[1];
      if (status !== 101 || (accept && accept.trim() !== this.expectAccept)) {
        this.emit('error', new Error(`Handshake refused (HTTP ${status || '?'})`)); this.sock.destroy(); return;
      }
      this.open = true; this.emit('open');
    }
    for (;;) {
      if (this.buf.length < 2) return;
      const b0 = this.buf[0], b1 = this.buf[1];
      let len = b1 & 0x7f, off = 2;
      if (len === 126) { if (this.buf.length < 4) return; len = this.buf.readUInt16BE(2); off = 4; }
      else if (len === 127) { if (this.buf.length < 10) return; len = Number(this.buf.readBigUInt64BE(2)); off = 10; }
      const masked = b1 & 0x80; let mask = null;
      if (masked) { mask = this.buf.subarray(off, off + 4); off += 4; }
      if (this.buf.length < off + len) return;
      let payload = Buffer.from(this.buf.subarray(off, off + len));
      if (mask) for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
      this.buf = this.buf.subarray(off + len);
      const op = b0 & 0x0f, fin = b0 & 0x80;
      if (op === 0x8) { this.close(); return; }
      if (op === 0x9) { this._send(0xA, payload); continue; }
      if (op === 0xA) continue;
      if (op === 0x1 || op === 0x2 || op === 0x0) {
        this.frag.push(payload);
        if (fin) { const msg = Buffer.concat(this.frag).toString('utf8'); this.frag = []; this.emit('message', msg); }
      }
    }
  }

  _send(op, payload) {
    const len = payload.length;
    let head;
    if (len < 126) { head = Buffer.alloc(2); head[1] = 0x80 | len; }
    else if (len < 65536) { head = Buffer.alloc(4); head[1] = 0x80 | 126; head.writeUInt16BE(len, 2); }
    else { head = Buffer.alloc(10); head[1] = 0x80 | 127; head.writeBigUInt64BE(BigInt(len), 2); }
    head[0] = 0x80 | op;
    const mask = crypto.randomBytes(4);
    const body = Buffer.from(payload);
    for (let i = 0; i < body.length; i++) body[i] ^= mask[i & 3];
    this.sock.write(Buffer.concat([head, mask, body]));
  }

  send(text) { if (this.open) this._send(0x1, Buffer.from(String(text), 'utf8')); }
  close() { try { if (this.open) this._send(0x8, Buffer.alloc(0)); } catch { /* ignore */ } this.sock.end(); }
}

module.exports = { WsClient };
