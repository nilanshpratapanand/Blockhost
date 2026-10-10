'use strict';
// CurseForge source for the pack library. Needs the user's own free API key from https://console.curseforge.com
// (CurseForge requires a key for every app). Authors can forbid third-party downloads
// (allowModDistribution=false / downloadUrl=null) - we respect that and link to the page instead.
const { UA } = require('./util');

const API = process.env.BLOCKHOST_CURSEFORGE || 'https://api.curseforge.com/v1';
const GAME = 432;                                   // Minecraft
const CLASS = { mod: 6, resourcepack: 12, shader: 6552, datapack: 6945 };
const FABRIC = 4;

/** Keys get mangled when copied: spaces, quotes, invisible characters. */
const cleanKey = k => String(k || '').replace(/[\u200B-\u200D\uFEFF\s"'`]/g, '');
const isCfUrl = u => /(^|\.)(forgecdn\.net|curseforge\.com)(\/|$|:)/i.test(String(u || '').replace(/^https?:\/\//, ''));

async function cf(key, pathq) {
  const res = await fetch(API + pathq, { headers: { 'x-api-key': cleanKey(key), Accept: 'application/json', 'User-Agent': UA }, signal: AbortSignal.timeout(20000) });
  if (res.status === 403 || res.status === 401) {
    const body = (await res.text().catch(() => '')).slice(0, 160).replace(/\s+/g, ' ');
    const e = new Error(`CurseForge rejected the API key (HTTP ${res.status}${body ? ': ' + body : ''}). In console.curseforge.com press Regenerate, copy the new key with the copy button and paste it again.`);
    e.code = 'CF_KEY'; throw e;
  }
  if (!res.ok) throw new Error(`CurseForge HTTP ${res.status}`);
  return res.json();
}

/** Settings > "Test key": one cheap request, exact answer. */
async function test(key) {
  const k = cleanKey(key);
  if (!k) throw new Error('Paste the key first.');
  const hints = [];
  if (!/^\$2a\$\d\d\$/.test(k)) hints.push('CurseForge keys usually start with $2a$10$ - make sure you copied the whole key with the copy button.');
  const r = await cf(k, '/games/432').catch(e => { e.message += hints.length ? ' ' + hints.join(' ') : ''; throw e; });
  return { ok: true, game: r && r.data && r.data.name, length: k.length };
}

async function search(key, type, q, version, offset = 0) {
  const p = new URLSearchParams({ gameId: GAME, classId: CLASS[type], searchFilter: q || '', sortField: 2, sortOrder: 'desc', pageSize: 24, index: Number(offset) || 0 });
  if (version) p.set('gameVersion', version);
  if (type === 'mod') p.set('modLoaderType', FABRIC);
  const r = await cf(key, `/mods/search?${p}`);
  return {
    total: r.pagination ? r.pagination.totalCount : (r.data || []).length,
    hits: (r.data || []).map(m => ({
      id: 'cf:' + m.id, slug: m.slug, title: m.name, description: m.summary, author: (m.authors && m.authors[0] && m.authors[0].name) || '',
      icon: m.logo && m.logo.thumbnailUrl, downloads: m.downloadCount, source: 'curseforge', page: m.links && m.links.websiteUrl,
      canDownload: m.allowModDistribution !== false,
    })),
  };
}

/** Newest file for a version (+ Fabric for mods). Returns {url, filename, sha1, deps:[cfIds], page} */
async function bestFile(key, type, cfId, version, allowAny) {
  const id = String(cfId).replace(/^cf:/, '');
  const mod = (await cf(key, `/mods/${id}`)).data;
  const p = new URLSearchParams({ pageSize: 50 });
  if (version) p.set('gameVersion', version);
  if (type === 'mod') p.set('modLoaderType', FABRIC);
  let files = (await cf(key, `/mods/${id}/files?${p}`)).data || [];
  let exact = true;
  if (!files.length && allowAny && type !== 'mod') { files = (await cf(key, `/mods/${id}/files?pageSize=50`)).data || []; exact = false; }
  if (!files.length) throw new Error(type === 'mod' ? `"${mod.name}" has no Fabric build for ${version} on CurseForge yet.` : `"${mod.name}" has no file for ${version}. Try "Any version".`);
  files.sort((a, b) => new Date(b.fileDate) - new Date(a.fileDate));
  const f = files[0];
  const page = mod.links && mod.links.websiteUrl;
  if (!f.downloadUrl || mod.allowModDistribution === false) {
    const e = new Error(`The author of "${mod.name}" only allows downloads from the CurseForge website. Download it there, then use "Upload file".`);
    e.code = 'MANUAL'; e.page = page; throw e;
  }
  const sha = (f.hashes || []).find(h => h.algo === 1);
  return {
    url: f.downloadUrl, filename: f.fileName, sha1: sha ? sha.value : null, size: f.fileLength, exact, page, title: mod.name, slug: mod.slug,
    deps: (f.dependencies || []).filter(d => d.relationType === 3).map(d => 'cf:' + d.modId),
  };
}

/** Resolve a curseforge.com page URL to {id, type, title}. */
async function fromUrl(key, url) {
  const m = String(url).match(/curseforge\.com\/minecraft\/(texture-packs|mc-mods|shaders|data-packs|customization)\/([\w-]+)/i);
  if (!m) return null;
  const type = { 'texture-packs': 'resourcepack', 'mc-mods': 'mod', shaders: 'shader', 'data-packs': 'datapack', customization: 'shader' }[m[1].toLowerCase()];
  const r = await cf(key, `/mods/search?${new URLSearchParams({ gameId: GAME, slug: m[2], classId: CLASS[type] })}`);
  const mod = (r.data || [])[0];
  return mod ? { source: 'curseforge', id: 'cf:' + mod.id, type, title: mod.name, icon: mod.logo && mod.logo.thumbnailUrl, page: mod.links && mod.links.websiteUrl, canDownload: mod.allowModDistribution !== false } : null;
}

module.exports = { search, bestFile, fromUrl, test, cleanKey, isCfUrl, CLASS };
