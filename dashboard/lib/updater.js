'use strict';
// Vanilla server version management using Mojang's official version manifest.
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { fetchJSON, download, moveFile } = require('./util');
const { findJava, installJava } = require('./java');

const MANIFEST = process.env.BLOCKHOST_MANIFEST || 'https://piston-meta.mojang.com/mc/game/version_manifest_v2.json';

class Updater {
  constructor(serverDir, mc, backups, getConfig) {
    this.dir = serverDir; this.mc = mc; this.backups = backups; this.getConfig = getConfig;
    this.cache = null; this.cacheAt = 0;
  }

  async manifest(force = false) {
    if (!force && this.cache && Date.now() - this.cacheAt < 10 * 60 * 1000) return this.cache;
    this.cache = await fetchJSON(MANIFEST);
    this.cacheAt = Date.now();
    return this.cache;
  }

  async versions(includeSnapshots) {
    const m = await this.manifest();
    const cur = this.mc.jarInfo();
    const list = m.versions
      .filter(v => v.type === 'release' || (includeSnapshots && v.type === 'snapshot'))
      .map(v => ({ id: v.id, type: v.type, releaseTime: v.releaseTime }));
    return { latest: m.latest, current: cur ? cur.id : null, versions: list };
  }

  compare(a, b, m) {
    // returns >0 if a is newer than b (by release time in manifest), 0 if unknown/equal
    const va = m.versions.find(v => v.id === a), vb = m.versions.find(v => v.id === b);
    if (!va || !vb) return 0;
    return new Date(va.releaseTime) - new Date(vb.releaseTime);
  }

  /**
   * Install a version. progress(msg, pct). opts: {force} to allow downgrade.
   */
  async install(versionId, opts, progress) {
    const m = await this.manifest(true);
    const target = versionId === 'latest' ? m.latest.release : versionId;
    const entry = m.versions.find(v => v.id === target);
    if (!entry) throw new Error(`Unknown version ${target}`);
    const cur = this.mc.jarInfo();
    if (cur && cur.id === target && !opts.reinstall) throw new Error(`${target} is already installed.`);
    if (cur && this.compare(target, cur.id, m) < 0 && !opts.force) {
      const e = new Error(`${target} is OLDER than your current ${cur.id}. Downgrading can corrupt the world.`); e.code = 'DOWNGRADE'; throw e;
    }

    progress(`Fetching ${target} metadata...`, 2);
    const vj = await fetchJSON(entry.url);
    if (!vj.downloads || !vj.downloads.server) throw new Error(`Mojang has no server download for ${target}.`);
    const need = (vj.javaVersion && vj.javaVersion.majorVersion) || 21;

    progress(`Checking for Java ${need}...`, 5);
    let { best } = findJava(need, this.getConfig().javaPath);
    if (!best) {
      progress(`Java ${need} not found - installing Eclipse Temurin ${need} (accept the Windows prompt)...`, 8);
      const r = await installJava(need, line => { const t = line.trim(); if (t) progress(t.slice(0, 120)); });
      if (!r.ok) throw new Error(r.message);
      best = findJava(need, this.getConfig().javaPath).best;
      if (!best) throw new Error(`Java ${need} was installed but could not be found. Restart the dashboard.`);
    }

    const wasRunning = this.mc.isRunning();
    if (wasRunning) { progress('Stopping server...', 12); await this.mc.stop(); }

    if (cur) {
      progress('Backing up world...', 15);
      await this.backups.create(`before-${target}`, 'manual', msg => progress(msg));
    }

    const jar = path.join(this.dir, 'server.jar');
    const tmp = jar + '.download';
    progress(`Downloading server.jar ${target}...`, 20);
    const sha1 = await download(vj.downloads.server.url, tmp, pct => progress(null, 20 + Math.round(pct * 0.75)));
    if (sha1.toLowerCase() !== String(vj.downloads.server.sha1).toLowerCase()) {
      await fsp.rm(tmp, { force: true });
      throw new Error('Download failed the SHA1 check - nothing was changed.');
    }
    await moveFile(tmp, jar);

    const vdir = path.join(this.dir, 'versions');
    if (fs.existsSync(vdir)) {
      for (const d of await fsp.readdir(vdir)) if (d !== target) await fsp.rm(path.join(vdir, d), { recursive: true, force: true });
    }
    progress(`Installed ${target}.`, 100);
    if (wasRunning) await this.mc.start();
    return { version: target, java: best };
  }
}

module.exports = { Updater };
