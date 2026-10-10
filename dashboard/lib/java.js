'use strict';
// Finds an installed Java that satisfies the version Minecraft needs, installs Temurin via winget if missing.
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { IS_WIN, run } = require('./util');

function javaMajor(exe) {
  try {
    const r = spawnSync(exe, ['-version'], { encoding: 'utf8', windowsHide: true, timeout: 15000 });
    const out = (r.stderr || '') + (r.stdout || '');
    const m = out.match(/version "(\d+)(?:\.(\d+))?/);
    if (!m) return 0;
    let major = parseInt(m[1], 10);
    if (major === 1 && m[2]) major = parseInt(m[2], 10);
    return major;
  } catch { return 0; }
}

function candidates(preferred) {
  const list = [];
  if (preferred) list.push(preferred);
  if (process.env.JAVA_HOME) list.push(path.join(process.env.JAVA_HOME, 'bin', IS_WIN ? 'java.exe' : 'java'));
  if (IS_WIN) {
    const pf = process.env.ProgramFiles || 'C:\\Program Files';
    const roots = [
      path.join(pf, 'Eclipse Adoptium'), path.join(pf, 'Java'), path.join(pf, 'Microsoft'),
      path.join(pf, 'Zulu'), path.join(pf, 'Amazon Corretto'), path.join(pf, 'BellSoft'),
      path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Eclipse Adoptium'),
    ];
    for (const r of roots) {
      try {
        for (const d of fs.readdirSync(r, { withFileTypes: true })) {
          if (d.isDirectory()) list.push(path.join(r, d.name, 'bin', 'java.exe'));
        }
      } catch { /* not there */ }
    }
    const where = spawnSync('where', ['java'], { encoding: 'utf8', windowsHide: true });
    (where.stdout || '').split(/\r?\n/).filter(Boolean).forEach(p => list.push(p.trim()));
  } else {
    list.push('/usr/bin/java');
    const which = spawnSync('which', ['-a', 'java'], { encoding: 'utf8' });
    (which.stdout || '').split('\n').filter(Boolean).forEach(p => list.push(p.trim()));
  }
  return [...new Set(list)];
}

/** Returns {path, major} of the lowest installed Java >= need, or null. Also returns all found. */
function findJava(need, preferred) {
  const found = [];
  for (const c of candidates(preferred)) {
    if (!fs.existsSync(c)) continue;
    const major = javaMajor(c);
    if (major) found.push({ path: c, major });
  }
  // an explicitly configured java wins if it is new enough
  if (preferred) {
    const p = found.find(f => f.path === preferred && f.major >= need);
    if (p) return { best: p, found };
  }
  const ok = found.filter(f => f.major >= need).sort((a, b) => a.major - b.major);
  return { best: ok[0] || null, found };
}

async function installJava(need, onLine) {
  if (!IS_WIN) return { ok: false, message: 'Automatic Java install is only supported on Windows.' };
  const r = await run('winget', ['install', '--id', `EclipseAdoptium.Temurin.${need}.JDK`, '-e',
    '--accept-source-agreements', '--accept-package-agreements', '--silent'], { onData: onLine });
  return { ok: r.code === 0, message: r.code === 0 ? `Installed Temurin ${need}` : `winget exited with code ${r.code}. Install Java ${need} from https://adoptium.net` };
}

module.exports = { findJava, installJava, javaMajor };
