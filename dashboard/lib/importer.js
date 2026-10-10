'use strict';
// "Paste a list" importer: takes text like a YouTube description ("Name by Author – text ♡ link ...")
// and finds each pack/mod on Modrinth (and CurseForge if a key is set).
const { fetchJSON } = require('./util');

const API = process.env.BLOCKHOST_MODRINTH || 'https://api.modrinth.com/v2';
// things people list that are tools/launchers/server-side, not installable client content
const NOISE = /^(multimc|prism( launcher)?|tlauncher|fabric( loader)?|forge|quilt|neoforge|obs( studio)?|davinci resolve.*|edited in.*|filmed with.*|replay mod.*|chapters?|intro|outro|advertisement|all download links.*|tools( & mods)?|resource packs|mods|shaders|where to download)$/i;

function decodeLink(u) {
  try {
    const url = new URL(u);
    if (/youtube\.com$/.test(url.hostname) && url.pathname === '/redirect' && url.searchParams.get('q')) return url.searchParams.get('q');
    return u;
  } catch { return u; }
}

/** -> [{name, link}] */
function parse(text) {
  const links = [];
  const tok = u => { links.push(decodeLink(u)); return ` @@LINK${links.length - 1}@@ `; };
  let t = String(text)
    // YouTube-style "https://short[...](https://real)" and markdown "[label](url)" -> one link token
    .replace(/\S*\[[^\]]*\]\((https?:\/\/[^)\s]+)\)/g, (m, u) => tok(u))
    .replace(/https?:\/\/[^\s)\]]+/g, m => tok(m))
    .replace(/^\s*(RESOURCE PACKS|TEXTURE PACKS|SHADERS|MODS|TOOLS\s*&\s*MODS)\s*/gim, ' ♡ ')
    .replace(/\b(RESOURCE PACKS|TEXTURE PACKS|TOOLS\s*&\s*MODS)\b/g, ' ♡ ');
  const parts = t.split(/♡|♡|\n|•|\|/).map(s => s.trim()).filter(Boolean);
  const out = [];
  const seen = new Set();
  for (let raw of parts) {
    // a link at the start of a segment belongs to the item before it ("Name by X – text ♡ link")
    let m;
    while ((m = raw.match(/^@@LINK(\d+)@@\s*/))) {
      const prev = out.slice(-3).find(o => !o.link);   // earliest unlinked of the last few names
      const l = links[Number(m[1])];
      if (prev && !/youtube\.com|youtu\.be/.test(l)) prev.link = l;
      raw = raw.slice(m[0].length);
    }
    const linkIds = [...raw.matchAll(/@@LINK(\d+)@@/g)].map(x => Number(x[1])).filter(i => !/youtube\.com|youtu\.be/.test(links[i]));
    let p = raw.replace(/@@LINK\d+@@/g, ' ').replace(/\*+/g, '').replace(/\s+/g, ' ').trim()
      .replace(/^[^\p{L}\p{N}]+/u, '').replace(/[^\p{L}\p{N})'’!]+$/u, '').trim();   // emoji bullets like 🌻 ✨
    if (!p || /^[\s\-–—:]*$/.test(p) || /^\d{1,2}:\d{2}/.test(p)) continue;
    let names;
    const by = p.match(/^(.+?)\s+by\s+[^–—]+?(\s+[–—-]\s+|$)/i);
    // "Sodium & Iris" / "Fresh Leaves & Fresh Leaves Blossom" are two things, "Flowering Grass & Roots" is one
    const splitAmp = str => {
      const sides = str.split(/\s+&\s+/);
      if (sides.length !== 2) return [str];
      const [a, b] = sides;
      return (!a.includes(' ') && !b.includes(' ')) || a.split(' ')[0].toLowerCase() === b.split(' ')[0].toLowerCase() ? sides : [str];
    };
    if (by) names = splitAmp(by[1]);
    else if (p.length <= 40 && !/[.!?]$/.test(p) && p.split(' ').length <= 5) names = p.split(/,\s*/).flatMap(splitAmp);
    else continue;                                                // a sentence, not a name
    for (let n of names) {
      n = n.replace(/^[\s\-–—:]+|[\s\-–—:]+$/g, '').replace(/[’`]/g, "'").trim();
      const key = n.toLowerCase().replace(/[^a-z0-9]/g, '');
      if (!n || n.length < 3 || NOISE.test(n) || seen.has(key)) continue;
      if (/^\d+[wdhmy]$/i.test(n) || (/^[a-z0-9_.]{8,}$/.test(n))) continue;   // "83w" timestamps, @handles
      // "Fresh Leaves" after "Fresh Leaves & Fresh Leaves Blossom" etc. - skip near-duplicates
      seen.add(key);
      out.push({ name: n, link: linkIds.length ? links[linkIds[0]] : null });
    }
  }
  return out;
}

const norm = s => String(s).toLowerCase().replace(/['’`]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
function similar(a, b) {
  const x = norm(a), y = norm(b);
  if (!x || !y) return 0;
  if (x === y) return 1;
  if (y.includes(x) || x.includes(y)) return 0.85;
  const A = new Set(x.split(' ')), B = new Set(y.split(' '));
  let common = 0; for (const t of A) if (B.has(t)) common++;
  return common / Math.max(A.size, B.size);
}

const TYPE_OF = { resourcepack: 'resourcepack', shader: 'shader', mod: 'mod', datapack: 'datapack' };

/** Find the best Modrinth match for a name (any content type). */
async function findModrinth(name, version) {
  const facets = [['project_type:mod', 'project_type:resourcepack', 'project_type:shader']];
  const r = await fetchJSON(`${API}/search?limit=5&query=${encodeURIComponent(name)}&facets=${encodeURIComponent(JSON.stringify(facets))}`);
  let best = null, score = 0;
  for (const h of r.hits || []) {
    const sc = similar(name, h.title);
    if (sc > score) { score = sc; best = h; }
  }
  if (!best || score < 0.5) return null;
  const type = TYPE_OF[best.project_type] || 'resourcepack';
  return {
    source: 'modrinth', id: best.project_id, type, title: best.title, icon: best.icon_url, author: best.author,
    page: `https://modrinth.com/${best.project_type}/${best.slug}`, score,
    forVersion: version ? (best.versions || []).includes(version) : null,
    serverSide: best.server_side || null, fabric: (best.categories || []).includes('fabric') || type !== 'mod',
  };
}

/** Modrinth page URL -> match */
async function fromModrinthUrl(url) {
  const m = String(url).match(/modrinth\.com\/(mod|resourcepack|shader|datapack|plugin)\/([\w.-]+)/i);
  if (!m) return null;
  const p = await fetchJSON(`${API}/project/${encodeURIComponent(m[2])}`);
  const type = TYPE_OF[p.project_type] || (m[1] === 'datapack' ? 'datapack' : 'resourcepack');
  return { source: 'modrinth', id: p.id, type, title: p.title, icon: p.icon_url, page: `https://modrinth.com/${p.project_type}/${p.slug}`, serverSide: p.server_side || null, canDownload: true };
}

/** Best match for one item, trying every source in order (link first, then name search). */
async function findAll(it, version, packs) {
  const tries = [];
  const key = packs && packs.getConfig().curseforgeKey;
  if (it.link && /modrinth\.com/.test(it.link)) tries.push(() => fromModrinthUrl(it.link));
  if (it.link && /curseforge\.com/.test(it.link) && key) tries.push(() => require('./curseforge').fromUrl(key, it.link));
  tries.push(() => findModrinth(it.name, version));
  if (key) tries.push(async () => {
    for (const type of ['resourcepack', 'mod', 'shader']) {
      const r = await packs.search(type, it.name, null, 0, 'curseforge');
      const h = r.hits.find(x => similar(it.name, x.title) >= 0.5);
      if (h) return { source: 'curseforge', id: h.id, type, title: h.title, icon: h.icon, author: h.author, page: h.page, canDownload: h.canDownload, forVersion: null };
    }
    return null;
  });
  const found = [];
  for (const t of tries) { try { const m = await t(); if (m && !found.some(f => f.id === m.id)) found.push(m); } catch { /* next source */ } }
  // prefer a source that allows direct download
  found.sort((a, b) => (b.canDownload !== false) - (a.canDownload !== false));
  return found;
}

async function resolve(text, version, packs) {
  const items = parse(text).slice(0, 40);
  const results = [];
  // small concurrency so we stay far below Modrinth's 300 req/min limit
  const queue = [...items];
  await Promise.all(Array.from({ length: 4 }, async () => {
    while (queue.length) {
      const it = queue.shift();
      let match = null, error = null, alternatives = [];
      try { const all = await findAll(it, version, packs); match = all[0] || null; alternatives = all.slice(1); } catch (e) { error = e.message; }
      results.push({ ...it, match, alternatives, error });
    }
  }));
  return items.map(it => results.find(r => r.name === it.name));
}

/** Single link or name -> list of matches (used by "Add from link"). */
async function lookup(input, version, packs) {
  const s = String(input).trim();
  const it = /^https?:\/\//.test(s) ? { name: decodeURIComponent(s.split('/').filter(Boolean).pop() || '').replace(/[-_]+/g, ' '), link: s } : { name: s, link: null };
  return { item: it, matches: await findAll(it, version, packs) };
}

module.exports = { parse, resolve, similar, lookup };
