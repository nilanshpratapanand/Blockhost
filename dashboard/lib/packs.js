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

const API = process.env.BLOCKHOST_MODRINTH || 'https://api.modrinth.com/v2';
const TYPES = {
  resourcepack: { facet: 'project_type:resourcepack', loaders: ['minecraft'] },
  datapack: { facet: 'categories:datapack', loaders: ['datapack'] },
  shader: { facet: 'project_type:shader', loaders: ['iris', 'optifine'] },
  mod: { facet: 'project_type:mod', extra: ['categories:fabric'], loaders: ['fabric'] },
};
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

  async search(type, q, version, offset = 0, source = 'modrinth') {
    if (source === 'curseforge') return cf.search(this.cfKey(), type, q, version, offset);
    if (source === 'all') {
      const [a, b] = await Promise.all([
        this.search(type, q, version, offset, 'modrinth').catch(() => ({ total: 0, hits: [] })),
        (this.getConfig().curseforgeKey ? cf.search(this.cfKey(), type, q, version, offset) : Promise.resolve({ total: 0, hits: [] })).catch(() => ({ total: 0, hits: [] })),
      ]);
      const seen = new Set(), hits = [];
      const norm = t => String(t).toLowerCase().replace(/[^a-z0-9]/g, '');
      for (let i = 0; i < Math.max(a.hits.length, b.hits.length); i++) for (const h of [a.hits[i], b.hits[i]]) {
        if (h && !seen.has(norm(h.title))) { seen.add(norm(h.title)); hits.push(h); }
      }
      return { total: a.total + b.total, hits };
    }
    const t = TYPES[type]; if (!t) throw new Error('Unknown pack type');
    const facets = [[t.facet]];
    if (t.extra) for (const e of t.extra) facets.push([e]);
    if (type === 'mod') facets.push(['client_side:required', 'client_side:optional']);
    if (version) facets.push([`versions:${version}`]);
    const url = `${API}/search?limit=24&offset=${Number(offset) || 0}&index=${q ? 'relevance' : 'downloads'}`
      + `&query=${encodeURIComponent(q || '')}&facets=${encodeURIComponent(JSON.stringify(facets))}`;
    const r = await fetchJSON(url);
    return {
      total: r.total_hits,
      hits: (r.hits || []).map(h => ({
        id: h.project_id, slug: h.slug, title: h.title, description: h.description, author: h.author,
        icon: h.icon_url, downloads: h.downloads, versions: h.versions || [], categories: h.categories || [],
        clientSide: h.client_side || null, serverSide: h.server_side || null, source: 'modrinth',
        page: `https://modrinth.com/${h.project_type || type}/${h.slug}`, canDownload: true,
      })),
    };
  }

  /** Newest version file of a project for our game version (or any version if allowAny). */
  async bestFile(type, id, version, allowAny) {
    if (String(id).startsWith('cf:')) return cf.bestFile(this.cfKey(), type, id, version, allowAny);
    const t = TYPES[type];
    const base = `${API}/project/${encodeURIComponent(id)}/version?include_changelog=false&loaders=${encodeURIComponent(JSON.stringify(t.loaders))}`;
    let list = version ? await fetchJSON(`${base}&game_versions=${encodeURIComponent(JSON.stringify([version]))}`) : [];
    let exact = true;
    if (!list.length && allowAny && type !== 'mod') { list = await fetchJSON(base); exact = false; }  // mods must match exactly or the game crashes
    if (!list.length) throw new Error(version ? (type === 'mod' ? `This mod isn't released for Minecraft ${version} yet (mods must match the exact version).` : `No ${type} build for Minecraft ${version}. Tick "any version" to try an older one.`) : 'No downloadable files.');
    const v = list[0];
    const f = v.files.find(x => x.primary) || v.files[0];
    if (!f) throw new Error('This version has no files.');
    return { url: f.url, filename: f.filename, sha1: f.hashes && f.hashes.sha1, size: f.size, versionNumber: v.version_number, gameVersions: v.game_versions, exact,
      deps: (v.dependencies || []).filter(d => d.dependency_type === 'required' && d.project_id).map(d => d.project_id) };
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
          return { ...x, warn };
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
    const out = [];
    for (const sub of ['shaderpacks', 'resourcepacks', 'mods']) {
      const d = path.join(this.kitDir, sub);
      try { for (const f of fs.readdirSync(d)) out.push({ folder: sub, name: f, size: fs.statSync(path.join(d, f)).size }); } catch { /* none */ }
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

  async addToKit(type, id, allowAny, progress, _seen, force) {
    const folder = KIT_FOLDER[type]; if (!folder) throw new Error('Unknown kit type');
    const seen = _seen || new Set();
    if (seen.has(id)) return { file: null }; seen.add(id);
    const f = await this.bestFile(type, id, this.gameVersion(), allowAny);
    let info = {};
    if (String(id).startsWith('cf:')) info = { slug: f.slug, title: f.title };
    else { try { info = await fetchJSON(`${API}/project/${encodeURIComponent(id)}`); } catch { /* optional */ } }
    if (type === 'mod' && info.server_side === 'required' && !force) {
      const e = new Error(`"${info.title || id}" adds new content (blocks/mobs/items) and must also run on the server. On your vanilla server it makes friends get "Network Protocol Error" when joining - so it was NOT added.`);
      e.code = 'SERVER_MOD'; throw e;
    }
    const d = path.join(this.kitDir, folder);
    await fsp.mkdir(d, { recursive: true });
    const safe = path.basename(f.filename).replace(/[^\w.\-+ ]/g, '_');
    // replace an older file of the same project
    for (const old of this.kitManifest().filter(e => e.projectId === id && e.folder === folder && e.name !== safe)) await fsp.rm(path.join(d, old.name), { force: true });
    progress(`Downloading ${safe}...`, 10);
    const got = await download(f.url, path.join(d, safe), pct => progress(null, 10 + Math.round(pct * 0.85)), cf.isCfUrl(f.url) ? { 'x-api-key': this.cfKey() } : null);
    if (f.sha1 && got !== f.sha1) { await fsp.rm(path.join(d, safe), { force: true }); throw new Error('Checksum mismatch - download corrupted.'); }
    const man = this.kitManifest().filter(e => !(e.folder === folder && (e.name === safe || e.projectId === id)));
    man.push({ folder, name: safe, url: f.url, sha1: got, size: f.size, projectId: id, slug: info.slug || null, title: info.title || null,
      serverSide: info.server_side || null });
    this.saveKitManifest(man);
    const added = [safe];
    if (type === 'mod') {
      for (const dep of f.deps) {
        if (this.kitManifest().some(e => e.projectId === dep)) continue;
        progress(`Adding required dependency...`);
        try { const r = await this.addToKit('mod', dep, false, progress, seen); if (r.added) added.push(...r.added); }
        catch (e) { progress(`Dependency ${dep} not available for ${this.gameVersion()}: ${e.message}`); }
      }
    }
    progress(`Added ${added.join(', ')} to the player kit.`, 100);
    return { file: safe, added, serverSide: info.server_side || null };
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
      else if (env === '*' || env === null) { risk = 'maybe'; why = 'Not marked as client-only. If friends get "Network Protocol Error", remove this one first.'; }
      out.push({ name: e.name, title: e.title || modId || e.name, risk, why, serverSide: ss, environment: env });
    }
    if (changed) this.saveKitManifest(man);
    const order = { breaks: 0, maybe: 1, ok: 2 };
    return out.sort((a, b) => order[a.risk] - order[b.risk]);
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
    const man = this.kitManifest().filter(e => !(e.folder === folder && e.name === safe));
    man.push({ folder, name: safe, sha1, size: (await fsp.stat(path.join(dir, safe))).size, local: true });
    this.saveKitManifest(man);
    return { name: safe };
  }

  async removeFromKit(folder, name) {
    if (!['shaderpacks', 'resourcepacks', 'mods'].includes(folder)) throw new Error('Bad folder');
    const base = path.basename(String(name));
    await fsp.rm(path.join(this.kitDir, folder, base), { force: true });
    this.saveKitManifest(this.kitManifest().filter(e => !(e.folder === folder && e.name === base)));
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
