'use strict';
// Downloads what a friend's PC needs to host, into the Blockhost Sync folder (no admin rights, nothing system-wide):
// a portable Java (Eclipse Temurin JRE from the Adoptium API, SHA-256 checked) and the signed playit.gg agent.
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const { openZip } = require('./zipread');
const { javaMajor } = require('./java');
const { download, fetchJSON, IS_WIN, moveFile } = require('./util');

const sha256File = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const javaExe = dir => path.join(dir, 'bin', IS_WIN ? 'java.exe' : 'java');

/** Extract a zip safely (no path escapes). Drops one leading folder when every entry shares it. Returns the file count. */
function extractZip(zipFile, dest, { stripTop = true } = {}) {
  const z = openZip(zipFile);
  if (!z) throw new Error('The downloaded file is not a valid zip.');
  const names = z.names.filter(n => n && !n.startsWith('__MACOSX/'));
  let strip = '';
  if (stripTop) {
    const tops = new Set(names.map(n => n.split('/')[0]));
    if (tops.size === 1 && names.every(n => n.includes('/'))) strip = [...tops][0] + '/';
  }
  const root = path.resolve(dest);
  let count = 0;
  for (const n of names) {
    const rel = n.slice(strip.length);
    if (!rel) continue;
    const out = path.resolve(root, rel);
    if (out !== root && !out.startsWith(root + path.sep)) throw new Error('Unsafe path inside the zip: ' + n);
    if (n.endsWith('/')) { fs.mkdirSync(out, { recursive: true }); continue; }
    const data = z.read(n);
    if (!data) throw new Error('Could not unpack ' + n);
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, data);
    count++;
  }
  return count;
}

/** Make sure a Java >= major lives in <baseDir>/jre-<major>. Returns the java executable path. */
async function ensureJre(baseDir, major, { log = () => {}, progress = () => {}, getJSON = fetchJSON, dl = download } = {}) {
  const dir = path.join(baseDir, 'jre-' + major);
  const exe = javaExe(dir);
  if (fs.existsSync(exe) && javaMajor(exe) >= major) return exe;
  const os = IS_WIN ? 'windows' : process.platform === 'darwin' ? 'mac' : 'linux';
  const api = `https://api.adoptium.net/v3/assets/latest/${major}/hotspot?architecture=x64&image_type=jre&os=${os}&vendor=eclipse`;
  log(`Looking up Java ${major} (Eclipse Temurin)...`);
  const list = await getJSON(api);
  const pkg = Array.isArray(list) && list[0] && list[0].binary && list[0].binary.package;
  if (!pkg || !pkg.link || !pkg.checksum) throw new Error(`Adoptium has no Java ${major} download for this PC.`);
  if (!/^https:\/\/(github\.com|api\.adoptium\.net|adoptium\.net)\//.test(pkg.link)) throw new Error('Unexpected Java download address.');
  await fsp.mkdir(baseDir, { recursive: true });
  const zip = path.join(baseDir, `jre-${major}.zip.download`);
  const tmpDir = path.join(baseDir, `jre-${major}.unpacking`);
  try {
    log(`Downloading Java ${major} (${Math.round((pkg.size || 0) / 1048576)} MB)...`);
    await dl(pkg.link, zip, pct => progress(pct));
    if (sha256File(zip) !== String(pkg.checksum).toLowerCase()) throw new Error('The Java download did not match its checksum. Not installing it.');
    log('Unpacking Java...');
    await fsp.rm(tmpDir, { recursive: true, force: true });
    extractZip(zip, tmpDir);
    if (!fs.existsSync(javaExe(tmpDir))) throw new Error('The Java package looks wrong (no java executable inside).');
    await fsp.rm(dir, { recursive: true, force: true });
    await moveFile(tmpDir, dir);
  } finally {
    await fsp.rm(zip, { force: true }).catch(() => {});
    await fsp.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
  if (javaMajor(exe) < major) throw new Error('The downloaded Java would not start.');
  log(`Java ${major} ready.`);
  return exe;
}

module.exports = { extractZip, ensureJre, sha256File, javaExe };
