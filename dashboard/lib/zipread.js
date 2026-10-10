'use strict';
// Minimal ZIP reader: extracts a single entry (used to read version.json from server.jar).
const fs = require('fs');
const zlib = require('zlib');

function readZipEntry(file, entryName) {
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    const tailLen = Math.min(size, 65557);
    const tail = Buffer.alloc(tailLen);
    fs.readSync(fd, tail, 0, tailLen, size - tailLen);
    let eocd = -1;
    for (let i = tailLen - 22; i >= 0; i--) {
      if (tail.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) return null;
    const cdSize = tail.readUInt32LE(eocd + 12);
    const cdOffset = tail.readUInt32LE(eocd + 16);
    const cd = Buffer.alloc(cdSize);
    fs.readSync(fd, cd, 0, cdSize, cdOffset);
    let p = 0;
    while (p + 46 <= cd.length && cd.readUInt32LE(p) === 0x02014b50) {
      const method = cd.readUInt16LE(p + 10);
      const compSize = cd.readUInt32LE(p + 20);
      const nameLen = cd.readUInt16LE(p + 28);
      const extraLen = cd.readUInt16LE(p + 30);
      const commentLen = cd.readUInt16LE(p + 32);
      const localOff = cd.readUInt32LE(p + 42);
      const name = cd.toString('utf8', p + 46, p + 46 + nameLen);
      if (name === entryName) {
        const lh = Buffer.alloc(30);
        fs.readSync(fd, lh, 0, 30, localOff);
        const dataStart = localOff + 30 + lh.readUInt16LE(26) + lh.readUInt16LE(28);
        const data = Buffer.alloc(compSize);
        fs.readSync(fd, data, 0, compSize, dataStart);
        if (method === 0) return data;
        if (method === 8) return zlib.inflateRawSync(data);
        return null;
      }
      p += 46 + nameLen + extraLen + commentLen;
    }
    return null;
  } finally { fs.closeSync(fd); }
}

const jarCache = new Map();
/** Returns parsed version.json from a Minecraft server jar, or null (cached until the jar changes). */
function readJarVersion(jarPath) {
  try {
    const st = fs.statSync(jarPath);
    const c = jarCache.get(jarPath);
    if (c && c.mtimeMs === st.mtimeMs && c.size === st.size) return c.v;
    const buf0 = readZipEntry(jarPath, 'version.json');
    const v = buf0 ? JSON.parse(buf0.toString('utf8')) : null;
    jarCache.set(jarPath, { mtimeMs: st.mtimeMs, size: st.size, v });
    return v;
  } catch { return null; }
}
/** Opens a zip once and lets you list/read many entries. Returns {names, read(name)->Buffer|null, size(name)} or null. */
function openZip(file) {
  let buf;
  try { buf = fs.readFileSync(file); } catch { return null; }
  const tailStart = Math.max(0, buf.length - 65557);
  let eocd = -1;
  for (let i = buf.length - 22; i >= tailStart; i--) if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) return null;
  const count = buf.readUInt16LE(eocd + 10), cdOffset = buf.readUInt32LE(eocd + 16);
  const entries = new Map();
  let p = cdOffset;
  for (let n = 0; n < count && p + 46 <= buf.length && buf.readUInt32LE(p) === 0x02014b50; n++) {
    const nameLen = buf.readUInt16LE(p + 28), extraLen = buf.readUInt16LE(p + 30), commentLen = buf.readUInt16LE(p + 32);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    entries.set(name, { method: buf.readUInt16LE(p + 10), comp: buf.readUInt32LE(p + 20), size: buf.readUInt32LE(p + 24), off: buf.readUInt32LE(p + 42) });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return {
    names: [...entries.keys()],
    size: n => (entries.get(n) || {}).size || 0,
    read(n) {
      const e = entries.get(n); if (!e) return null;
      try {
        const start = e.off + 30 + buf.readUInt16LE(e.off + 26) + buf.readUInt16LE(e.off + 28);
        const data = buf.subarray(start, start + e.comp);
        if (e.method === 0) return data;
        if (e.method === 8) return zlib.inflateRawSync(data);
      } catch { /* damaged entry */ }
      return null;
    },
  };
}
module.exports = { readZipEntry, readJarVersion, openZip };
