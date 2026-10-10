'use strict';
// World/config backups: create (safe while running), list, restore, delete, prune.
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const props = require('./props');
const { createZip, extractZip } = require('./archive');
const { stamp } = require('./util');
const { isValidZip } = require('./storage');

const CONFIG_FILES = ['server.properties', 'ops.json', 'whitelist.json', 'banned-players.json', 'banned-ips.json', 'usercache.json', 'eula.txt', 'server-icon.png'];

class Backups {
  constructor(serverDir, mc, getConfig) {
    this.dir = serverDir;
    this.mc = mc;
    this.getConfig = getConfig;
    this.backupDir = path.join(serverDir, 'backups');
  }

  levelName() { return props.getAll(path.join(this.dir, 'server.properties'))['level-name'] || 'world'; }

  worldFolders() {
    const l = this.levelName();
    return [l, `${l}_nether`, `${l}_the_end`].filter(f => fs.existsSync(path.join(this.dir, f)));
  }

  list() {
    let files = [];
    try { files = fs.readdirSync(this.backupDir).filter(f => /\.zip$/i.test(f)); } catch { return []; }
    return files.map(f => {
      const st = fs.statSync(path.join(this.backupDir, f));
      const m = f.match(/^backup_(\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2})_(.+)\.zip$/);
      return { name: f, size: st.size, created: st.mtimeMs, label: m ? m[2] : f.replace(/\.zip$/i, '') };
    }).sort((a, b) => b.created - a.created);
  }

  /** label: short text, kind: 'manual'|'auto' (auto backups are pruned). */
  async create(label = 'manual', kind = 'manual', onMsg = () => {}) {
    fs.mkdirSync(this.backupDir, { recursive: true });
    const items = [...this.worldFolders(), ...CONFIG_FILES.filter(f => fs.existsSync(path.join(this.dir, f)))];
    if (!items.length) throw new Error('Nothing to back up yet (no world or config files).');
    const safeLabel = String(label).replace(/[^\w.\-]+/g, '-').slice(0, 40) || 'backup';
    const name = `backup_${stamp()}_${kind === 'auto' ? 'auto-' : ''}${safeLabel}.zip`;
    const out = path.join(this.backupDir, name);

    // Smart skip: a scheduled backup of a world that has not changed since the last backup is just wasted disk space.
    if (kind === 'auto' && label === 'scheduled') {
      const last = this.list()[0];
      if (last && !(await this.changedSince(last.created))) { onMsg('World unchanged since the last backup - skipped.'); return { skipped: true }; }
    }

    const live = this.mc.isRunning() && this.mc.state === 'online';
    if (live) {
      onMsg('Flushing world to disk...');
      this.mc.send('save-off');
      const saved = this.mc.waitFor(/Saved the game|Saved the world/i, 60000);
      this.mc.send('save-all flush');
      await saved;
    }
    try {
      onMsg(`Zipping ${items.join(', ')}...`);
      await createZip(this.dir, items, out);
      const size = fs.statSync(out).size;
      if (!isValidZip(out, size)) throw new Error('The backup file came out damaged, so it was discarded. Try again (is the disk full?).');
    } catch (e) {
      try { fs.unlinkSync(out); } catch { /* nothing to remove */ }      // never leave a 0-byte / half-written zip behind
      throw e;
    } finally {
      if (live && this.mc.isRunning()) this.mc.send('save-on');
    }
    await this.prune();
    return { name, size: fs.statSync(out).size };
  }

  /** Has anything in the world been written after `ts`? (cheap: file timestamps only) */
  async changedSince(ts) {
    let seen = 0;
    const walk = async d => {
      let ents; try { ents = await fsp.readdir(d, { withFileTypes: true }); } catch { return false; }
      for (const e of ents) {
        if (++seen > 30000) return true;                       // huge world: assume changed
        const p = path.join(d, e.name);
        if (e.isDirectory()) { if (await walk(p)) return true; }
        else { try { if ((await fsp.stat(p)).mtimeMs > ts + 1000) return true; } catch { /* ignore */ } }
      }
      return false;
    };
    for (const f of this.worldFolders()) if (await walk(path.join(this.dir, f))) return true;
    return false;
  }

  async prune() {
    if (this.storage) { try { await this.storage.run(); return; } catch { /* fall back to the simple rule */ } }
    const keep = Math.max(1, Number(this.getConfig().backupsToKeep) || 10);
    // Only explicit "auto-" backups are pruned. Safety copies made before a world reset/import/update
    // (before-reset, before-import, before-<version>) are 'manual' kind and must never be deleted automatically.
    const autos = this.list().filter(b => b.label.startsWith('auto-'));
    for (const b of autos.slice(keep)) { try { fs.unlinkSync(path.join(this.backupDir, b.name)); } catch { /* ignore */ } }
  }

  file(name) {
    if (!/^[\w.\-]+\.zip$/i.test(name)) throw new Error('Bad backup name');
    const f = path.join(this.backupDir, name);
    if (!fs.existsSync(f)) throw new Error('Backup not found');
    return f;
  }

  delete(name) { fs.unlinkSync(this.file(name)); }

  async removeWorlds() {
    for (const f of this.worldFolders()) await fsp.rm(path.join(this.dir, f), { recursive: true, force: true });
  }

  /** Server must be offline. Makes a safety backup, then replaces world + configs with the backup. */
  async restore(name, onMsg = () => {}, includeConfig = false) {
    if (this.mc.isRunning()) throw new Error('Stop the server before restoring.');
    const file = this.file(name);
    onMsg('Making a safety backup of the current world...');
    try { await this.create('before-restore', 'auto'); } catch (e) { onMsg('Safety backup skipped: ' + e.message); }
    const tmp = path.join(this.backupDir, '.restore-tmp');
    await fsp.rm(tmp, { recursive: true, force: true });
    onMsg('Extracting backup...');
    await extractZip(file, tmp);
    onMsg('Replacing world...');
    await this.removeWorlds();
    for (const entry of await fsp.readdir(tmp)) {
      const isDir = fs.statSync(path.join(tmp, entry)).isDirectory();
      if (!isDir && !includeConfig) continue;   // world-only restore keeps current settings/ops
      const dest = path.join(this.dir, entry);
      await fsp.rm(dest, { recursive: true, force: true });
      await fsp.rename(path.join(tmp, entry), dest);
    }
    await fsp.rm(tmp, { recursive: true, force: true });
  }
}

module.exports = { Backups };
