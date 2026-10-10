'use strict';
// What the owner packs into a friend's "Blockhost Sync" file so that friend can host the server too:
// the player runtime sources, plus a way to find the owner's playit key (the shared address for the whole group).
const fs = require('fs');
const path = require('path');
const os = require('os');

const FILES = ['player.js', 'provision.js', 'baton.js', 'batonhost.js', 'mc.js', 'perf.js', 'props.js', 'zipread.js', 'java.js', 'util.js', 'playit.js'];

/** {name: base64} of the runtime sources */
function runtimeFiles(libDir = __dirname) {
  const out = {};
  for (const f of FILES) out[f] = fs.readFileSync(path.join(libDir, f)).toString('base64');
  return out;
}

/** playit stores the agent's secret in playit.toml: secret_key = "..." */
function parseSecret(text) {
  const m = String(text || '').match(/^\s*secret_key\s*=\s*["']([A-Za-z0-9_\-]{16,200})["']/m);
  return m ? m[1] : '';
}
function playitKeyCandidates({ serverDir, dashDir } = {}) {
  const la = process.env.LOCALAPPDATA || '', ad = process.env.APPDATA || '', home = os.homedir();
  return [
    la && path.join(la, 'playit_gg', 'playit.toml'), ad && path.join(ad, 'playit_gg', 'playit.toml'),
    serverDir && path.join(serverDir, 'playit.toml'), dashDir && path.join(dashDir, 'bin', 'playit.toml'),
    path.join(home, '.config', 'playit_gg', 'playit.toml'),
  ].filter(Boolean);
}
/** configured wins, else the first playit.toml found */
function findPlayitKey(configured, dirs) {
  const c = String(configured || '').trim();
  if (c) return { key: c, from: 'dashboard setting' };
  for (const f of playitKeyCandidates(dirs)) {
    try { const k = parseSecret(fs.readFileSync(f, 'utf8')); if (k) return { key: k, from: f }; } catch { /* next */ }
  }
  return { key: '', from: '' };
}

module.exports = { FILES, runtimeFiles, parseSecret, findPlayitKey };
