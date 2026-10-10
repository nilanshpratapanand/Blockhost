'use strict';
// Merges all texture packs of the player kit into ONE server resource pack (Minecraft only lets a server send one
// via server.properties). Later packs in the list win when two packs contain the same file - the same rule as the
// in-game resource pack list (the top pack wins).
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const { extractZip, createZip } = require('./archive');
const { readJarVersion } = require('./zipread');

const MAX_PACK = 250 * 1024 * 1024;

/** pack format of the server's Minecraft version: {major, minor} or null */
function resourceFormat(serverJar) {
  const v = readJarVersion(serverJar);
  const pv = v && v.pack_version;
  if (!pv) return null;
  if (typeof pv === 'number') return { major: pv, minor: 0 };
  if (pv.resource_major != null) return { major: pv.resource_major, minor: pv.resource_minor || 0 };
  if (pv.resource != null) return { major: pv.resource, minor: 0 };
  return null;
}

/** Folder inside an extracted zip that holds pack.mcmeta (packs are sometimes zipped with an extra folder). */
function packRoot(dir) {
  if (fs.existsSync(path.join(dir, 'pack.mcmeta'))) return dir;
  const subs = fs.readdirSync(dir, { withFileTypes: true }).filter(e => e.isDirectory());
  for (const s of subs) if (fs.existsSync(path.join(dir, s.name, 'pack.mcmeta'))) return path.join(dir, s.name);
  return null;
}

async function copyTree(src, dst, skipTop) {
  for (const e of await fsp.readdir(src, { withFileTypes: true })) {
    if (skipTop && skipTop.includes(e.name)) continue;
    const s = path.join(src, e.name), d = path.join(dst, e.name);
    if (e.isDirectory()) { await fsp.mkdir(d, { recursive: true }); await copyTree(s, d); }
    else { await fsp.mkdir(path.dirname(d), { recursive: true }); await fsp.copyFile(s, d); }
  }
}

/**
 * zips: [{file, name}] lowest priority first. Returns {file, sha1, size, names}.
 * outDir: where to put "server-pack-<sha1>.zip" (old ones are removed).
 */
async function mergePacks(zips, outDir, serverJar, workDir) {
  if (!zips.length) throw new Error('The player kit has no texture packs.');
  const work = path.join(workDir, `.rpmerge-${Date.now()}`);
  const out = path.join(work, 'merged');
  await fsp.mkdir(out, { recursive: true });
  const used = [];
  let maxFmt = 0;
  try {
    for (const [i, z] of zips.entries()) {
      const x = path.join(work, 'x' + i);
      await extractZip(z.file, x);
      const root = packRoot(x);
      if (!root) continue;                                   // not a resource pack - skip
      try { const m = JSON.parse(fs.readFileSync(path.join(root, 'pack.mcmeta'), 'utf8')).pack || {}; maxFmt = Math.max(maxFmt, Number([].concat(m.max_format || m.pack_format || 0)[0]) || 0); } catch { /* bad mcmeta */ }
      await copyTree(root, out, ['pack.mcmeta']);           // later packs overwrite earlier files (higher priority)
      used.push(z.name.replace(/\.zip$/i, ''));
    }
    if (!used.length) throw new Error('None of the kit files is a valid texture pack (no pack.mcmeta).');
    const fmt = resourceFormat(serverJar) || (maxFmt ? { major: maxFmt, minor: 0 } : null);
    if (!fmt) throw new Error('Could not work out the pack format for this Minecraft version.');
    const f = fmt.minor ? [fmt.major, fmt.minor] : fmt.major;
    fs.writeFileSync(path.join(out, 'pack.mcmeta'), JSON.stringify({ pack: { description: `Server packs: ${used.join(', ')}`.slice(0, 200), min_format: f, max_format: f } }, null, 2));
    const tmpZip = path.join(work, 'merged.zip');
    await createZip(out, fs.readdirSync(out), tmpZip);
    const buf = fs.readFileSync(tmpZip);
    if (buf.length > MAX_PACK) throw new Error('The merged pack is bigger than 250 MB - Minecraft refuses packs that big. Remove some texture packs.');
    const sha1 = crypto.createHash('sha1').update(buf).digest('hex');
    await fsp.mkdir(outDir, { recursive: true });
    for (const old of fs.readdirSync(outDir)) if (/^server-pack-[0-9a-f]{40}\.zip$/.test(old)) fs.rmSync(path.join(outDir, old), { force: true });
    const file = path.join(outDir, `server-pack-${sha1}.zip`);
    fs.writeFileSync(file, buf);
    return { file, sha1, size: buf.length, names: used, format: fmt };
  } finally { fs.rm(work, { recursive: true, force: true }, () => {}); }
}

module.exports = { mergePacks, resourceFormat, MAX_PACK };
