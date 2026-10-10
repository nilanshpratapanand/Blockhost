'use strict';
// Smart storage manager for the backups folder.
//  1. Leftover temp files (half-built installer/kit zips etc. - these were the 2.7 GB) are removed as soon as they are stale.
//  2. Failed / empty backup zips are removed.
//  3. Real backups are kept by importance, not just by count:
//       manual (you made it)            -> never deleted automatically
//       safety (before-reset/update...) -> expires after `safetyDays`, but the newest one is always kept
//       auto (scheduled)                -> newest `backupsToKeep` only, and nothing older than `autoMaxDays` (newest 2 always kept)
//     plus a size cap (`backupMaxGB`): oldest auto, then oldest safety copies go first - manual ones never.
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');

const TEMP_MIN_AGE = 15 * 60 * 1000;     // temp files younger than this may still be in use
const NEW_MIN_AGE = 3 * 60 * 1000;       // a backup being written right now is not "broken"
const KEEP_DOT = new Set(['.downloads']);

function isValidZip(file, size) {
  if (size < 22) return false;
  try {
    const fd = fs.openSync(file, 'r');
    try {
      const n = Math.min(size, 65557), buf = Buffer.alloc(n);
      fs.readSync(fd, buf, 0, n, size - n);
      for (let i = n - 22; i >= 0; i--) if (buf.readUInt32LE(i) === 0x06054b50) return true;
      return false;
    } finally { fs.closeSync(fd); }
  } catch { return false; }
}

async function sizeOf(p) {
  let st; try { st = await fsp.stat(p); } catch { return 0; }
  if (!st.isDirectory()) return st.size;
  let t = 0; try { for (const e of await fsp.readdir(p)) t += await sizeOf(path.join(p, e)); } catch { /* ignore */ }
  return t;
}

class Storage {
  constructor(serverDir, backups, getConfig, log = () => {}, isBusy = () => false) {
    this.dir = serverDir; this.backups = backups; this.getConfig = getConfig; this.log = log; this.isBusy = isBusy;
    this.backupDir = backups.backupDir;
  }

  policy() {
    const c = this.getConfig();
    const num = (v, d, min = 0) => { const n = Number(v); return Number.isFinite(n) && n >= min ? n : d; };
    return { smart: c.smartCleanup !== false, keepAuto: Math.max(1, num(c.backupsToKeep, 10, 1)),
      autoDays: num(c.autoMaxDays, 14, 1), safetyDays: num(c.safetyDays, 7, 1), maxGB: num(c.backupMaxGB, 5, 0) };
  }

  kindOf(label) {
    if (/^(auto-)?before-/.test(label)) return 'safety';
    if (label.startsWith('auto-')) return 'auto';
    return 'manual';
  }

  /** Works out what is junk and what retention would delete. Deletes nothing. */
  async plan() {
    const pol = this.policy(), now = Date.now();
    const junk = [], retention = [], keep = [];
    let names = []; try { names = await fsp.readdir(this.backupDir); } catch { return { policy: pol, junk, retention, keep, usage: { total: 0, backups: 0, temp: 0, broken: 0 } }; }

    const usage = { total: 0, backups: 0, temp: 0, broken: 0 };
    const good = [];
    const listed = new Map(this.backups.list().map(b => [b.name, b]));
    for (const n of names) {
      const full = path.join(this.backupDir, n);
      let st; try { st = await fsp.stat(full); } catch { continue; }
      const size = st.isDirectory() ? await sizeOf(full) : st.size, age = now - st.mtimeMs;
      usage.total += size;
      if (n.startsWith('.')) {
        if (KEEP_DOT.has(n)) { continue; }
        usage.temp += size;
        if (age > TEMP_MIN_AGE && !this.isBusy()) junk.push({ name: n, size, reason: 'leftover temporary file', why: 'temp' });
        continue;
      }
      if (st.isDirectory() || !/\.zip$/i.test(n)) continue;           // not ours - never touch
      if (!/^backup_.*\.zip$/i.test(n)) continue;
      if (!isValidZip(full, size)) {
        usage.broken += size;
        if (age > NEW_MIN_AGE && !this.isBusy()) junk.push({ name: n, size, reason: size === 0 ? 'empty backup (the backup failed)' : 'damaged backup (cannot be restored)', why: 'broken' });
        continue;
      }
      usage.backups += size;
      const b = listed.get(n);
      good.push({ name: n, size, created: st.mtimeMs, label: b ? b.label : n, kind: this.kindOf(b ? b.label : n) });
    }
    good.sort((a, b) => b.created - a.created);
    const del = new Map();
    const mark = (b, reason) => { if (!del.has(b.name)) del.set(b.name, { name: b.name, size: b.size, reason, why: 'retention', kind: b.kind }); };
    const DAY = 86400000;

    if (pol.smart) {
      const autos = good.filter(b => b.kind === 'auto'), safes = good.filter(b => b.kind === 'safety');
      autos.forEach((b, i) => {
        if (i >= pol.keepAuto) mark(b, `more than ${pol.keepAuto} automatic backups`);
        else if (i >= 2 && now - b.created > pol.autoDays * DAY) mark(b, `automatic backup older than ${pol.autoDays} days`);
      });
      safes.forEach((b, i) => { if (i >= 1 && now - b.created > pol.safetyDays * DAY) mark(b, `safety copy older than ${pol.safetyDays} days (not needed once the world is fine)`); });
      // size cap: oldest automatic first, then oldest safety copy - never manual, never the newest backup
      if (pol.maxGB > 0) {
        const cap = pol.maxGB * 1073741824;
        let total = good.reduce((a, b) => a + (del.has(b.name) ? 0 : b.size), 0);
        const order = [...autos.slice().reverse(), ...safes.slice().reverse()];
        const newest = good[0] && good[0].name;
        for (const b of order) {
          if (total <= cap) break;
          if (del.has(b.name) || b.name === newest) continue;
          if (b.kind === 'auto' && autos[0] === b) continue;            // keep newest auto
          if (b.kind === 'safety' && safes[0] === b) continue;          // keep newest safety
          mark(b, `backups use more than ${pol.maxGB} GB`); total -= b.size;
        }
        usage.overCap = total > cap;
      }
    }
    for (const b of good) (del.has(b.name) ? retention : keep).push(del.get(b.name) || b);
    return { policy: pol, junk, retention: [...del.values()], keep, usage };
  }

  async rm(p) { await fsp.rm(p, { recursive: true, force: true, maxRetries: 8, retryDelay: 600 }); }

  /** Delete what plan() says. Returns { freed, deleted:[names], failed:[names] }. */
  async run(opts = {}) {
    const pl = await this.plan();
    const targets = [...pl.junk, ...pl.retention];
    let freed = 0; const deleted = [], failed = [];
    for (const t of targets) {
      try { await this.rm(path.join(this.backupDir, t.name)); freed += t.size; deleted.push(t.name); }
      catch { failed.push(t.name); }
    }
    if (deleted.length && !opts.quiet) this.log(`[storage] cleaned ${deleted.length} item${deleted.length > 1 ? 's' : ''}, freed ${(freed / 1048576).toFixed(0)} MB`);
    return { freed, deleted, failed, plan: pl };
  }

  /** Big files sitting in the server folder that are not part of the live server (advice only - never deleted). */
  async bigStrays() {
    const out = [];
    try {
      for (const n of await fsp.readdir(this.dir)) {
        const st = await fsp.stat(path.join(this.dir, n)).catch(() => null);
        if (st && st.isFile() && st.size > 100 * 1048576 && /\.(rar|zip|7z|tar|gz|iso)$/i.test(n)) out.push({ name: n, size: st.size });
      }
    } catch { /* ignore */ }
    return out.sort((a, b) => b.size - a.size);
  }
}

module.exports = { Storage, isValidZip };
