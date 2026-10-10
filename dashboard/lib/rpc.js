'use strict';
// Client for Minecraft's built-in Server Management Protocol (JSON-RPC 2.0 over WebSocket, 1.21.9+).
const EventEmitter = require('events');
const { WsClient } = require('./wsclient');

class McRpc extends EventEmitter {
  constructor() {
    super();
    this.ws = null;
    this.connected = false;
    this.nextId = 1;
    this.pending = new Map();
    this.wanted = false;
    this.retryTimer = null;
  }

  connect(port, secret) {
    this.wanted = true;
    this.failures = 0;
    this.port = port; this.secret = secret;
    this._open();
  }

  _open() {
    clearTimeout(this.retryTimer);
    if (!this.wanted || !this.secret) return;
    const ws = new WsClient('127.0.0.1', this.port, { Authorization: `Bearer ${this.secret}` });
    this.ws = ws;
    ws.on('open', () => { this.connected = true; this.failures = 0; this.emit('connected'); });
    ws.on('message', data => {
      let msg; try { msg = JSON.parse(data); } catch { return; }
      if (msg.id != null && this.pending.has(msg.id)) {
        const p = this.pending.get(msg.id); this.pending.delete(msg.id); clearTimeout(p.timer);
        if (msg.error) p.reject(new Error(msg.error.message || 'RPC error')); else p.resolve(msg.result);
      } else if (msg.method) {
        this.emit('notification', msg.method, msg.params);
      }
    });
    ws.on('error', () => { /* handled by close */ });
    ws.on('close', () => {
      const was = this.connected;
      this.connected = false; if (this.ws === ws) this.ws = null;
      for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new Error('RPC disconnected')); }
      this.pending.clear();
      if (was) this.emit('disconnected');
      this._retry();
    });
  }

  _retry() {
    if (!this.wanted) return;
    // back off 3s, 6s, 12s ... up to 2 min, so a refused connection never spams the server log
    this.failures = (this.failures || 0) + 1;
    const delay = Math.min(120000, 3000 * 2 ** Math.min(6, this.failures - 1));
    this.retryTimer = setTimeout(() => this._open(), delay);
  }

  disconnect() {
    this.wanted = false;
    clearTimeout(this.retryTimer);
    if (this.ws) try { this.ws.close(); } catch { /* ignore */ }
  }

  call(method, params, timeoutMs = 5000) {
    return new Promise((resolve, reject) => {
      if (!this.connected || !this.ws) return reject(new Error('Management API not connected'));
      const id = this.nextId++;
      const msg = { jsonrpc: '2.0', id, method };
      if (params !== undefined) msg.params = params;
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('RPC timeout')); }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.ws.send(JSON.stringify(msg));
    });
  }
}

/** Accepts the different shapes a result may have and returns an array. */
function asArray(result, key) {
  if (Array.isArray(result)) return result;
  if (result && Array.isArray(result[key])) return result[key];
  return [];
}

module.exports = { McRpc, asArray };
