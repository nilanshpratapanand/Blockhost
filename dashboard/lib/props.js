'use strict';
// server.properties reader/writer that keeps comments and line order.
const fs = require('fs');

function unescape(v) {
  return v.replace(/\\u([0-9a-fA-F]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16))).replace(/\\([:=#!\\ ])/g, '$1');
}
function escapeKey(k) { return k.replace(/([:= ])/g, '\\$1'); }

function read(file) {
  let text = '';
  try { text = fs.readFileSync(file, 'utf8'); } catch { return { lines: [], map: {} }; }
  const lines = text.split(/\r?\n/);
  const map = {};
  for (const line of lines) {
    const m = line.match(/^\s*([^#!][^=]*?)\s*=(.*)$/);
    if (m) map[unescape(m[1])] = unescape(m[2]);
  }
  return { lines, map };
}

const cache = new Map(); // file -> {mtimeMs, size, map}
function getAll(file) {
  let st; try { st = fs.statSync(file); } catch { return {}; }
  const c = cache.get(file);
  if (c && c.mtimeMs === st.mtimeMs && c.size === st.size) return { ...c.map };
  const map = read(file).map;
  cache.set(file, { mtimeMs: st.mtimeMs, size: st.size, map });
  return { ...map };
}

/** Update or add keys. values are plain strings. */
function setMany(file, changes) {
  const { lines } = read(file);
  const done = new Set();
  const out = lines.map(line => {
    const m = line.match(/^\s*([^#!][^=]*?)\s*=(.*)$/);
    if (!m) return line;
    const key = unescape(m[1]);
    if (Object.prototype.hasOwnProperty.call(changes, key)) {
      done.add(key);
      return `${escapeKey(key)}=${sanitize(changes[key])}`;
    }
    return line;
  });
  while (out.length && out[out.length - 1] === '') out.pop();
  for (const [k, v] of Object.entries(changes)) {
    if (!done.has(k)) out.push(`${escapeKey(k)}=${sanitize(v)}`);
  }
  fs.writeFileSync(file, out.join('\n') + '\n');
  cache.delete(file);
}

// Java reads .properties as Latin-1 on some versions: write non-ASCII (e.g. the § color sign) as \\uXXXX escapes.
function sanitize(v) {
  return String(v ?? '').replace(/[\r\n]/g, ' ').replace(/[^\x20-\x7e]/g, c => '\\u' + c.charCodeAt(0).toString(16).toUpperCase().padStart(4, '0'));
}

module.exports = { getAll, setMany };
