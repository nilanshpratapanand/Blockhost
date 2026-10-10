'use strict';
// "Fast lane": a free Cloudflare Quick Tunnel (no account) that gives Live Sync a public https:// address.
//  * friends' helpers download from it at full speed (the Minecraft-wrapped path through playit is the backup)
//  * Minecraft clients download the server texture pack from it (they only speak http(s) for that)
// The address changes every time cloudflared starts - that's fine: helpers learn it from the signed manifest
// (which always reaches them through the Minecraft tunnel) and server.properties is updated before the server starts.
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { spawn } = require('child_process');
const { IS_WIN, download, run, moveFile } = require('./util');

const URL_EXE = process.env.BLOCKHOST_CLOUDFLARED_URL || 'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe';

async function verifySignature(file) {
  if (!IS_WIN) return { ok: true, status: 'skipped (not Windows)' };
  const ps = "$s = Get-AuthenticodeSignature -LiteralPath $env:BH_FILE; Write-Output ($s.Status.ToString() + '|' + $s.SignerCertificate.Subject)";
  const r = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { env: { ...process.env, BH_FILE: file } });
  const [status, subject] = r.stdout.trim().split('|');
  return { ok: status === 'Valid' && /cloudflare/i.test(subject || ''), status: status || 'Unknown', subject: subject || '' };
}

class FastLane {
  /** o: {dashDir, getPort: () => number, log, onUrl: (url|null) => void} */
  constructor(o) { this.o = o; this.proc = null; this.url = null; this.error = null; this.wanted = false; this.retry = null; this.startedAt = 0; }

  exePath() { return process.env.BLOCKHOST_CLOUDFLARED || path.join(this.o.dashDir, 'bin', IS_WIN ? 'cloudflared.exe' : 'cloudflared'); }
  installed() { return fs.existsSync(this.exePath()); }

  async install(progress = () => {}) {
    if (this.installed()) return this.exePath();
    if (!IS_WIN && !process.env.BLOCKHOST_CLOUDFLARED_URL) throw new Error('Automatic install is only for Windows.');
    const dest = this.exePath(); const tmp = dest + '.download';
    await fsp.mkdir(path.dirname(dest), { recursive: true });
    progress('Downloading cloudflared (official, from Cloudflare\'s GitHub)...', 10);
    await download(URL_EXE, tmp, pct => progress(null, 10 + Math.round(pct * 0.8)));
    progress('Checking Cloudflare\'s digital signature...', 92);
    const sig = await verifySignature(tmp);
    if (!sig.ok) { await fsp.rm(tmp, { force: true }); throw new Error(`cloudflared signature check failed (${sig.status} ${sig.subject}) - not installed.`); }
    await moveFile(tmp, dest);
    if (!IS_WIN) await fsp.chmod(dest, 0o755);
    return dest;
  }

  start() {
    this.wanted = true;
    if (this.proc || !this.installed()) return;
    clearTimeout(this.retry);
    this.url = null; this.error = null; this.startedAt = Date.now();
    const p = spawn(this.exePath(), ['tunnel', '--no-autoupdate', '--url', `http://127.0.0.1:${this.o.getPort()}`], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    this.proc = p;
    const onOut = d => {
      const m = String(d).match(process.env.BLOCKHOST_FASTLANE_URL_RE ? new RegExp(process.env.BLOCKHOST_FASTLANE_URL_RE) : /https:\/\/[a-z0-9-]+\.trycloudflare\.com/i);
      if (m && m[0] !== this.url) { this.url = m[0]; this.o.log && this.o.log('Fast lane online: ' + this.url); this.o.onUrl && this.o.onUrl(this.url); }
      if (/failed to (request|create) quick Tunnel|error=.*Unauthorized|429 Too Many Requests/i.test(String(d))) this.error = String(d).trim().slice(0, 200);
    };
    p.stdout.on('data', onOut); p.stderr.on('data', onOut);
    p.on('error', e => { this.error = e.message; });
    p.on('exit', () => {
      this.proc = null; const had = this.url; this.url = null;
      if (had) this.o.onUrl && this.o.onUrl(null);
      if (this.wanted) { const wait = Date.now() - this.startedAt < 60000 ? 60000 : 3000; this.retry = setTimeout(() => this.start(), wait); }
    });
  }

  stop() { this.wanted = false; clearTimeout(this.retry); if (this.proc) { try { this.proc.kill(); } catch { /* ignore */ } } this.proc = null; if (this.url) { this.url = null; this.o.onUrl && this.o.onUrl(null); } }

  /** Wait (up to ms) for a public URL. */
  waitUrl(ms = 25000) {
    return new Promise(res => { const t0 = Date.now(); const iv = setInterval(() => { if (this.url || Date.now() - t0 > ms || !this.proc) { clearInterval(iv); res(this.url); } }, 300); });
  }

  status() { return { installed: this.installed(), running: !!this.proc, url: this.url, error: this.error, wanted: this.wanted }; }
}

module.exports = { FastLane };
