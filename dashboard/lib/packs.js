'use strict';
// Resource packs (server-enforced), data packs (installed into the world) and shaders (player kit),
// all sourced from Modrinth's public API. https://docs.modrinth.com/api/
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const props = require('./props');
const { fetchJSON, download, moveFile } = require('./util');
const { createZip, extractZip } = require('./archive');
const { readZipEntry } = require('./zipread');
const cf = require('./curseforge');
const guard = require('./modguard');

const API = process.env.BLOCKHOST_MODRINTH || 'https://api.modrinth.com/v2';
const TYPES = {
  resourcepack: { facet: 'project_type:resourcepack', loaders: ['minecraft'] },
  datapack: { facet: 'categories:datapack', loaders: ['datapack'] },
  shader: { facet: 'project_type:shader', loaders: ['iris', 'optifine'] },
  mod: { facet: 'project_type:mod', extra: ['categories:fabric'], loaders: ['fabric'] },
};
const KNOWN_LOADERS = ['fabric', 'quilt', 'forge', 'neoforge', 'liteloader', 'rift'];
const KIT_FOLDER = { shader: 'shaderpacks', resourcepack: 'resourcepacks', mod: 'mods' };
const MAX_PACK = 250 * 1024 * 1024; // Minecraft's limit for server resource packs

class Packs {
  constructor(serverDir, dashDir, mc, getConfig, saveConfig) {
    this.dir = serverDir;
    this.kitDir = path.join(dashDir, 'player-kit');
    this.mc = mc; this.getConfig = getConfig; this.saveConfig = saveConfig;
  }

  propsFile() { return path.join(this.dir, 'server.properties'); }
  gameVersion() { const i = this.mc.jarInfo(); return i ? i.id : null; }
  datapackDir() {
    const lvl = props.getAll(this.propsFile())['level-name'] || 'world';
    return path.join(this.dir, lvl, 'datapacks');
  }

  cfKey() { const k = cf.cleanKey(this.getConfig().curseforgeKey); if (!k) { const e = new Error('Add your free CurseForge API key in Settings to search CurseForge.'); e.code = 'CF_KEY'; throw e; } return k; }

  async search(type, q, version, offset = 0, source = 'modrinth', loader = 'fabric') {
    if (source === 'curseforge') return cf.search(this.cfKey(), type, q, version, offset, loader, this.gameVersion());
    if (source === 'all') {
      const [a, b] = await Promise.all([
        this.search(type, q, version, offset, 'modrinth', loader).catch(() => ({ total: 0, hits: [] })),
        (this.getConfig().curseforgeKey ? cf.search(this.cfKey(), type, q, version, offset, loader, this.gameVersion()) : Promise.resolve({ total: 0, hits: [] })).catch(() => ({ total: 0, hits: [] })),
      ]);
      const seen = new Set(), hits = [];
      const norm = t => String(t).toLowerCase().replace(/[^a-z0-9]/g, '');
      for (let i = 0; i < Math.max(a.hits.length, b.hits.length); i++) for (const h of [a.hits[i], b.hits[i]]) {
        if (h && !seen.has(norm(h.title))) { seen.add(norm(h.title)); hits.push(h); }
      }
      return { total: a.total + b.total, hits };
    }
    const t = TYPES[type]; if (!t) throw new Error('Unknown pack type');
    const anyLoader = loader === 'any';
    const facets = [[t.facet]];
    if (t.extra && !anyLoader) for (const e of t.extra) facets.push([e]);
    if (type === 'mod' && !anyLoader) facets.push(['client_side:required', 'client_side:optional']);
    if (version) facets.push([`versions:${version}`]);
    const gv = this.gameVersion();
    const url = `${API}/search?limit=24&offset=${Number(offset) || 0}&index=${q ? 'relevance' : 'downloads'}`
      + `&query=${encodeURIComponent(q || '')}&facets=${encodeURIComponent(JSON.stringify(facets))}`;
    const r = await fetchJSON(url);
    return {
      total: r.total_hits,
      hits: (r.hits || []).map(h => {
        const cats = h.categories || [], vers = h.versions || [];
        const loaders = cats.filter(c => KNOWN_LOADERS.includes(c));
        return {
          id: h.project_id, slug: h.slug, title: h.title, description: h.description, author: h.author,
          icon: h.icon_url, downloads: h.downloads, versions: vers, categories: cats,
          clientSide: h.client_side || null, serverSide: h.server_side || null, source: 'modrinth',
          page: `https://modrinth.com/${h.project_type || type}/${h.slug}`, canDownload: true,
          compat: { loaders, latest: vers[vers.length - 1] || null,
            version: gv && vers.length ? vers.includes(gv) : null,
            loader: type === 'mod' ? (loaders.length ? loaders.includes('fabric') : null) : null },
        };
      }),
    };
  }

  /** Required dependencies of a Modrinth version (some only name a version, so resolve those to their project). */
  async requiredDeps(v) {
    const out = [];
    for (const d of v.dependencies || []) {
      if (d.dependency_type !== 'required') continue;
      let pid = d.project_id;
      if (!pid && d.version_id) { try { pid = (await fetchJSON(`${API}/version/${encodeURIComponent(d.version_id)}`)).project_id; } catch { /* unresolved */ } }
      if (pid && !out.includes(pid)) out.push(pid);
    }
    return out;
  }

  /** Newest version file of a project for our game version (or any version if allowAny). */
  async bestFile(type, id, version, allowAny) {
    if (String(id).startsWith('cf:')) return cf.bestFile(this.cfKey(), type, id, version, allowAny);
    const t = TYPES[type];
    const base = `${API}/project/${encodeURIComponent(id)}/version?include_changelog=false&loaders=${encodeURIComponent(JSON.stringify(t.loaders))}`;
    let list = version ? await fetchJSON(`${base}&game_versions=${encodeURIComponent(JSON.stringify([version]))}`) : [];
    let exact = true;
    if (!list.length && allowAny && type !== 'mod') { list = await fetchJSON(base); exact = false; }  // mods must match exactly or the game crashes
    if (!list.length && type === 'mod') {
      try {
        const p = await fetchJSON(`${API}/project/${encodeURIComponent(id)}`);
        const ld = p.loaders || [], gvs = p.game_versions || [];
        if (ld.length && !ld.includes('fabric')) throw Object.assign(new Error(`"${p.title}" is only made for ${ld.join(', ')} - there is no Fabric version, so it can't run in this kit/server. Download it from its page only if you switch the server to that loader.`), { final: true });
        if (version) throw Object.assign(new Error(`"${p.title}" has no Fabric build for Minecraft ${version} yet (newest supported: ${gvs[gvs.length - 1] || 'unknown'}). Mods must match the exact version.`), { final: true });
      } catch (e) { if (e.final) throw e; }
    }
    if (!list.length) throw new Error(version ? (type === 'mod' ? `This mod isn't released for Minecraft ${version} yet (mods must match the exact version).` : `No ${type} build for Minecraft ${version}. Tick "any version" to try an older one.`) : 'No downloadable files.');
    const v = list[0];
    const f = v.files.find(x => x.primary) || v.files[0];
    if (!f) throw new Error('This version has no files.');
    return { url: f.url, filename: f.filename, sha1: f.hashes && f.hashes.sha1, size: f.size, versionNumber: v.version_number, gameVersions: v.game_versions, exact,
      deps: await this.requiredDeps(v) };
  }

  // ------------------------------------------------------------- server resource pack
  serverPack() {
    const p = props.getAll(this.propsFile());
    const cfg = this.getConfig();
    let prompt = p['resource-pack-prompt'] || '';
    try { const j = JSON.parse(prompt); prompt = typeof j === 'string' ? j : (j.text || prompt); } catch { /* plain */ }
    return p['resource-pack'] ? { url: p['resource-pack'], sha1: p['resource-pack-sha1'] || '', require: p['require-resource-pack'] === 'true', prompt, name: cfg.serverPackName || path.basename(decodeURIComponent(p['resource-pack'].split('?')[0])) } : null;
  }

  async setServerPack({ url, sha1, name, require: mustAccept, prompt }, progress = () => {}) {
    if (!/^https:\/\//i.test(url || '') && !process.env.BLOCKHOST_ALLOW_HTTP) throw new Error('The pack link must start with https:// so players can download it.');
    if (/dropbox\.com/i.test(url) && !/dl=1/.test(url)) url = url.replace(/dl=0/, 'dl=1') + (/dl=1/.test(url) ? '' : (url.includes('?') ? '&dl=1' : '?dl=1'));
    // Always download once to verify it's a real pack and to compute/confirm the SHA-1 players will check.
    const tmp = path.join(this.dir, 'backups', `.pack-check-${Date.now()}.zip`);
    await fsp.mkdir(path.dirname(tmp), { recursive: true });
    try {
      progress('Downloading pack to verify it...', 10);
      const got = await download(url, tmp, pct => progress(null, 10 + Math.round(pct * 0.7)));
      const st = await fsp.stat(tmp);
      if (st.size > MAX_PACK) throw new Error('Pack is bigger than 250 MB - Minecraft will refuse it.');
      const head = Buffer.alloc(4); const fd = await fsp.open(tmp, 'r'); await fd.read(head, 0, 4, 0); await fd.close();
      if (head.readUInt32LE(0) !== 0x04034b50) throw new Error('That link is not a direct .zip download (got a web page?). Use a direct download link.');
      if (sha1 && sha1.toLowerCase() !== got) throw new Error('Checksum mismatch - the file changed while downloading.');
      progress('Checking pack.mcmeta...', 85);
      if (!readZipEntry(tmp, 'pack.mcmeta')) throw new Error('No pack.mcmeta at the top of the zip - this is not a resource pack.');
      props.setMany(this.propsFile(), {
        'resource-pack': url,
        'resource-pack-sha1': got,
        'resource-pack-id': crypto.randomUUID(),
        'require-resource-pack': String(!!mustAccept),
        'resource-pack-prompt': prompt ? JSON.stringify({ text: String(prompt) }) : '',
      });
      this.saveConfig({ serverPackName: name || path.basename(url.split('?')[0]) });
      progress('Server texture pack set.', 100);
      return { sha1: got, size: st.size };
    } finally { await fsp.rm(tmp, { force: true }); }
  }

  clearServerPack() {
    props.setMany(this.propsFile(), { 'resource-pack': '', 'resource-pack-sha1': '', 'resource-pack-id': '', 'require-resource-pack': 'false', 'resource-pack-prompt': '' });
    this.saveConfig({ serverPackName: '' });
  }

  // ------------------------------------------------------------- data packs
  listDatapacks() {
    const d = this.datapackDir();
    try {
      return fs.readdirSync(d, { withFileTypes: true }).filter(e => e.isDirectory() || /\.zip$/i.test(e.name))
        .map(e => ({ name: e.name, size: e.isDirectory() ? 0 : fs.statSync(path.join(d, e.name)).size, pending: this.pendingDeletes().includes(path.join(d, e.name)) }))
        .map((x, i, all) => {
          // same pack twice (e.g. "Dungeons and Taverns v6.0.1" + "v6.0.2") -> both load and fight
          const base = n => n.toLowerCase().replace(/\.(zip|dp\.zip)$/, '').replace(/[\s_\-]*v?\d+(\.\d+)+.*$/, '').replace(/[^a-z]/g, '');
          const twins = all.filter(y => y !== x && !y.pending && base(y.name) && base(y.name) === base(x.name));
          const warn = [];
          if (twins.length && !x.pending) warn.push(`Installed twice (also ${twins.map(t => t.name).join(', ')}) - keep only the newest.`);
          // made for an old Minecraft (e.g. "Mc1.21.1") while the server runs 26.x
          const gv = this.gameVersion() || '';
          const old = x.name.match(/mc[\s_\-]?(1\.\d+(?:\.\d+)?)/i);
          if (old && /^2\d\./.test(gv) && !x.name.includes(gv)) warn.push(`Made for Minecraft ${old[1]}, your server is ${gv} - may not work or break things.`);
          const g = this.dpguard ? this.dpguard.check(x.name) : { level: 'ok', reasons: [] };
          return { ...x, warn, guard: { level: g.level, reasons: g.reasons, trusted: !!(this.dpguard && this.dpguard.state().trusted.includes(x.name)) } };
        });
    } catch { return []; }
  }

  async installDatapack(id, allowAny, progress) {
    const d = this.datapackDir();
    if (!fs.existsSync(path.dirname(d))) throw new Error('There is no world yet - start the server once, then add data packs.');
    const f = await this.bestFile('datapack', id, this.gameVersion(), allowAny);
    await fsp.mkdir(d, { recursive: true });
    const safe = path.basename(f.filename).replace(/[^\w.\- ]/g, '_');
    const dest = path.join(d, safe);
    // already there? (Minecraft keeps loaded data packs open on Windows, so never overwrite one in use)
    if (fs.existsSync(dest)) {
      const have = crypto.createHash('sha1').update(fs.readFileSync(dest)).digest('hex');
      if (!f.sha1 || have === f.sha1) { progress(`${safe} is already installed.`, 100); return { file: safe, exact: f.exact, version: f.versionNumber, already: true }; }
      if (this.mc.isRunning()) throw new Error(`An older ${safe} is in use by the running server. Stop the server, then install again to update it.`);
    }
    progress(`Downloading ${safe}...`, 10);
    // download outside the world folder, so neither Minecraft nor a half-written file can clash
    const tmpDir = path.join(this.dir, 'backups', '.downloads');
    await fsp.mkdir(tmpDir, { recursive: true });
    const tmp = path.join(tmpDir, `${Date.now()}-${safe}.part`);
    const got = await download(f.url, tmp, pct => progress(null, 10 + Math.round(pct * 0.8)), cf.isCfUrl(f.url) ? { 'x-api-key': this.cfKey() } : null);
    if (f.sha1 && got !== f.sha1) { await fsp.rm(tmp, { force: true }); throw new Error('Checksum mismatch - download corrupted.'); }
    // would Minecraft 26.x refuse to load it? One bad data pack stops the whole server from starting.
    const g = this.dpguard ? this.dpguard.checkFile(tmp) : { level: 'ok', reasons: [] };
    if (g.level !== 'ok') {
      await fsp.rm(tmp, { force: true });
      const e = new Error(`${safe} was NOT installed - it ${g.level === 'broken' ? 'cannot load' : 'looks made for an older Minecraft'} on ${this.gameVersion() || 'this server'}: ${g.reasons[0]}. Installing it would stop your server from starting. Look for a version made for ${this.gameVersion() || 'your Minecraft'}.`);
      e.code = 'DP_BAD'; throw e;
    }
    try { await moveFile(tmp, dest); } finally { fsp.rm(tmp, { force: true }).catch(() => {}); }
    if (this.mc.state === 'online') { this.mc.send('reload'); progress('Installed and reloaded - active now.', 100); }
    else progress('Installed - active next time the server starts.', 100);
    return { file: safe, exact: f.exact, version: f.versionNumber };
  }

  // Files Windows wouldn't let us delete because the running server has them open - deleted once it stops.
  pendingFile() { return path.join(this.dashDir || path.dirname(this.kitDir), 'pending-deletes.json'); }
  pendingDeletes() { try { return JSON.parse(fs.readFileSync(this.pendingFile(), 'utf8')); } catch { return []; } }
  async processPendingDeletes() {
    const left = [];
    // half-finished downloads from older Blockhost versions ("... .zip.part" in world/datapacks)
    if (!this.mc.isRunning || !this.mc.isRunning()) {
      try { for (const f of fs.readdirSync(this.datapackDir())) if (/\.part$/i.test(f)) await fsp.rm(path.join(this.datapackDir(), f), { force: true }).catch(() => {}); } catch { /* no world yet */ }
    }
    for (const f of this.pendingDeletes()) { try { await fsp.rm(f, { recursive: true, force: true }); } catch { left.push(f); } }
    try { if (left.length) fs.writeFileSync(this.pendingFile(), JSON.stringify(left)); else fs.rmSync(this.pendingFile(), { force: true }); } catch { /* ignore */ }
    return left.length;
  }

  async removeDatapack(name) {
    const base = path.basename(String(name));
    const p = path.join(this.datapackDir(), base);
    if (!fs.existsSync(p)) throw new Error('Not found');
    const online = this.mc.state === 'online';
    if (online) { this.mc.send(`datapack disable "file/${base}"`); await new Promise(r => setTimeout(r, 1500)); }
    for (let i = 0; i < 6; i++) {
      try { await fsp.rm(p, { recursive: true, force: true }); if (online) this.mc.send('reload'); return { ok: true }; }
      catch (e) { if (!['EBUSY', 'EPERM', 'EACCES'].includes(e.code)) throw e; await new Promise(r => setTimeout(r, 400 + i * 300)); }
    }
    // Minecraft still holds the zip open (Windows) - it is switched off now; delete the file when the server stops
    const list = this.pendingDeletes(); if (!list.includes(p)) list.push(p);
    fs.writeFileSync(this.pendingFile(), JSON.stringify(list));
    return { ok: true, pending: true };
  }

  // ------------------------------------------------------------- player kit (shaders etc.)
  listKit() {
    const out = [], man = this.kitManifest();
    for (const sub of ['shaderpacks', 'resourcepacks', 'mods']) {
      const d = path.join(this.kitDir, sub);
      try { for (const f of fs.readdirSync(d)) out.push({ folder: sub, name: f, size: fs.statSync(path.join(d, f)).size, auto: !!(man.find(e => e.folder === sub && e.name === f) || {}).autoDep }); } catch { /* none */ }
    }
    return out;
  }

  kitManifest() { try { return JSON.parse(fs.readFileSync(path.join(this.kitDir, 'kit.json'), 'utf8')); } catch { return []; } }
  saveKitManifest(list) { fs.mkdirSync(this.kitDir, { recursive: true }); fs.writeFileSync(path.join(this.kitDir, 'kit.json'), JSON.stringify(list, null, 2)); }

  /** Kit files added before v1.3 have no download link saved - look them up on Modrinth by their SHA-1. */
  async migrateKit() {
    const man = this.kitManifest();
    let changed = false;
    for (const k of this.listKit()) {
      const ex = man.find(e => e.folder === k.folder && e.name === k.name);
      if (ex && (ex.url || ex.checked)) continue;
      if (ex) ex.checked = true;   // only look an uploaded file up once
      try {
        const sha1 = crypto.createHash('sha1').update(fs.readFileSync(path.join(this.kitDir, k.folder, k.name))).digest('hex');
        const v = await fetchJSON(`${API}/version_file/${sha1}?algorithm=sha1`);
        const f = (v.files || []).find(x => x.hashes && x.hashes.sha1 === sha1) || (v.files || [])[0];
        if (f) {
          const ex = man.find(e => e.folder === k.folder && e.name === k.name);
          if (ex) { ex.url = f.url; ex.local = false; ex.projectId = ex.projectId || v.project_id; }   // uploaded file that is also on Modrinth
          else man.push({ folder: k.folder, name: k.name, url: f.url, sha1, size: k.size, projectId: v.project_id });
          changed = true;
        }
      } catch { /* not on Modrinth / offline */ }
    }
    this.saveKitManifest(man);
    return man;
  }

  /** Newest Modrinth file of a mod (e.g. iris, sodium) for a game version + loader. */
  async modFile(slug, version, loader = 'fabric') {
    const list = await fetchJSON(`${API}/project/${encodeURIComponent(slug)}/version?include_changelog=false&loaders=${encodeURIComponent(JSON.stringify([loader]))}&game_versions=${encodeURIComponent(JSON.stringify([version]))}`);
    if (!list.length) return null;
    const f = list[0].files.find(x => x.primary) || list[0].files[0];
    return f ? { url: f.url, filename: path.basename(f.filename), sha1: f.hashes && f.hashes.sha1, version: list[0].version_number } : null;
  }

  async addToKit(type, id, allowAny, progress, _seen, force, ctx, opts) {
    const folder = KIT_FOLDER[type]; if (!folder) throw new Error('Unknown kit type');
    if (type === 'mod' && !ctx) return this.installModWithDeps(id, allowAny, progress, force, opts || {});   // mods always go through the dependency installer
    const seen = _seen || new Set();
    if (seen.has(id)) return { file: null }; seen.add(id);
    const f = await this.bestFile(type, id, this.gameVersion(), allowAny);
    let info = {};
    if (String(id).startsWith('cf:')) info = { slug: f.slug, title: f.title };
    else { try { info = await fetchJSON(`${API}/project/${encodeURIComponent(id)}`); } catch { /* optional */ } }
    if (type === 'mod' && info.server_side === 'required' && !force && !(ctx && ctx.depth > 0) && !this.guardRules().allow.map(x => x.toLowerCase()).includes(String(info.slug || '').toLowerCase())) {
      const e = new Error(`"${info.title || id}" adds new content (blocks/mobs/items) and must also run on the server. On your vanilla server it makes friends get "Network Protocol Error" when joining - so it was NOT added.`);
      e.code = 'SERVER_MOD'; throw e;
    }
    const d = path.join(this.kitDir, folder);
    await fsp.mkdir(d, { recursive: true });
    const safe = path.basename(f.filename).replace(/[^\w.\-+ ]/g, '_');
    // replace an older file of the same project
    progress(`Downloading ${safe}...`, 10);
    const got = await download(f.url, path.join(d, safe), pct => progress(null, 10 + Math.round(pct * 0.85)), cf.isCfUrl(f.url) ? { 'x-api-key': this.cfKey() } : null);
    if (f.sha1 && got !== f.sha1) { await fsp.rm(path.join(d, safe), { force: true }); throw new Error('Checksum mismatch - download corrupted.'); }
    if (type === 'mod' && !force) {   // Mod Guard: never let a wrong-loader / wrong-version / conflicting jar into the kit
      const bad = this.guardCandidate(safe);
      if (bad) { await fsp.rm(path.join(d, safe), { force: true }); const e = new Error(`Mod Guard blocked ${safe}: ${bad}`); e.code = 'GUARD'; throw e; }
    }
    for (const old of this.kitManifest().filter(e => e.projectId === id && e.folder === folder && e.name !== safe)) {
      if (ctx) ctx.st.removeLater.push({ folder, name: old.name }); else await fsp.rm(path.join(d, old.name), { force: true });   // inside an install the old file is only dropped once everything succeeded
    }
    const man = this.kitManifest().filter(e => !(e.folder === folder && (e.name === safe || e.projectId === id)));
    man.push({ folder, name: safe, url: f.url, sha1: got, size: f.size, projectId: id, slug: info.slug || null, title: info.title || null,
      serverSide: info.server_side || null, autoDep: !!(ctx && ctx.depth > 0) || undefined, depIds: (f.deps && f.deps.length) ? f.deps : undefined });
    this.saveKitManifest(man);
    const title = info.title || safe;
    if (ctx) ctx.st.added.push({ folder, name: safe, title, dep: ctx.depth > 0 });
    if (type === 'mod' && ctx && !ctx.st.noDeps) {
      for (const dep of f.deps) {
        if (this.kitManifest().some(e => e.projectId === dep) || ctx.st.skip.has(dep)) continue;
        progress(`Adding required mod for ${title}...`);
        try { await this.addToKit('mod', dep, false, progress, seen, force, { st: ctx.st, depth: ctx.depth + 1, parent: title }); }
        catch (e) {
          if (force) { progress(`Skipped a required mod of ${title}: ${e.message}`); continue; }
          if (e.code === 'DEP') throw e;
          const err = new Error(`“${title}” needs another mod that can't be installed (${e.message}) - so nothing was added.`); err.code = 'DEP'; throw err;
        }
      }
    }
    return { file: safe, title, added: [safe], serverSide: info.server_side || null };
  }

  /** Installs a mod PLUS everything it needs, as one all-or-nothing step: required mods first-class (Modrinth/CurseForge
   *  dependency data, then what the jars themselves declare), Mod Guard on every file, rollback if any piece fails. */
  async installModWithDeps(id, allowAny, progress, force, opts = {}) {
    const snapshot = this.kitManifest();
    const st = { added: [], removeLater: [], skip: new Set(), noDeps: !!opts.noDeps };
    const seen = new Set();
    try {
      const top = await this.addToKit('mod', id, allowAny, progress, seen, force, { st, depth: opts.asDep ? 1 : 0, parent: opts.parent || null });
      // pass 2: what the downloaded jars themselves say they need (covers CurseForge, uploads, thin Modrinth metadata)
      const tried = new Set();
      for (let pass = 0; pass < 6 && !force && !st.noDeps; pass++) {
        const mine = new Set(st.added.map(a => a.name));
        const need = this.guardScan().issues.filter(i => i.where === 'kit' && mine.has(i.mod) && (i.code === 'missing-dep' || i.code === 'dep-version') && !tried.has(i.code + ':' + (i.fix ? i.fix.dep : i.dep)));
        if (!need.length) break;
        for (const i of need) {
          const dep = i.fix ? i.fix.dep : i.dep; tried.add(i.code + ':' + dep);
          progress(`Adding required mod “${dep}”...`);
          try {
            const proj = await this.findDepProject(dep);
            await this.addToKit('mod', proj.id, false, progress, seen, force, { st, depth: 1, parent: top.title });
          } catch (e) {
            if (i.code === 'dep-version') { progress(`Couldn't update ${dep}: ${e.message}`); continue; }
            if (e.code === 'DEP') throw e;
            const err = new Error(`“${top.title || id}” needs “${dep}”, which can't be installed (${e.message}) - so nothing was added.`); err.code = 'DEP'; throw err;
          }
        }
      }
      for (const o of st.removeLater) await fsp.rm(path.join(this.kitDir, o.folder, o.name), { force: true });
      for (const a of st.added) await this.guardDropOlderCopies(a.name, progress);
      const deps = st.added.filter(a => a.dep && a.name !== top.file).map(a => a.title);
      progress(deps.length ? `Added ${top.title} + ${deps.length} required mod${deps.length > 1 ? 's' : ''}: ${deps.join(', ')}.` : `Added ${top.file || top.title} to the player kit.`, 100);
      return { file: top.file, added: st.added.map(a => a.name), deps, serverSide: top.serverSide };
    } catch (e) {
      for (const a of st.added.slice().reverse()) {
        if (snapshot.some(x => x.folder === a.folder && x.name === a.name)) continue;      // it was already there before - keep it
        await fsp.rm(path.join(this.kitDir, a.folder, a.name), { force: true }).catch(() => {});
      }
      this.saveKitManifest(snapshot);
      throw e;
    }
  }

  // ------------------------------------------------------------- manage single mods
  offDir() { return path.join(this.kitDir, 'mods-off'); }
  offManifest() { try { return JSON.parse(fs.readFileSync(path.join(this.kitDir, 'kit-off.json'), 'utf8')); } catch { return []; } }
  saveOffManifest(l) { fs.mkdirSync(this.kitDir, { recursive: true }); fs.writeFileSync(path.join(this.kitDir, 'kit-off.json'), JSON.stringify(l, null, 2)); }

  /** Installed mods for the manager: switched on (in the kit) and switched off (parked in mods-off, never shipped). */
  listMods() {
    const kit = this.guardScan().mods.filter(m => m.where === 'kit'), man = this.kitManifest();
    const BUILT = ['minecraft', 'java', 'fabricloader', 'fabric-loader', 'mixinextras'];
    const mods = kit.map(m => {
      const e = man.find(x => x.folder === 'mods' && x.name === m.name) || {};
      const requiredBy = kit.filter(o => o !== m && (o.needs || []).some(n => !BUILT.includes(n) && (m.provides || []).includes(n))).map(o => o.title || o.id || o.name);
      return { name: m.name, title: e.title || m.title || m.id || m.name, version: m.version, enabled: true, auto: !!e.autoDep, requiredBy };
    });
    const off = this.offManifest().filter(e => fs.existsSync(path.join(this.offDir(), e.name))).map(e => ({ name: e.name, title: e.title || e.name, version: null, enabled: false, auto: !!e.autoDep, requiredBy: [] }));
    return [...mods, ...off].sort((a, b) => String(a.title).localeCompare(String(b.title)));
  }
  /** Enabled mods that need `name`. */
  modDependents(name) {
    const kit = this.guardScan().mods.filter(m => m.where === 'kit');
    const me = kit.find(m => m.name === name); if (!me) return [];
    const BUILT = ['minecraft', 'java', 'fabricloader', 'fabric-loader', 'mixinextras'];
    return kit.filter(o => o !== me && (o.needs || []).some(n => !BUILT.includes(n) && (me.provides || []).includes(n))).map(o => ({ name: o.name, title: o.title || o.id || o.name }));
  }
  async removeMod(name, opts = {}) {
    const base = path.basename(String(name));
    if (this.offManifest().some(e => e.name === base)) {
      await fsp.rm(path.join(this.offDir(), base), { force: true });
      this.saveOffManifest(this.offManifest().filter(e => e.name !== base));
      return { ok: true, removed: [base] };
    }
    const direct = this.modDependents(base);
    if (direct.length && !opts.cascade) { const e = new Error(`${direct.map(d => d.title).join(', ')} need${direct.length === 1 ? 's' : ''} this mod.`); e.code = 'HAS_DEPENDENTS'; throw e; }
    const order = [];
    const walk = n => { for (const d of this.modDependents(n)) if (d.name !== base && !order.includes(d.name)) { order.push(d.name); walk(d.name); } };
    if (opts.cascade) walk(base);
    const removed = [];
    for (const n of [...order, base]) { await this.removeFromKit('mods', n); removed.push(n); }   // removeFromKit also drops libraries nothing needs any more
    return { ok: true, removed };
  }
  async disableMod(name) {
    const base = path.basename(String(name));
    const man = this.kitManifest(), e = man.find(x => x.folder === 'mods' && x.name === base);
    if (!fs.existsSync(path.join(this.kitDir, 'mods', base))) throw new Error('That mod is not switched on.');
    await fsp.mkdir(this.offDir(), { recursive: true });
    await fsp.rename(path.join(this.kitDir, 'mods', base), path.join(this.offDir(), base));
    this.saveKitManifest(man.filter(x => !(x.folder === 'mods' && x.name === base)));
    this.saveOffManifest([...this.offManifest().filter(x => x.name !== base), e || { folder: 'mods', name: base, local: true }]);
    await this.pruneOrphanDeps().catch(() => {});
    return { ok: true };
  }
  async enableMod(name, progress = () => {}) {
    const base = path.basename(String(name));
    const off = this.offManifest(), e = off.find(x => x.name === base) || { folder: 'mods', name: base, local: true };
    const from = path.join(this.offDir(), base), to = path.join(this.kitDir, 'mods', base);
    if (!fs.existsSync(from)) throw new Error('That mod is not switched off.');
    await fsp.mkdir(path.dirname(to), { recursive: true });
    await fsp.rename(from, to);
    const bad = this.guardCandidate(base);
    if (bad) { await fsp.rename(to, from); const err = new Error(`Mod Guard: ${bad}`); err.code = 'GUARD'; throw err; }
    this.saveKitManifest([...this.kitManifest().filter(x => !(x.folder === 'mods' && x.name === base)), e]);
    this.saveOffManifest(off.filter(x => x.name !== base));
    const warnings = [];
    for (const dep of e.depIds || []) {      // libraries that were removed while it was off come back by their remembered project
      if (this.kitManifest().some(x => x.projectId === dep)) continue;
      try { progress('Re-adding a required mod...'); await this.installModWithDeps(dep, false, progress, false, { asDep: true }); } catch (err) { warnings.push(err.message); }
    }
    for (const i of this.guardScan().issues.filter(i => i.code === 'missing-dep' && i.mod === base && i.where === 'kit')) {
      try { progress(`Adding required mod “${i.fix.dep}”...`); await this.guardAddDep(i.fix.dep, progress); } catch (err) { warnings.push(err.message); }
    }
    progress(warnings.length ? `Switched on, but: ${warnings.join(' ')}` : `Switched on ${e.title || base}.`, 100);
    return { ok: true, warnings };
  }
  /** What adding this mod would pull in (shown before installing, so the host can decide). */
  async planMod(id, depth = 0, seen = new Set()) {
    seen.add(id);
    const node = { id, title: String(id), ok: true, installed: this.kitManifest().some(e => e.projectId === id), serverSide: null, deps: [] };
    let f = null;
    try { f = await this.bestFile('mod', id, this.gameVersion(), false); } catch (e) { node.ok = false; node.reason = e.message; }
    if (String(id).startsWith('cf:')) node.title = (f && f.title) || node.title;
    else { try { const p = await fetchJSON(`${API}/project/${encodeURIComponent(id)}`); node.title = p.title || node.title; node.serverSide = p.server_side || null; } catch { /* keep id */ } }
    if (f && depth < 3) for (const d of f.deps) if (!seen.has(d)) node.deps.push(await this.planMod(d, depth + 1, seen));
    return node;
  }

  /** Mods that were only installed because another mod needed them, and that nothing needs any more, are removed. */
  async pruneOrphanDeps(progress = () => {}) {
    for (let pass = 0; pass < 5; pass++) {
      const auto = this.kitManifest().filter(e => e.folder === 'mods' && e.autoDep);
      if (!auto.length) return;
      const kit = this.guardScan().mods.filter(m => m.where === 'kit');
      const orphans = auto.filter(e => {
        const m = kit.find(x => x.name === e.name); if (!m) return false;
        const mine = new Set(m.provides || []);
        return !kit.some(o => o !== m && (o.needs || []).some(n => mine.has(n)));
      });
      if (!orphans.length) return;
      for (const o of orphans) { await fsp.rm(path.join(this.kitDir, 'mods', o.name), { force: true }); progress(`Removed ${o.title || o.name} (no mod needs it any more)`); }
      const gone = new Set(orphans.map(o => o.name));
      this.saveKitManifest(this.kitManifest().filter(e => !(e.folder === 'mods' && gone.has(e.name))));
    }
  }

  /** Which kit mods can break joining a VANILLA server ("Network Protocol Error")? */
  async kitCheck() {
    const SAFE = /^(fabric-?api|fabric-language-kotlin|cloth-config|modmenu|indium|sodium|iris|lithium|ferrite-?core|entityculling|continuity|cit-?resewn|yacl|architectury|lambdynamiclights|zoomify|ok-?zoomer|falling-?leaves|presence-?footsteps|illuminations)/i;
    const man = this.kitManifest();
    const out = [];
    let changed = false;
    for (const e of man.filter(x => x.folder === 'mods')) {
      let ss = e.serverSide || null;
      if (!ss && e.projectId && !String(e.projectId).startsWith('cf:') && !e.local) {
        try { ss = (await fetchJSON(`${API}/project/${encodeURIComponent(e.projectId)}`)).server_side || null; e.serverSide = ss; changed = true; } catch { /* offline */ }
      }
      let env = null, modId = null;
      try { const j = JSON.parse(String(readZipEntry(path.join(this.kitDir, 'mods', e.name), 'fabric.mod.json') || '{}')); env = j.environment || '*'; modId = j.id || null; } catch { /* not readable */ }
      let risk = 'ok', why = '';
      if (ss === 'required') { risk = 'breaks'; why = 'Modrinth says it must also be installed on the server (adds blocks/mobs/items).'; }
      else if (env === 'client' || ss === 'unsupported') { risk = 'ok'; why = 'Client-only mod.'; }
      else if (SAFE.test(e.slug || modId || e.name)) { risk = 'ok'; why = 'Known client-safe mod/library.'; }
      else if (env === '*' || env === null) { risk = 'ok'; why = 'Not marked as client-only - fine unless friends actually get a Network Protocol Error.'; }
      out.push({ name: e.name, title: e.title || modId || e.name, risk, why, serverSide: ss, environment: env });
    }
    if (changed) this.saveKitManifest(man);
    const order = { breaks: 0, maybe: 1, ok: 2 };
    return out.sort((a, b) => order[a.risk] - order[b.risk]);
  }

  // ------------------------------------------------------------- Mod Guard
  modDirs() {
    const out = [{ dir: path.join(this.kitDir, 'mods'), kind: 'kit' }];
    const sd = path.join(this.dir, 'mods');
    if (fs.existsSync(sd)) out.push({ dir: sd, kind: 'server' });
    return out;
  }
  rulesFile() { return path.join(this.kitDir, 'guard-rules.json'); }
  guardRules() {
    try { const r = JSON.parse(fs.readFileSync(this.rulesFile(), 'utf8')); return { allow: Array.isArray(r.allow) ? r.allow : [], pairs: Array.isArray(r.pairs) ? r.pairs : [] }; } catch { return { allow: [], pairs: [] }; }
  }
  saveGuardRules(r) { fs.mkdirSync(this.kitDir, { recursive: true }); fs.writeFileSync(this.rulesFile(), JSON.stringify(r, null, 2)); }
  guardAllow(id) {
    const v = String(id || '').trim().toLowerCase(); if (!v) throw new Error('Which mod?');
    const r = this.guardRules(); if (!r.allow.map(x => x.toLowerCase()).includes(v)) r.allow.push(v); this.saveGuardRules(r); return { ok: true };
  }
  guardUnallow(id) { const v = String(id || '').toLowerCase(); const r = this.guardRules(); r.allow = r.allow.filter(x => x.toLowerCase() !== v); this.saveGuardRules(r); return { ok: true }; }
  guardAddPair(bad, other, why) {
    bad = String(bad || '').trim(); other = String(other || '').trim();
    if (!bad || !other || bad.toLowerCase() === other.toLowerCase()) throw new Error('Pick two different mods.');
    const r = this.guardRules();
    if (!r.pairs.some(p => p.bad.toLowerCase() === bad.toLowerCase() && p.other.toLowerCase() === other.toLowerCase())) r.pairs.push({ bad, other, why: String(why || '').slice(0, 200) || 'You marked these two as incompatible.' });
    this.saveGuardRules(r); return { ok: true };
  }
  guardRemovePair(bad, other) { const r = this.guardRules(); r.pairs = r.pairs.filter(p => !(p.bad === bad && p.other === other)); this.saveGuardRules(r); return { ok: true }; }
  guardAnalyze(text) { return guard.analyze(text, this.guardScan().mods); }
  guardDisabled() { try { return fs.readdirSync(path.join(this.dir, 'mods-disabled')).filter(n => /\.jar$/i.test(n)); } catch { return []; } }
  async guardRestore(file) {
    const base = path.basename(String(file));
    await fsp.mkdir(path.join(this.dir, 'mods'), { recursive: true });
    await fsp.rename(path.join(this.dir, 'mods-disabled', base), path.join(this.dir, 'mods', base));
    return { ok: true };
  }
  guardScan() { const s = guard.scan(this.modDirs(), this.gameVersion(), this.guardRules()); s.disabled = this.guardDisabled(); return s; }

  /** Reason a freshly added kit jar must NOT be kept (null = fine). Missing libraries are not a reason: they get added next. */
  guardCandidate(safe) {
    for (const i of this.guardScan().issues) {
      if (i.level !== 'error' || i.code === 'missing-dep') continue;
      if (i.mod !== safe && !i.others.includes(safe)) continue;
      if (i.code === 'duplicate') { if (i.mod === safe) return `you already have a newer copy of this mod (${i.others[0]}).`; continue; }
      return `${i.title}. ${i.why}`;
    }
    return null;
  }
  /** After adding a newer version of a mod, drop the older copy so Fabric never sees two. */
  async guardDropOlderCopies(safe, progress) {
    for (const i of this.guardScan().issues) {
      if (i.code === 'duplicate' && i.others.includes(safe) && i.mod !== safe && i.where === 'kit') {
        await this.removeFromKit('mods', i.mod); progress(`Replaced older ${i.mod}`);
      }
    }
  }
  async guardRemove(file, where) {
    const base = path.basename(String(file));
    if (where === 'server') {   // never hard-delete from the live server: park it
      const off = path.join(this.dir, 'mods-disabled');
      await fsp.mkdir(off, { recursive: true });
      await fsp.rename(path.join(this.dir, 'mods', base), path.join(off, base));
    } else await this.removeFromKit('mods', base);
  }
  async findDepProject(dep) {
    const norm = s => String(s).toLowerCase().replace(/[^a-z0-9]/g, '');
    let proj = null;
    try { proj = await fetchJSON(`${API}/project/${encodeURIComponent(dep)}`); } catch { /* try search */ }
    if (!proj) {
      const facets = encodeURIComponent(JSON.stringify([['project_type:mod'], ['categories:fabric']]));
      const r = await fetchJSON(`${API}/search?limit=5&query=${encodeURIComponent(dep)}&facets=${facets}`);
      const hit = (r.hits || []).find(h => norm(h.slug) === norm(dep) || norm(h.slug).startsWith(norm(dep)) || norm(h.title) === norm(dep));
      if (hit) proj = { id: hit.project_id, title: hit.title };
    }
    if (!proj) throw new Error(`couldn't find “${dep}” automatically - search it by hand: https://modrinth.com/mods?q=${encodeURIComponent(dep)}&g=categories:fabric`);
    return proj;
  }
  async guardAddDep(dep, progress) {
    const proj = await this.findDepProject(dep);
    await this.installModWithDeps(proj.id, false, progress, false, { asDep: true });
    return proj.title || dep;
  }
  /** Apply fixes. opts.all = everything fixable (repeats until clean); opts.fixes = the exact fixes the user clicked. */
  async guardFix(opts, progress = () => {}) {
    const log = [];
    for (let pass = 0; pass < 4; pass++) {
      let todo = this.guardScan().issues.filter(i => i.level === 'error' && i.fix);
      if (!opts.all) {
        const want = Array.isArray(opts.fixes) ? opts.fixes : [];
        todo = todo.filter(i => want.some(w => w && w.action === i.fix.action && w.file === i.fix.file && w.dep === i.fix.dep && w.where === i.fix.where));
      }
      if (!todo.length) break;
      let acted = false;
      const doneRm = new Set();
      for (const i of todo.filter(x => x.fix.action === 'remove')) {
        const k = i.fix.where + '/' + i.fix.file; if (doneRm.has(k)) continue; doneRm.add(k);
        try { await this.guardRemove(i.fix.file, i.fix.where); log.push(`Removed ${i.fix.file} (${i.title})`); progress(`Removed ${i.fix.file}`); acted = true; }
        catch (e) { log.push(`Couldn't remove ${i.fix.file}: ${e.message}`); }
      }
      if (!acted || !opts.all) {
        const deps = [...new Set(todo.filter(x => x.fix.action === 'addDep').map(x => x.fix.dep))];
        for (const dep of deps) {
          progress(`Adding required library ${dep}...`);
          try { const t = await this.guardAddDep(dep, progress); log.push(`Added ${t}`); acted = true; }
          catch (e) { log.push(`${dep}: ${e.message}`); }
        }
      }
      if (!acted || !opts.all) break;
    }
    const left = this.guardScan().issues.filter(i => i.level === 'error').length;
    progress(left ? `Done - ${left} problem${left > 1 ? 's' : ''} still need you (see Mod Guard).` : 'All mods are compatible.', 100);
    return { ok: true, log, remaining: left };
  }

  /** Host uploads a file they downloaded themselves (PlanetMinecraft, CurseForge...). It ships inside the installer zip. */
  async addUploadToKit(folder, name, tmpFile) {
    if (!['shaderpacks', 'resourcepacks', 'mods'].includes(folder)) throw new Error('Bad folder');
    const safe = path.basename(String(name)).replace(/[^\w.\-+ ()]/g, '_');
    const head = Buffer.alloc(4); const fd = await fsp.open(tmpFile, 'r'); await fd.read(head, 0, 4, 0); await fd.close();
    if (head.readUInt32LE(0) !== 0x04034b50) throw new Error('That is not a .zip/.jar file. If you downloaded a .rar, extract it first.');
    const has = n => { try { return !!readZipEntry(tmpFile, n); } catch { return false; } };
    if (folder === 'resourcepacks' && !has('pack.mcmeta')) throw new Error('No pack.mcmeta at the top of this zip - it may be a folder-in-a-zip. Open it and re-zip the inner folder contents, or it is not a resource pack.');
    if (folder === 'mods') {
      if (!/\.jar$/i.test(safe)) throw new Error('Mods must be .jar files.');
      if (!has('fabric.mod.json')) throw new Error(has('META-INF/mods.toml') || has('META-INF/neoforge.mods.toml') ? 'This is a Forge/NeoForge mod - it needs the Fabric version of the mod.' : 'This jar is not a Fabric mod.');
    }
    if (folder !== 'mods' && !/\.zip$/i.test(safe)) throw new Error('Packs must be .zip files.');
    const sha1 = crypto.createHash('sha1').update(await fsp.readFile(tmpFile)).digest('hex');
    const dir = path.join(this.kitDir, folder);
    await fsp.mkdir(dir, { recursive: true });
    await fsp.rename(tmpFile, path.join(dir, safe)).catch(async () => { await fsp.copyFile(tmpFile, path.join(dir, safe)); await fsp.rm(tmpFile, { force: true }); });
    if (folder === 'mods') {
      const bad = this.guardCandidate(safe);
      if (bad) { await fsp.rm(path.join(dir, safe), { force: true }); throw new Error(`Mod Guard blocked ${safe}: ${bad}`); }
    }
    const man = this.kitManifest().filter(e => !(e.folder === folder && e.name === safe));
    man.push({ folder, name: safe, sha1, size: (await fsp.stat(path.join(dir, safe))).size, local: true });
    this.saveKitManifest(man);
    if (folder === 'mods') await this.guardDropOlderCopies(safe, () => {});
    return { name: safe };
  }

  async removeFromKit(folder, name) {
    if (!['shaderpacks', 'resourcepacks', 'mods'].includes(folder)) throw new Error('Bad folder');
    const base = path.basename(String(name));
    await fsp.rm(path.join(this.kitDir, folder, base), { force: true });
    this.saveKitManifest(this.kitManifest().filter(e => !(e.folder === folder && e.name === base)));
    if (folder === 'mods') await this.pruneOrphanDeps().catch(() => {});
  }

  /** Builds player-kit zip with an install guide. Returns temp zip path. */
  async buildKit(address) {
    await fsp.mkdir(this.kitDir, { recursive: true });
    const ver = this.gameVersion() || 'the server version';
    const kit = this.listKit();
    const guide = [
      'PLAYER KIT - how to join and use these extras',
      '==============================================', '',
      `Server address: ${address || '(ask the host)'}`,
      `Minecraft version: ${ver}   (pick exactly this version in your launcher)`, '',
      'SHADERS (folder: shaderpacks)',
      ' 1. In TLauncher, choose the "OptiFine" build for ' + ver + ' (or install Fabric + Iris).',
      '    If there is no OptiFine/Iris for this version yet, shaders cannot run on it yet.',
      ' 2. Launch the game once, then open Options > Video Settings > Shaders > "Shaders Folder".',
      ' 3. Copy the .zip files from this kit\'s shaderpacks folder into it (do not unzip them).',
      ' 4. Select a shader in the list. Shaders need a decent graphics card.', '',
      'RESOURCE PACKS (folder: resourcepacks)',
      ' Options > Resource Packs > Open Pack Folder, copy the zips in, then enable them.',
      ' (The server texture pack, if set, downloads automatically when you join.)', '',
      'Files in this kit:', ...kit.map(k => `  ${k.folder}/${k.name}`), '',
    ].join('\r\n');
    await fsp.writeFile(path.join(this.kitDir, 'HOW-TO-INSTALL.txt'), guide);
    const items = ['HOW-TO-INSTALL.txt', ...['shaderpacks', 'resourcepacks'].filter(s => fs.existsSync(path.join(this.kitDir, s)))];
    const out = path.join(this.dir, 'backups', `.player-kit-${Date.now()}.zip`);
    await fsp.mkdir(path.dirname(out), { recursive: true });
    await createZip(this.kitDir, items, out);
    return out;
  }
}

module.exports = { Packs, extractZip };
