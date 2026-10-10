/* Blockhost dashboard — Packs (texture/data/shaders) and the one-click Setup wizard */
(() => {
  'use strict';
  const { $, $$, esc, ic, api, post, toast, modal, confirmBox, fmtBytes, titleCase, mcFormat, copyText, store, S, pages } = window.BH;
  const online = () => S.snap && S.snap.state === 'online';
  const running = () => S.snap && ['online', 'starting', 'stopping'].includes(S.snap.state);
  const fmtNum = n => n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(1) + 'k' : String(n || 0);

  // ============================================================== PACKS
  const TAB_INFO = {
    resourcepack: { label: 'Texture packs', icon: 'image', blurb: 'Pick a pack and click “Use on server”. Everyone gets it automatically when they join.' },
    datapack: { label: 'Data packs', icon: 'box', blurb: 'Vanilla add-ons that run on the server: new structures, mobs, recipes, quality-of-life. No mods needed.' },
    mod: { label: 'Client mods', icon: 'box', blurb: 'Fabric mods that run on each player’s PC (connected textures, CIT, falling leaves, footsteps…). Required libraries are added automatically. Friends get them through the installer.' },
    shader: { label: 'Shaders', icon: 'sun', blurb: 'Shaders run on each player’s own PC. Add them to the kit, then send friends the one-click installer — it downloads and switches them on for them.' },
  };

  const PRESETS = [
    { id: 'complementary', name: 'Complementary Reimagined', text: 'Beautiful, close to vanilla. Runs on most PCs.', rec: true },
    { id: 'unbound', name: 'Complementary Unbound', text: 'More dramatic lighting & sky. Mid-range PCs.' },
    { id: 'bsl', name: 'BSL Shaders', text: 'Classic warm look, lots of settings.' },
    { id: 'makeup', name: 'MakeUp Ultra Fast', text: 'For low-end PCs and laptops.' },
  ];
  pages.packs = {
    title: 'Packs', sub: 'Texture packs, data packs and shaders from Modrinth',
    render(view, on) {
      let source = store.get('packSource', 'modrinth'), searchErr = null;
      let tab = store.get('packTab', 'resourcepack'), q = '', any = store.get('packAny', true), anyLoader = store.get('packAnyLoader', true), results = null, offset = 0, total = 0, state = null, loading = false;

      const stateCard = () => {
        if (!state) return `<div class="card"><div class="skeleton" style="width:40%"></div></div>`;
        if (tab === 'resourcepack') {
          const sp = state.serverPack;
          return `<div class="card"><div class="card-h"><h2>Server texture pack</h2>${sp ? `<span class="tag green">${ic('check')}active</span>` : '<span class="tag">none</span>'}<span class="spacer"></span>
            <button class="btn btn-ghost btn-sm" id="customPack">${ic('link')}Use my own link</button></div>
            ${sp ? `<div class="list-row" style="border:0;padding:0"><div class="avatar sm" style="color:var(--amethyst-2)">${ic('image')}</div><div class="grow"><b>${esc(sp.name)}</b> <span class="sub">${sp.require ? 'required' : 'optional'} · sha1 ${esc(sp.sha1.slice(0, 10))}…</span></div>
              <button class="btn btn-ghost btn-sm" id="editPack">${ic('edit')}Options</button><button class="icon-btn danger" id="rmPack" title="Remove">${ic('x')}</button></div>
              <div class="dim small" style="margin-top:8px">${running() ? 'Restart the server so joining players get the new pack.' : 'Downloads automatically for every player when they join — nothing to install.'} Want more than one pack? Add extras to the Player Kit (“+ Kit”) and share the friend installer.</div>`
            : `<div class="muted small">No pack yet. Choose one below — or use your own zip hosted somewhere with a direct download link (e.g. <a href="https://mc-packs.net" target="_blank" rel="noopener">mc-packs.net</a>, GitHub release, Dropbox).</div>`}</div>`;
        }
        if (tab === 'datapack') {
          return `<div class="card"><div class="card-h"><h2>Installed data packs</h2><span class="tag">${state.datapacks.length}</span></div>
            <div class="list">${state.datapacks.length ? state.datapacks.map(d => `<div class="list-row"><div class="avatar sm" style="color:var(--emerald)">${ic('box')}</div><div class="grow"><b>${esc(d.name)}</b> <span class="sub">${d.size ? fmtBytes(d.size) : 'folder'}${d.pending ? ' · switched off, deleted when the server stops' : ''}</span>${(d.warn || []).map(w => `<div class="small" style="color:var(--gold);margin-top:3px">${ic('alert').replace('<svg ', '<svg width="12" height="12" style="vertical-align:-2px" ')} ${esc(w)}</div>`).join('')}</div><button class="icon-btn danger" data-rmdp="${esc(d.name)}" title="Remove">${ic('trash')}</button></div>`).join('')
              : `<div class="muted small">None yet. ${S.snap.hasJar ? '' : 'Create the server first.'} Data packs are added to the world and switched on with /reload.</div>`}</div></div>`;
        }
        const ck = state.installer;
        const installerCard = `<div class="card installer"><div class="row" style="flex-wrap:nowrap;align-items:flex-start;gap:16px">
            <div class="inst-ico">${ic('download')}</div>
            <div style="flex:1;min-width:0"><h2 style="margin:0 0 4px;font-size:17px">Friend installer — one double-click for everyone</h2>
              <div class="muted small">Send the installer to your friends (WhatsApp / Discord). One double-click puts every shader, texture pack and mod from the kit into their Minecraft, selects the right version in TLauncher and adds your server${ck && ck.iris && ck.sodium ? ', installs <b>Fabric + Iris + Sodium</b> so shaders actually run, and switches the first shader on' : ''}. Every file is checked (SHA-1) and comes straight from Modrinth / Fabric.</div>
              <div class="row" style="margin-top:12px">
                <a class="btn btn-primary ${state.kit.length ? '' : 'disabled-link'}" id="instDl" href="/api/packs/installer?iris=${store.get('instIris', true) ? 1 : 0}&bundle=${store.get('instBundle', true) ? 1 : 0}">${ic('download')}Download installer (${state.kit.some(k => k.local) || store.get('instBundle', true) ? '.zip' : '.bat'})</a>
                <label class="row small muted" style="gap:6px"><span class="switch"><input type="checkbox" id="instIris" ${store.get('instIris', true) ? 'checked' : ''} ${ck && ck.iris && ck.sodium ? '' : 'disabled'}><span></span></span>Include Fabric + Iris (shader mod)</label>
                <label class="row small muted" style="gap:6px" title="Every file is also packed inside the installer, so it still works if Modrinth/CurseForge is down or blocked for a friend"><span class="switch"><input type="checkbox" id="instBundle" ${store.get('instBundle', true) ? 'checked' : ''}><span></span></span>Backup copies inside (always works)</label>
              </div>
              <div class="dim small" style="margin-top:8px">${!ck ? 'Checking Iris availability…' : ck.iris && ck.sodium ? `Iris & Sodium available for ${esc(ck.version)} (Fabric ${esc(ck.fabric || '')}). Friends then pick “fabric-loader-…-${esc(ck.version)}” in TLauncher.` : `Iris/Sodium aren't released for ${esc(ck.version || 'this version')} yet — the installer still copies the shaders; friends can use an OptiFine build in TLauncher.`}
                ${ck && ck.legacy ? ` · ${ck.legacy} older kit file(s) were added before v1.3 — remove and add them again to include them.` : ''}
                ${state.kit.length ? '' : ' · Add some shaders or texture packs below first.'} Windows may say “unknown publisher” — click <b>More info → Run anyway</b>.</div>
              <div class="banner" style="margin-top:12px;padding:10px 14px"><div class="b-ico">${ic('sync')}</div><div class="b-text"><b>Want it fully automatic?</b><span>With <a href="#/sync">Live Sync</a> friends run one file once and every later change installs itself — no new installer each time.</span></div><a class="btn btn-ghost btn-sm" href="#/sync">Set up</a></div>
              <div class="row" style="margin-top:12px"><button class="btn btn-ghost btn-sm" id="docBtn">${ic('search')}Shaders not showing? Check this PC</button><span class="dim small">Reads the Minecraft folder and last game log on this computer and tells you exactly what's wrong.</span></div>
            </div></div></div>`;
        const hasShader = state.kit.some(k => k.folder === 'shaderpacks');
        const presetCard = tab !== 'shader' ? '' : `<div class="card"><div class="card-h"><h2>${ic('sparkle').replace('<svg ', '<svg width="16" height="16" style="vertical-align:-2px;color:var(--amethyst-2);margin-right:6px" ')}Shaders in one click</h2>${hasShader ? '<span class="tag green">kit has a shader</span>' : ''}</div>
          <div class="muted small">Does every step of a “how to install shaders” video for your friends: Fabric + Iris + Sodium, the shader pack, shaders switched ON with the pack selected, and the right version picked in TLauncher. TLauncher brings its own Java, so nothing else to install. Pick one:</div>
          <div class="preset-grid">${PRESETS.map(pr => `<button class="preset ${pr.rec ? 'rec' : ''}" data-preset="${pr.id}"><b>${pr.name}</b><span>${pr.text}</span>${pr.rec ? '<span class="tag purple" style="align-self:flex-start;margin-top:4px">recommended</span>' : ''}</button>`).join('')}</div>
          <div class="dim small" style="margin-top:10px">The one you pick becomes the active shader. Friends with <a href="#/sync">Live Sync</a> get it automatically; others use the installer below.</div></div>`;
        const chk = state.check;
        const checkCard = tab !== 'mod' || !state.kit.some(k => k.folder === 'mods') ? '' : `<div class="card"><div class="card-h"><h2>Mod check — will friends be able to join?</h2>${!chk ? '<span class="spinner"></span>' : chk.some(c => c.risk === 'breaks') ? '<span class="tag red">problem found</span>' : chk.some(c => c.risk === 'maybe') ? '<span class="tag gold">check these</span>' : '<span class="tag green">all client-only</span>'}</div>
          <div class="muted small">Your server is vanilla. Mods that add new blocks, mobs or items must also run on the server - on a vanilla server they cause <b>“Connection lost: Network Protocol Error”</b> when joining. Client-only mods (shaders, connected textures, CIT, particles, sounds) are fine.</div>
          ${chk ? `<div class="list" style="margin-top:10px">${chk.filter(c => c.risk !== 'ok').map(c => `<div class="list-row"><span class="tag ${c.risk === 'breaks' ? 'red' : 'gold'}">${ic('alert')}${c.risk === 'breaks' ? 'breaks joining' : 'maybe'}</span><div class="grow"><b>${esc(c.title)}</b> <span class="sub">${esc(c.why)}</span></div><button class="btn btn-ghost btn-sm" data-rmkit="${esc(c.name)}" data-folder="mods">${ic('trash')}Remove</button></div>`).join('') || `<div class="muted small">${ic('check').replace('<svg ', '<svg width="14" height="14" style="vertical-align:-2px" ')} All ${chk.length} mods are client-only — they can't cause a protocol error.</div>`}</div>` : ''}</div>`;
        const gd = state.guard, gErr = gd ? gd.issues.filter(i => i.level === 'error') : [];
        const guardCard = tab !== 'mod' || (gd && !gd.total) ? '' : `<div class="card"><div class="card-h"><h2>${ic('shield').replace('<svg ', '<svg width="16" height="16" style="vertical-align:-2px;color:var(--emerald);margin-right:6px" ')}Mod Guard</h2>${!gd ? '<span class="spinner"></span>' : gErr.length ? `<span class="tag red">${gErr.length} problem${gErr.length > 1 ? 's' : ''}</span>` : gd.issues.length ? `<span class="tag gold">${gd.issues.length} warning${gd.issues.length > 1 ? 's' : ''}</span>` : `<span class="tag green">all ${gd.total} mods compatible</span>`}<span class="spacer"></span>${gErr.some(i => i.fix) ? `<button class="btn btn-primary btn-sm" id="guardFixAll">${ic('check')}Fix all problems</button>` : ''}</div>
          <div class="muted small">Looks inside every mod for what would crash the game: wrong loader (Forge/NeoForge instead of Fabric), wrong Minecraft version${gd && gd.gameVersion ? ' (yours is ' + esc(gd.gameVersion) + ')' : ''}, missing required libraries, mods that break each other, and duplicate copies. Bad mods are also <b>blocked automatically</b> when you try to add them.</div>
          ${gd && gd.issues.length ? `<div class="list" style="margin-top:10px">${gd.issues.map((i, n) => `<div class="list-row"><span class="tag ${i.level === 'error' ? 'red' : 'gold'}">${ic('alert')}${i.level === 'error' ? 'problem' : 'warning'}</span><div class="grow"><b>${esc(i.title)}</b> <span class="sub">${esc(i.why)}</span></div>${i.fix ? `<button class="btn btn-ghost btn-sm" data-gfix="${n}">${i.fix.action === 'addDep' ? ic('plus') + 'Add ' + esc(i.fix.dep) : ic('trash') + 'Remove'}</button>` : ''}<button class="btn btn-ghost btn-sm" data-gign="${n}" title="I tested it and it works - never warn or block this mod again">Ignore</button></div>`).join('')}</div>` : ''}
          ${gd ? `<details style="margin-top:12px"${state.guardOpen ? ' open' : ''} id="guardMore"><summary class="small muted" style="cursor:pointer">More tools: ignored mods, mark mods as incompatible, crash-log analyzer${gd.disabled && gd.disabled.length ? ', disabled server mods' : ''}</summary>
            <div class="stack" style="margin-top:10px;gap:14px">
              <div><div class="small"><b>Always allowed</b> <span class="dim">— mods you tested that work (never warned or blocked)</span></div>
                <div class="row" style="gap:6px;flex-wrap:wrap;margin-top:6px">${gd.rules.allow.map(a => `<span class="tag green">${esc(a)} <a href="#" data-gunallow="${esc(a)}" title="Stop ignoring">×</a></span>`).join('') || '<span class="dim small">none yet</span>'}</div>
                <form class="input-group" id="gAllowForm" style="margin-top:8px"><input class="input" id="gAllowIn" placeholder="mod id or Modrinth slug, e.g. chunky"><button class="btn btn-ghost">Allow</button></form></div>
              <div><div class="small"><b>Known bad pairs</b> <span class="dim">— found two mods that crash together? Teach the guard once.</span></div>
                ${gd.rules.pairs.map(p => `<div class="row small" style="gap:6px;margin-top:4px"><span class="tag red">${esc(p.bad)} + ${esc(p.other)}</span><a href="#" data-gunpair="${esc(p.bad)}|${esc(p.other)}">remove rule</a></div>`).join('')}
                <form class="input-group" id="gPairForm" style="margin-top:8px"><select class="input" id="gPairA">${gd.mods.filter(m => m.id).map(m => `<option value="${esc(m.id)}">${esc(m.title || m.id)}</option>`).join('')}</select><select class="input" id="gPairB">${gd.mods.filter(m => m.id).map((m, n) => `<option value="${esc(m.id)}" ${n === 1 ? 'selected' : ''}>${esc(m.title || m.id)}</option>`).join('')}</select><button class="btn btn-ghost">Mark incompatible</button></form>
                <div class="dim small">The first one is the one that gets removed by “Fix all”.</div></div>
              <div><div class="small"><b>Crash-log analyzer</b> <span class="dim">— paste a crash report or latest.log (yours or a friend's)</span></div>
                <textarea class="input mono" id="gCrash" rows="4" placeholder="Paste the crash report here…" style="margin-top:6px">${esc(state.guardText || '')}</textarea>
                <div class="row" style="margin-top:6px"><button class="btn btn-ghost btn-sm" id="gAnalyze">${ic('search')}Find the culprit</button></div>
                ${state.guardCrash ? (state.guardCrash.nothing ? '<div class="muted small" style="margin-top:8px">No mod names found in that text. Paste the full crash report (the part starting with “---- Minecraft Crash Report ----”).</div>' : `<div class="list" style="margin-top:8px">${state.guardCrash.suspects.map(s => `<div class="list-row"><span class="tag red">suspect</span><div class="grow"><b>${esc(s.title)}</b> <span class="sub">${esc(s.reasons.join('; '))}</span></div><button class="btn btn-ghost btn-sm" data-gcrm="${esc(s.name)}" data-gwhere="${esc(s.where)}">${ic('trash')}Remove</button></div>`).join('')}${state.guardCrash.unmatched.map(s => `<div class="list-row"><span class="tag gold">not installed</span><div class="grow"><b>${esc(s.id)}</b> <span class="sub">${esc(s.reasons.join('; '))}</span></div></div>`).join('')}${state.guardCrash.pairs.map(p => `<div class="list-row"><span class="tag purple">pair</span><div class="grow"><b>${esc(p[0])} + ${esc(p[1])}</b> <span class="sub">reported incompatible</span></div><button class="btn btn-ghost btn-sm" data-gpairadd="${esc(p[0])}|${esc(p[1])}">Remember</button></div>`).join('')}</div>`) : ''}</div>
              ${gd.disabled && gd.disabled.length ? `<div><div class="small"><b>Disabled server mods</b> <span class="dim">— moved to <code>mods-disabled</code>, never deleted</span></div>${gd.disabled.map(f => `<div class="row small" style="gap:6px;margin-top:4px"><span class="mono">${esc(f)}</span><a href="#" data-grestore="${esc(f)}">Restore</a></div>`).join('')}</div>` : ''}
            </div></details>` : ''}</div>`;
        const mm = state.mods;
        const modsCard = tab !== 'mod' || !mm || !mm.length ? '' : `<div class="card"><div class="card-h"><h2>Installed mods</h2><span class="tag purple">${mm.filter(m => m.enabled).length} on</span>${mm.some(m => !m.enabled) ? `<span class="tag">${mm.filter(m => !m.enabled).length} off</span>` : ''}</div>
          <div class="muted small">Switch a single mod off to keep it without sending it to friends, or remove it. Libraries that were added automatically for a mod are removed when nothing needs them any more.</div>
          <div class="list" style="margin-top:10px">${mm.map((m, n) => `<div class="list-row" style="${m.enabled ? '' : 'opacity:.55'}"><span class="switch" title="${m.enabled ? 'On - friends get this mod' : 'Off - kept here, not sent to friends'}"><input type="checkbox" data-mtoggle="${n}" ${m.enabled ? 'checked' : ''}><span></span></span>
            <div class="grow"><b>${esc(m.title)}</b> ${m.version ? `<span class="sub">${esc(m.version)}</span>` : ''} ${m.auto ? '<span class="tag blue" title="Added automatically because another mod needs it">library</span>' : ''} ${m.requiredBy.length ? `<span class="tag" title="${esc(m.requiredBy.join(', '))}">needed by ${m.requiredBy.length}</span>` : ''}</div>
            <button class="icon-btn danger" title="Remove" data-mrm="${n}">${ic('trash')}</button></div>`).join('')}</div></div>`;
        return presetCard + modsCard + guardCard + checkCard + installerCard + `<div class="card"><div class="card-h"><h2>Player kit</h2><span class="tag purple">${state.kit.length} file${state.kit.length === 1 ? '' : 's'}</span><span class="spacer"></span>
            <a class="btn btn-primary btn-sm ${state.kit.length ? '' : 'hidden'}" href="/api/packs/kit/download">${ic('download')}Download kit (.zip)</a></div>
          <label class="dropzone" id="kitDrop" style="margin-bottom:12px;padding:16px">${ic('upload')}<div><b>Upload a file you downloaded yourself</b> (PlanetMinecraft, CurseForge, a creator's website…)</div><div class="dim small">Drop .zip texture packs / shaders or Fabric .jar mods here. They travel inside the installer zip. Share only with friends - many packs are personal-use only.</div><input type="file" id="kitFile" multiple accept=".zip,.jar" hidden></label>
          <form class="input-group" id="linkForm" style="margin-bottom:12px"><input class="input" id="linkIn" placeholder="Paste a Modrinth / CurseForge / PlanetMinecraft link, or just a name (e.g. Fresh Leaves)"><button class="btn btn-primary">${ic('search')}Find & add</button></form>
          <div class="list">${state.kit.length ? state.kit.map(k => `<div class="list-row"><div class="avatar sm" style="color:var(--gold)">${ic(k.folder === 'shaderpacks' ? 'sun' : k.folder === 'mods' ? 'box' : 'image')}</div><div class="grow"><b>${esc(k.name)}</b> ${k.auto ? '<span class="tag blue" title="Added automatically because another mod needs it. It is removed automatically once nothing needs it.">required by another mod</span>' : ''} <span class="sub">${k.folder} · ${fmtBytes(k.size)}${k.local ? ' · uploaded' : ''}</span></div><button class="icon-btn danger" data-rmkit="${esc(k.name)}" data-folder="${k.folder}">${ic('trash')}</button></div>`).join('') : '<div class="muted small">Add shaders (or texture packs) below — they go into one zip you can send to friends.</div>'}</div></div>`;
      };

      const LOADER_LABEL = { fabric: 'Fabric', quilt: 'Quilt', forge: 'Forge', neoforge: 'NeoForge', liteloader: 'LiteLoader', rift: 'Rift' };
      const compatInfo = h => {
        const c = h.compat || {}, gv = state && state.gameVersion;
        const ld = (c.loaders || []).map(l => LOADER_LABEL[l] || l).join(' · ');
        if (tab === 'mod') {
          if (c.loader === false || c.fits === false && c.loader === false) return { blocked: true, tag: `<span class="tag red" title="No Fabric build exists, so it can't run in your Fabric kit">${esc(ld || 'Other loader')} only</span>`, note: `Not a Fabric mod — can't run on your Fabric ${esc(gv || '')} setup. Open its page to see its own loader.`, ld, latest: c.latest };
          if (c.fits === false || c.version === false) return { blocked: true, tag: `<span class="tag gold" title="Fabric build exists, but not for ${esc(gv || 'your version')}">for MC ${esc(c.latest || 'older')}</span>`, note: `No Fabric build for Minecraft ${esc(gv || 'your version')} yet — newest is ${esc(c.latest || 'older')}.`, ld, latest: c.latest };
          return { blocked: false, tag: c.version === true || c.fits === true ? `<span class="tag green">fits your server</span>` : '', note: '', ld, latest: c.latest };
        }
        if (c.version === false) return { blocked: false, tag: `<span class="tag gold" title="Newest listed version is ${esc(c.latest || 'older')} — it may still work">for MC ${esc(c.latest || 'older')}</span>`, note: '', ld, latest: c.latest };
        return { blocked: false, tag: '', note: '', ld, latest: c.latest };
      };
      const resultCard = h => {
        const ci = compatInfo(h);
        const kitBtn = l => `<button class="btn ${l ? 'btn-primary' : 'btn-ghost'} btn-sm" data-kit="${esc(h.id)}">${ic('plus')}${l || 'Kit'}</button>`;
        const btns = h.canDownload === false || ci.blocked
          ? `<a class="btn btn-ghost btn-sm" href="${esc(h.page)}" target="_blank" rel="noopener">${ic('external')}Get it on the site</a>`
          : tab === 'resourcepack' ? `<button class="btn btn-primary btn-sm" data-use="${esc(h.id)}" data-name="${esc(h.title)}">${ic('check')}Use on server</button>${kitBtn()}`
            : tab === 'datapack' ? `<button class="btn btn-success btn-sm" data-dp="${esc(h.id)}">${ic('download')}Install</button>`
              : kitBtn('Add to kit');
        const warn = tab === 'mod' && h.serverSide === 'required' ? `<div class="tag red" title="This mod also has to be installed on the server - a vanilla server can't run it">${ic('alert')}needs a modded server</div>` : '';
        return `<div class="card pack">
          <div class="row" style="flex-wrap:nowrap;align-items:flex-start;gap:12px">
            <div class="pack-icon">${h.icon ? `<img src="${esc(h.icon)}" alt="" loading="lazy" onerror="this.remove()">` : ''}${ic(TAB_INFO[tab].icon)}</div>
            <div style="min-width:0;flex:1"><div class="pack-title">${esc(h.title)}</div><div class="dim small">by ${esc(h.author)} · ${ic('download').replace('<svg ', '<svg width="11" height="11" style="vertical-align:-1px" ')} ${fmtNum(h.downloads)}</div></div>
            <span class="tag ${h.source === 'curseforge' ? 'gold' : 'green'}">${h.source === 'curseforge' ? 'CurseForge' : 'Modrinth'}</span>
          </div>
          <p class="pack-desc">${esc(h.description)}</p>
          <div class="row" style="gap:6px;flex-wrap:wrap">${ci.tag}${ci.ld ? `<span class="tag">${esc(ci.ld)}</span>` : ''}${ci.latest && !ci.tag.includes('for MC') ? `<span class="tag">MC ${esc(ci.latest)}</span>` : ''}</div>${ci.note ? `<div class="dim small">${ci.note}</div>` : ''}${warn}
          ${h.canDownload === false ? '<div class="dim small">Author only allows downloads on their page - download it there, then upload it to the kit.</div>' : ''}
          <div class="row between"><a class="dim small" href="${esc(h.page || ('https://modrinth.com/' + tab + '/' + h.slug))}" target="_blank" rel="noopener">${ic('external').replace('<svg ', '<svg width="12" height="12" style="vertical-align:-2px" ')} Open page</a><div class="row" style="gap:6px">${btns}</div></div>
        </div>`;
      };

      const draw = () => {
        const info = TAB_INFO[tab];
        view.innerHTML = `<div class="stack">
          <div class="row between" style="border-bottom:1px solid var(--line)"><div class="tabs" style="margin-bottom:0;border-bottom:0">${Object.entries(TAB_INFO).map(([k, t]) => `<button class="${tab === k ? 'on' : ''}" data-t="${k}">${t.label}</button>`).join('')}</div>
            <button class="btn btn-primary btn-sm" id="pasteList">${ic('sparkle')}Paste a list</button></div>
          <div class="muted">${info.blurb}</div>
          ${stateCard()}
          <div class="row between">
            <form id="pkForm" style="position:relative;flex:1;min-width:220px;max-width:460px"><input class="input" id="pkQ" placeholder="Search ${info.label.toLowerCase()}…" value="${esc(q)}" style="padding-left:34px"><span style="position:absolute;left:11px;top:11px;color:var(--dim)">${ic('search').replace('<svg ', '<svg width="16" height="16" ')}</span></form>
            <div class="row"><div class="seg" id="srcSeg">${[['modrinth', 'Modrinth'], ['curseforge', 'CurseForge'], ['all', 'Both']].map(([k, l]) => `<button data-src="${k}" class="${source === k ? 'on' : ''}">${l}</button>`).join('')}</div>
              <a class="dim small" href="https://www.planetminecraft.com/${tab === 'resourcepack' ? 'texture-packs' : tab === 'mod' ? 'mods' : tab === 'datapack' ? 'data-packs' : 'texture-packs'}/?keywords=${encodeURIComponent(q)}" target="_blank" rel="noopener" title="PlanetMinecraft has no download API - find it there, download, then upload to the kit">${ic('external').replace('<svg ', '<svg width="12" height="12" style="vertical-align:-2px" ')} PlanetMinecraft</a>
              <span class="tag blue">${ic('box')}for ${esc((state && state.gameVersion) || 'your version')}</span>
              <label class="row small muted" style="gap:6px"><span class="switch"><input type="checkbox" id="pkAny" ${any ? 'checked' : ''}><span></span></span>Any version</label>
              ${tab === 'mod' ? `<label class="row small muted" style="gap:6px" title="Show Forge / NeoForge / Quilt mods too, not just Fabric"><span class="switch"><input type="checkbox" id="pkLoader" ${anyLoader ? 'checked' : ''}><span></span></span>Any loader</label>` : ''}</div>
          </div>
          <div class="pack-grid" id="pkRes">${results === null ? Array(6).fill('<div class="card"><div class="skeleton" style="width:60%"></div><div class="skeleton" style="margin-top:12px"></div></div>').join('')
            : searchErr ? `<div class="card empty" style="grid-column:1/-1">${ic('key')}<div>${esc(searchErr)}</div><a class="btn btn-primary btn-sm" href="#/settings">Open Settings</a></div>`
            : results.length ? results.map(resultCard).join('') : `<div class="card empty" style="grid-column:1/-1">${ic('search')}<div>Nothing found${any ? '' : ` for ${esc(state && state.gameVersion)} yet — new versions take a while. Try “Any version”.`}${tab === 'mod' && !anyLoader ? ' Or switch on “Any loader” to also see Forge / NeoForge mods.' : ''}</div></div>`}</div>
          ${results && results.length < total ? `<div style="text-align:center"><button class="btn btn-ghost" id="pkMore">${loading ? '<span class="spinner"></span>' : ''}Load more</button></div>` : ''}
        </div>`;
        bind();
      };

      function bind() {
        $$('[data-t]', view).forEach(b => b.onclick = () => { tab = b.dataset.t; store.set('packTab', tab); results = null; offset = 0; draw(); search(); if (tab === 'shader' || tab === 'mod') loadState(); });
        $('#pkForm').onsubmit = e => { e.preventDefault(); q = $('#pkQ').value.trim(); results = null; offset = 0; draw(); search(); };
        $('#pkAny').onchange = e => { any = e.target.checked; store.set('packAny', any); results = null; offset = 0; draw(); search(); };
        const pl = $('#pkLoader'); if (pl) pl.onchange = e => { anyLoader = e.target.checked; store.set('packAnyLoader', anyLoader); results = null; offset = 0; draw(); search(); };
        const more = $('#pkMore'); if (more) more.onclick = () => { offset += 24; search(true); };
        const gfa = $('#guardFixAll'); if (gfa) gfa.onclick = () => post('/api/packs/guard/fix', { all: true }).catch(e => toast(e.message, 'err'));
        const gmore = $('#guardMore'); if (gmore) gmore.ontoggle = () => { state.guardOpen = gmore.open; };
        const reload = () => api('/api/packs/guard').then(g => { state.guard = g; draw(); }).catch(() => {});
        const act = (p, o) => api(p, o).then(reload).catch(e => toast(e.message, 'err'));
        $$('[data-gign]', view).forEach(b => b.onclick = () => { const i = state.guard.issues[Number(b.dataset.gign)]; state.guardOpen = true; act('/api/packs/guard/allow', { method: 'POST', body: { id: i.modId || i.mod } }); });
        $$('[data-gunallow]', view).forEach(a => a.onclick = e => { e.preventDefault(); act('/api/packs/guard/allow?id=' + encodeURIComponent(a.dataset.gunallow), { method: 'DELETE' }); });
        $$('[data-gunpair]', view).forEach(a => a.onclick = e => { e.preventDefault(); const [x, y] = a.dataset.gunpair.split('|'); act(`/api/packs/guard/pair?bad=${encodeURIComponent(x)}&other=${encodeURIComponent(y)}`, { method: 'DELETE' }); });
        $$('[data-grestore]', view).forEach(a => a.onclick = e => { e.preventDefault(); act('/api/packs/guard/restore', { method: 'POST', body: { file: a.dataset.grestore } }); });
        const af = $('#gAllowForm'); if (af) af.onsubmit = e => { e.preventDefault(); const v = $('#gAllowIn').value.trim(); if (v) { state.guardOpen = true; act('/api/packs/guard/allow', { method: 'POST', body: { id: v } }); } };
        const pf = $('#gPairForm'); if (pf) pf.onsubmit = e => { e.preventDefault(); state.guardOpen = true; act('/api/packs/guard/pair', { method: 'POST', body: { bad: $('#gPairA').value, other: $('#gPairB').value } }); };
        $$('[data-gpairadd]', view).forEach(b => b.onclick = () => { const [x, y] = b.dataset.gpairadd.split('|'); state.guardOpen = true; act('/api/packs/guard/pair', { method: 'POST', body: { bad: x, other: y, why: 'Reported incompatible in a crash log.' } }); });
        const an = $('#gAnalyze'); if (an) an.onclick = async () => { state.guardText = $('#gCrash').value; state.guardOpen = true; try { state.guardCrash = await post('/api/packs/guard/analyze', { text: state.guardText }); } catch (e) { toast(e.message, 'err'); } draw(); };
        $$('[data-gcrm]', view).forEach(b => b.onclick = () => { state.guardOpen = true; post('/api/packs/guard/fix', { fixes: [{ action: 'remove', file: b.dataset.gcrm, where: b.dataset.gwhere }] }).catch(e => toast(e.message, 'err')); });
        $$('[data-gfix]', view).forEach(b => b.onclick = () => { const i = state.guard.issues[Number(b.dataset.gfix)]; post('/api/packs/guard/fix', { fixes: [i.fix] }).catch(e => toast(e.message, 'err')); });
        $$('[data-use]', view).forEach(b => b.onclick = () => useOnServer({ id: b.dataset.use, name: b.dataset.name }));
        $$('[data-kit]', view).forEach(b => b.onclick = () => tab === 'mod' ? planAndAdd(b.dataset.kit) : post('/api/packs/kit', { type: tab, id: b.dataset.kit, any }).catch(e => toast(e.message, 'err')));
        $$('[data-mtoggle]', view).forEach(inp => inp.onchange = async () => {
          const m = state.mods[Number(inp.dataset.mtoggle)];
          try {
            if (inp.checked) { await post('/api/packs/mods/enable', { name: m.name }); return; }
            if (m.requiredBy.length && !(await confirmBox({ title: `Switch off ${m.title}?`, text: `<b>${esc(m.requiredBy.join(', '))}</b> need${m.requiredBy.length === 1 ? 's' : ''} it and will stop working until it is back on. Mod Guard will flag them.`, ok: 'Switch off', danger: true }))) { inp.checked = true; return; }
            await post('/api/packs/mods/disable', { name: m.name }); loadState();
          } catch (e) { toast(e.message, 'err'); inp.checked = !inp.checked; }
        });
        $$('[data-mrm]', view).forEach(b => b.onclick = async () => {
          const m = state.mods[Number(b.dataset.mrm)], cascade = m.requiredBy.length > 0;
          if (!(await confirmBox({ title: `Remove ${m.title}?`, text: cascade ? `<b>${esc(m.requiredBy.join(', '))}</b> need${m.requiredBy.length === 1 ? 's' : ''} it, so ${m.requiredBy.length === 1 ? 'that mod is' : 'those mods are'} removed too.` : 'It is deleted from the kit. Libraries only it needed are removed as well.', ok: cascade ? 'Remove all' : 'Remove', danger: true }))) return;
          try { const r = await api(`/api/packs/mods?name=${encodeURIComponent(m.name)}${cascade ? '&cascade=1' : ''}`, { method: 'DELETE' }); toast(`Removed ${r.removed.length} mod${r.removed.length > 1 ? 's' : ''}`, 'ok'); } catch (e) { toast(e.message, 'err'); }
          loadState();
        });
        $$('[data-dp]', view).forEach(b => b.onclick = () => {
          if (!S.snap.hasJar) return toast('Create the server first.', 'err');
          post('/api/packs/datapack', { id: b.dataset.dp, any }).catch(e => toast(e.message, 'err'));
        });
        $$('[data-rmdp]', view).forEach(b => b.onclick = async () => {
          if (!(await confirmBox({ title: 'Remove data pack?', text: `<b>${esc(b.dataset.rmdp)}</b> is removed from the world. Things it added (e.g. custom blocks) may disappear.`, ok: 'Remove', danger: true }))) return;
          try { const r = await api('/api/packs/datapack?name=' + encodeURIComponent(b.dataset.rmdp), { method: 'DELETE' }); toast(r && r.pending ? 'Switched off now. Windows keeps the file locked while the server runs - it is deleted automatically when the server stops.' : 'Removed', 'ok', r && r.pending ? 8000 : 3000); loadState(); } catch (e) { toast(e.message, 'err'); }
        });
        $$('[data-rmkit]', view).forEach(b => b.onclick = async () => { try { await api(`/api/packs/kit?folder=${b.dataset.folder}&name=${encodeURIComponent(b.dataset.rmkit)}`, { method: 'DELETE' }); loadState(); } catch (e) { toast(e.message, 'err'); } });
        const rm = $('#rmPack'); if (rm) rm.onclick = async () => {
          if (!(await confirmBox({ title: 'Remove the server texture pack?', ok: 'Remove', danger: true }))) return;
          try { await api('/api/packs/server-pack', { method: 'DELETE' }); toast('Server pack removed'); loadState(); } catch (e) { toast(e.message, 'err'); }
        };
        const ed = $('#editPack'); if (ed) ed.onclick = () => useOnServer({ url: state.serverPack.url, name: state.serverPack.name, require: state.serverPack.require, prompt: state.serverPack.prompt });
        const cp = $('#customPack'); if (cp) cp.onclick = () => useOnServer({ custom: true });
        const db = $('#docBtn'); if (db) db.onclick = doctorModal;
        $$('[data-preset]', view).forEach(b => b.onclick = async () => {
          b.disabled = true;
          try { await post('/api/packs/preset', { id: b.dataset.preset }); toast(`Adding ${b.querySelector('b').textContent} + Iris + Sodium…`); }
          catch (e) { toast(e.message, 'err'); b.disabled = false; }
        });
        $$('#srcSeg button').forEach(b => b.onclick = () => { source = b.dataset.src; store.set('packSource', source); results = null; offset = 0; draw(); search(); });
        $('#pasteList').onclick = importModal;
        const lf = $('#linkForm'); if (lf) lf.onsubmit = async e => {
          e.preventDefault(); const v = $('#linkIn').value.trim(); if (!v) return;
          const b = $('button', lf); b.disabled = true; b.innerHTML = '<span class="spinner"></span>';
          try { const r = await post('/api/packs/lookup', { input: v }); matchesModal(r.item, r.matches); }
          catch (err) { toast(err.message, 'err'); }
          b.disabled = false; b.innerHTML = ic('search') + 'Find & add';
        };
        const kd = $('#kitDrop');
        if (kd) {
          const upload = async files => {
            for (const f of files) {
              const folder = /\.jar$/i.test(f.name) ? 'mods' : tab === 'shader' ? 'shaderpacks' : tab === 'mod' ? 'mods' : 'resourcepacks';
              try { await api(`/api/packs/kit/upload?folder=${folder}&name=${encodeURIComponent(f.name)}`, { method: 'POST', raw: f }); toast(`Added ${f.name} to the kit`); }
              catch (e) { toast(`${f.name}: ${e.message}`, 'err', 8000); }
            }
            loadState();
          };
          $('#kitFile').onchange = e => upload([...e.target.files]);
          kd.ondragover = e => { e.preventDefault(); kd.classList.add('over'); };
          kd.ondragleave = () => kd.classList.remove('over');
          kd.ondrop = e => { e.preventDefault(); kd.classList.remove('over'); upload([...e.dataTransfer.files]); };
        }
        const setHref = () => { const d = $('#instDl'); if (d) d.href = `/api/packs/installer?iris=${store.get('instIris', true) ? 1 : 0}&bundle=${store.get('instBundle', true) ? 1 : 0}`; };
        const ii = $('#instIris'); if (ii) ii.onchange = () => { store.set('instIris', ii.checked); setHref(); };
        const ib = $('#instBundle'); if (ib) ib.onchange = () => { store.set('instBundle', ib.checked); draw(); };
        const idl = $('#instDl'); if (idl) idl.onclick = e => { if (!state.kit.length) { e.preventDefault(); toast('Add shaders or texture packs to the kit first', 'err'); } else toast('Installer downloaded — send it to your friends', 'ok', 5000); };
      }

      async function addMatch(mt) {
        await post('/api/packs/kit', { type: mt.type === 'datapack' ? 'resourcepack' : mt.type, id: mt.id, any: mt.type !== 'mod' });
        await new Promise(res => { const iv = setInterval(() => { const t = S.snap && S.snap.task; if (!t || t.done) { clearInterval(iv); res(); } }, 400); });
        const t = S.snap.task; if (t && t.error) throw new Error(t.error);
      }
      function matchRow(mt, i) {
        return `<div class="list-row"><div class="avatar sm">${mt.icon ? `<img src="${esc(mt.icon)}" alt="">` : ''}${esc((mt.title || '?')[0])}</div>
          <div class="grow"><b>${esc(mt.title)}</b> <span class="sub">${mt.type} · ${mt.source === 'curseforge' ? 'CurseForge' : 'Modrinth'}${mt.forVersion === false ? ' · made for older versions' : ''}</span></div>
          <a class="icon-btn" href="${esc(mt.page || '#')}" target="_blank" rel="noopener" title="Open page">${ic('external')}</a>
          ${mt.canDownload === false ? '<span class="dim small">site-only download</span>' : `<button class="btn btn-primary btn-sm" data-m="${i}">${ic('plus')}Add</button>`}</div>`;
      }
      function matchesModal(item, matches) {
        modal(`<h3>${matches.length ? 'Found it' : 'Not found automatically'}</h3>
          <p>${matches.length ? `Best sources for <b>${esc(item.name)}</b> - the first one is used, the others are alternatives.` : `Couldn't find <b>${esc(item.name)}</b> on Modrinth${S.cfKey ? ' or CurseForge' : ''}. ${item.link ? 'Open its page, download it, then drop the file on the upload box.' : ''}`}</p>
          <div class="list">${matches.map(matchRow).join('')}</div>
          ${!matches.length && item.link ? `<a class="btn btn-ghost" href="${esc(item.link)}" target="_blank" rel="noopener">${ic('external')}Open download page</a>` : ''}
          <div class="modal-actions"><button class="btn btn-ghost" data-close>Close</button></div>`, (m, close) => {
          $$('[data-m]', m).forEach(b => b.onclick = async () => {
            b.disabled = true; b.innerHTML = '<span class="spinner"></span>';
            try { await addMatch(matches[+b.dataset.m]); toast('Added to the kit'); close(); loadState(); }
            catch (e) { toast(e.message, 'err', 8000); b.disabled = false; b.innerHTML = ic('plus') + 'Add'; }
          });
        });
      }

      function importModal() {
        modal(`<h3>Paste a list</h3><p>Paste a YouTube description, a Reddit post or any list of pack / mod names. Blockhost finds each one and lets you add it with one click.</p>
          <textarea class="input" id="impText" rows="9" placeholder="Fresh Leaves by FreshLX – … ♡ https://…&#10;Nox Ropes by noxcturnal – …&#10;CIT Resewn ♡ Continuity ♡ Falling Leaves"></textarea>
          <div id="impRes" style="margin-top:12px"></div>
          <div class="modal-actions"><button class="btn btn-ghost" data-close>Close</button><button class="btn btn-ghost hidden" id="impAll">${ic('plus')}Add all found</button><button class="btn btn-primary" id="impGo">${ic('search')}Find them</button></div>`, m => {
          let rows = [];
          const drawRes = () => {
            $('#impRes', m).innerHTML = `<div class="list">${rows.map((r, i) => {
              const mt = r.match;
              const builtIn = /^(iris|sodium)( shaders)?$/i.test(r.name);
              const right = builtIn ? '<span class="tag green">included automatically</span>'
                : mt && mt.canDownload !== false ? `<span class="tag">${esc(mt.type === 'mod' ? 'mod' : mt.type === 'shader' ? 'shader' : 'texture pack')}</span>${mt.forVersion === false ? `<span class="tag gold" title="No build for this Minecraft version yet">old version</span>` : ''}${mt.serverSide === 'required' ? '<span class="tag red">needs modded server</span>' : ''}<button class="btn btn-primary btn-sm" data-imp="${i}" ${r.added ? 'disabled' : ''}>${r.added ? ic('check') + 'Added' : ic('plus') + 'Add'}</button>`
                : `${r.link ? `<a class="btn btn-ghost btn-sm" href="${esc(r.link)}" target="_blank" rel="noopener">${ic('external')}Download page</a>` : ''}<span class="dim small">then upload it</span>`;
              return `<div class="list-row"><div class="avatar sm">${mt && mt.icon ? `<img src="${esc(mt.icon)}" alt="">` : ''}${esc(r.name[0])}</div><div class="grow"><b>${esc(r.name)}</b> <span class="sub">${mt ? '→ ' + esc(mt.title) + ' (' + (mt.source === 'curseforge' ? 'CurseForge' : 'Modrinth') + ')' + (r.alternatives && r.alternatives.length ? ` +${r.alternatives.length} backup source${r.alternatives.length > 1 ? 's' : ''}` : '') : 'not found online'}</span></div>${right}</div>`;
            }).join('')}</div>`;
            $$('[data-imp]', m).forEach(b => b.onclick = () => addOne(Number(b.dataset.imp)));
            $('#impAll', m).classList.toggle('hidden', !rows.some(r => r.match && !r.added && r.match.canDownload !== false && !/^(iris|sodium)/i.test(r.name)));
          };
          const addOne = async i => {
            const r = rows[i];
            // try the best source first, then each alternative (e.g. Modrinth -> CurseForge)
            const options = [r.match, ...(r.alternatives || [])].filter(x => x && x.canDownload !== false);
            let lastErr = null;
            for (const mt of options) {
              try { await addMatch(mt); r.added = true; r.match = mt; drawRes(); return; } catch (e) { lastErr = e; }
            }
            if (lastErr) toast(`${r.name}: ${lastErr.message}`, 'err', 7000);
          };
          $('#impGo', m).onclick = async () => {
            const b = $('#impGo', m); b.disabled = true; b.innerHTML = '<span class="spinner"></span> Searching…';
            try { rows = await post('/api/packs/import', { text: $('#impText', m).value }); if (!rows.length) toast('No names found in that text', 'err'); drawRes(); }
            catch (e) { toast(e.message, 'err'); }
            b.disabled = false; b.innerHTML = ic('search') + 'Find again';
          };
          $('#impAll', m).onclick = async () => { for (let i = 0; i < rows.length; i++) { const r = rows[i]; if (r.match && !r.added && r.match.canDownload !== false && !/^(iris|sodium)/i.test(r.name)) await addOne(i); } loadState(); };
        }, true);
      }

      async function doctorModal() {
        modal(`<h3>Shader check — this PC</h3><div id="docBody"><div class="empty"><div class="spinner"></div>Checking…</div></div><div class="modal-actions"><button class="btn btn-ghost" id="docAgain">${ic('restart')}Check again</button><button class="btn btn-ghost" data-close>Close</button></div>`, m => {
          const run = async () => {
            const b = $('#docBody', m); b.innerHTML = '<div class="empty"><div class="spinner"></div>Checking…</div>';
            try {
              const d = await api('/api/client/doctor');
              b.innerHTML = `<div class="banner ${/Everything looks right/.test(d.verdict) ? '' : 'warn'}" style="margin-bottom:12px"><div class="b-ico">${ic(/Everything/.test(d.verdict) ? 'check' : 'alert')}</div><div class="b-text"><b>${esc(d.verdict)}</b>${d.fix ? `<span>${esc(d.fix)}</span>` : ''}</div></div>
                <div class="list">${d.checks.map(c => `<div class="list-row"><span class="tag ${c.ok ? 'green' : 'red'}">${ic(c.ok ? 'check' : 'x')}</span><div class="grow"><b>${esc(c.label)}</b> <span class="sub">${esc(c.detail)}</span></div></div>`).join('')}</div>
                ${d.logTail.length ? `<div class="field" style="margin-top:12px"><label>Errors from the game log</label><pre class="console-body" style="max-height:160px;margin:0;border-radius:10px;background:#07090d;font:12px var(--mono);white-space:pre-wrap">${d.logTail.map(esc).join('\n')}</pre></div>` : ''}
                ${d.culprits && d.culprits.length && d.culpritJars.length ? `<div class="row" style="margin-top:12px"><button class="btn btn-primary" id="docDisable">${ic('trash')}Move them out for me</button><span class="dim small">${esc(d.culpritJars.join(', '))} → mods\\_disabled-by-blockhost (you can move them back any time)</span></div>` : ''}
                <div class="dim small" style="margin-top:10px">Folder: <span class="mono">${esc(d.dir)}</span>. Friends see the same check when they run the installer again (it reads their last game log).</div>`;
              const dis = $('#docDisable', m); if (dis) dis.onclick = async () => {
                dis.disabled = true;
                try { const r = await post('/api/client/doctor/disable', { ids: d.culprits }); toast(`Moved ${r.moved.length} mod(s): ${r.moved.join(', ')}. Start Minecraft and join again.`, 'ok', 9000); run(); }
                catch (e) { toast(e.message, 'err', 9000); dis.disabled = false; }
              };
            } catch (e) { b.innerHTML = `<div class="empty">${ic('alert')}<div>${esc(e.message)}</div></div>`; }
          };
          $('#docAgain', m).onclick = run; run();
        }, true);
      }

      async function planAndAdd(id) {
        let plan; try { plan = await api('/api/packs/mod/plan?id=' + encodeURIComponent(id)); } catch (e) { return toast(e.message, 'err'); }
        const flat = []; const walk = (n, d) => { flat.push({ n, d }); n.deps.forEach(c => walk(c, d + 1)); }; walk(plan, 0);
        const depBad = flat.some(x => x.d > 0 && !x.n.ok), topBad = !plan.ok;
        modal(`<h3>Add “${esc(plan.title)}”</h3>
          <p class="muted small">${flat.length > 1 ? 'This mod needs other mods to work. Here is exactly what will be installed:' : 'This mod has no required mods.'}</p>
          <div class="list">${flat.map(({ n, d }) => `<div class="list-row" style="padding-left:${d * 18}px"><span class="tag ${!n.ok ? 'red' : n.installed ? '' : d ? 'blue' : 'green'}">${!n.ok ? 'not available' : n.installed ? 'already added' : d ? 'required' : 'this mod'}</span><div class="grow"><b>${esc(n.title)}</b>${!n.ok ? ` <span class="sub">${esc(n.reason || '')}</span>` : ''}</div></div>`).join('')}</div>
          ${flat.length > 1 ? `<label class="row" style="margin-top:12px"><span class="switch"><input type="checkbox" id="pmDeps" checked><span></span></span><span><b>Also install the required mods</b> <span class="muted small">(recommended)</span></span></label>` : ''}
          <div id="pmWarn" class="small" style="margin-top:8px"></div>
          <div class="modal-actions"><button class="btn btn-ghost" data-close>Cancel</button><button class="btn btn-primary" id="pmGo">${ic('plus')}Add</button></div>`, (m, close) => {
          const cb = $('#pmDeps', m);
          const sync = () => {
            const deps = cb ? cb.checked : true;
            $('#pmGo', m).disabled = topBad || (deps && depBad);
            $('#pmWarn', m).innerHTML = topBad ? `<span style="color:var(--redstone)">This mod can't be installed on your setup.</span>` : deps && depBad ? `<span style="color:var(--gold)">A required mod isn't available for your setup, so installing would fail. Switch off “Also install the required mods” to add only this one — it may not start without them.</span>` : !deps && flat.length > 1 ? `<span style="color:var(--gold)">Required mods are skipped. Mod Guard will warn you if something is missing.</span>` : '';
          };
          if (cb) cb.onchange = sync; sync();
          $('#pmGo', m).onclick = () => { const noDeps = cb ? !cb.checked : false; close(); post('/api/packs/kit', { type: 'mod', id, any, noDeps }).catch(e => toast(e.message, 'err')); };
        });
      }

      function useOnServer(o) {
        modal(`<h3>${o.custom ? 'Use your own texture pack' : 'Use “' + esc(o.name) + '” on the server'}</h3>
          <p>${o.custom ? 'Paste a <b>direct download</b> link to the .zip. Blockhost downloads it once to check it and compute the checksum.' : 'Blockhost downloads it once to verify it, then tells players to load it when they join.'}</p>
          ${o.custom ? `<div class="field" style="margin-bottom:12px"><label>Direct .zip link (https://…)</label><input class="input mono" id="upUrl" placeholder="https://download.mc-packs.net/pack/….zip"></div>
            <div class="field" style="margin-bottom:12px"><label>Name</label><input class="input" id="upName" placeholder="My pack"></div>` : ''}
          <div class="field" style="margin-bottom:12px"><label>Message shown to players</label><input class="input" id="upPrompt" value="${esc(o.prompt || 'This server uses a custom texture pack. Download it?')}" maxlength="120"></div>
          <label class="row"><span class="switch"><input type="checkbox" id="upReq" ${o.require ? 'checked' : ''}><span></span></span><span><b>Required</b> <span class="muted small">— players who decline are disconnected</span></span></label>
          <div class="modal-actions"><button class="btn btn-ghost" data-close>Cancel</button><button class="btn btn-primary" id="upGo">${ic('check')}Apply</button></div>`, (m, close) => {
          $('#upGo', m).onclick = async () => {
            const body = { require: $('#upReq', m).checked, prompt: $('#upPrompt', m).value.trim(), any };
            if (o.custom) { body.url = $('#upUrl', m).value.trim(); body.name = $('#upName', m).value.trim(); if (!/^https:\/\//.test(body.url)) return toast('Use a link that starts with https://', 'err'); }
            else if (o.id) { body.id = o.id; body.name = o.name; }
            else { body.url = o.url; body.name = o.name; }
            try { await post('/api/packs/server-pack', body); close(); } catch (e) { toast(e.message, 'err'); }
          };
        });
      }

      async function search(append) {
        loading = true;
        try {
          searchErr = null;
          const r = await api(`/api/packs/search?type=${tab}&q=${encodeURIComponent(q)}&offset=${offset}&source=${source}${any ? '&any=1' : ''}${tab === 'mod' && anyLoader ? '&loader=any' : ''}`);
          results = append && results ? results.concat(r.hits) : r.hits; total = r.total;
        } catch (e) { results = results || []; if (e.code === 'CF_KEY') searchErr = e.message; else toast('Search failed: ' + e.message, 'err'); }
        loading = false; draw();
      }
      async function loadState() {
        try { state = await api('/api/packs/state'); } catch { /* ignore */ }
        draw();
        if (state && (tab === 'shader' || tab === 'mod')) api('/api/packs/installer/check').then(c => { state.installer = c; draw(); }).catch(() => {});
        if (state && tab === 'mod') api('/api/packs/mods').then(r => { state.mods = r.mods; draw(); }).catch(() => {});
        if (state && tab === 'mod') api('/api/packs/guard').then(g => { state.guard = g; draw(); }).catch(() => {});
        if (state && tab === 'mod') api('/api/packs/kit/check').then(c => { state.check = c; draw(); }).catch(() => { state.check = []; draw(); });
      }

      draw(); loadState(); search();
      on(k => { if (k === 'taskdone') loadState(); });
    },
  };

  // ============================================================== SETUP WIZARD
  const STEPS = ['Basics', 'Version', 'World', 'Performance', 'Friends'];
  pages.setup = {
    title: 'Set up your server', sub: 'Five quick steps — then one click creates everything',
    render(view, on) {
      const memG = S.stats && S.stats.memTotal ? Math.round(S.stats.memTotal / 1073741824) : 8;
      const recRam = Math.max(2, Math.min(6, Math.floor(memG / 3)));
      const W = S.wizard || (S.wizard = {
        step: Number((location.hash.match(/step=(\d)/) || [])[1] || 1),
        motd: S.snap.motd && S.snap.motd !== 'A Minecraft Server' ? S.snap.motd : 'My Minecraft Server',
        cracked: S.snap.hasJar ? !S.snap.onlineMode : true, eula: S.snap.eula, version: 'latest', versions: null, latest: null,
        mode: S.snap.gamemode || 'survival', difficulty: S.snap.difficulty || 'normal', maxPlayers: S.snap.maxPlayers || 10,
        seed: '', type: 'minecraft:normal', ram: recRam + 'G', address: S.snap.address || '', shortcut: true,
      });
      const hs = location.hash.match(/step=(\d)/); if (hs) W.step = Number(hs[1]);
      if (!W.versions) api('/api/versions').then(r => { W.versions = r.versions; W.latest = r.latest.release; if (W.step === 2) draw(); }).catch(() => { W.versions = []; });

      const stepper = () => `<div class="stepper">${STEPS.map((s, i) => `<button class="st ${W.step === i + 1 ? 'on' : ''} ${W.step > i + 1 ? 'done' : ''}" data-go="${i + 1}"><i>${W.step > i + 1 ? ic('check') : i + 1}</i><span>${s}</span></button>`).join('<b class="st-line"></b>')}</div>`;
      const choice = (key, val, title, sub, icon, cur) => `<button class="choice ${cur ? 'on' : ''}" data-key="${key}" data-val="${esc(val)}">${ic(icon)}<b>${title}</b><span>${sub}</span></button>`;

      const body = () => {
        switch (W.step) {
          case 1: return `<h2 class="wz-h">Let’s create your server</h2><p class="muted">Give it a name and choose who will play.</p>
            <div class="field"><label>Server name (shown in the server list)</label><input class="input" id="wMotd" value="${esc(W.motd)}" maxlength="60"></div>
            <div class="motd-preview" style="margin-top:10px">${mcFormat(W.motd)}</div>
            <div class="field" style="margin-top:18px"><label>Who is joining?</label>
              <div class="choice-grid">${choice('cracked', 'true', 'Friends on TLauncher', 'Allows cracked / offline launchers', 'users', W.cracked)}${choice('cracked', 'false', 'Official accounts only', 'Everyone owns Minecraft (safer)', 'shield', !W.cracked)}</div></div>
            <label class="row eula"><input type="checkbox" id="wEula" ${W.eula ? 'checked' : ''}><span>I agree to the <a href="https://aka.ms/MinecraftEULA" target="_blank" rel="noopener">Minecraft EULA</a> (required by Mojang)</span></label>`;
          case 2: return `<h2 class="wz-h">Pick a Minecraft version</h2><p class="muted">Everyone must choose this exact version in their launcher.</p>
            ${!W.versions ? '<div class="empty"><div class="spinner"></div>Loading versions from Mojang…</div>' : `
            <div class="choice-grid">${choice('version', 'latest', `Latest — ${esc(W.latest || '')}`, 'Recommended. Newest features.', 'sparkle', W.version === 'latest')}
              ${choice('version', 'pick', 'A specific version', 'For older launchers or packs', 'box', W.version !== 'latest')}</div>
            ${W.version !== 'latest' ? `<div class="field" style="margin-top:14px"><label>Version</label><select class="input" id="wVer">${W.versions.map(v => `<option ${v.id === W.version ? 'selected' : ''}>${esc(v.id)}</option>`).join('')}</select></div>` : ''}`}`;
          case 3: return `<h2 class="wz-h">Design your world</h2><p class="muted">You can change all of this later in Options.</p>
            <div class="choice-grid four">${choice('mode', 'survival', 'Survival', 'Classic', 'heart', W.mode === 'survival')}${choice('mode', 'creative', 'Creative', 'Build freely', 'sparkle', W.mode === 'creative')}${choice('mode', 'adventure', 'Adventure', 'Maps & minigames', 'pin', W.mode === 'adventure')}${choice('mode', 'hardcore', 'Hardcore', 'One life', 'skull', W.mode === 'hardcore')}</div>
            <div class="grid g-2" style="margin-top:16px">
              <div class="field"><label>Difficulty</label><div class="seg">${['peaceful', 'easy', 'normal', 'hard'].map(d => `<button class="${(W.mode === 'hardcore' ? 'hard' : W.difficulty) === d ? 'on' : ''}" data-diff="${d}" ${W.mode === 'hardcore' ? 'disabled' : ''}>${d}</button>`).join('')}</div></div>
              <div class="field"><label>Max players: <b id="mpVal">${W.maxPlayers}</b></label><input type="range" min="2" max="50" value="${W.maxPlayers}" id="wMax" class="range"></div>
              <div class="field"><label>Seed (optional)</label><input class="input mono" id="wSeed" value="${esc(W.seed)}" placeholder="random"></div>
              <div class="field"><label>World type</label><select class="input" id="wType">${['minecraft:normal', 'minecraft:large_biomes', 'minecraft:amplified', 'minecraft:flat'].map(t => `<option value="${t}" ${W.type === t ? 'selected' : ''}>${titleCase(t)}</option>`).join('')}</select></div>
            </div>`;
          case 4: if (!W.ramTouched && S.stats && S.stats.memTotal) { const g = Math.round(S.stats.memTotal / 1073741824); W.ram = Math.max(2, Math.min(6, Math.floor(g / 3))) + 'G'; }
            return `<h2 class="wz-h">How much memory?</h2><p class="muted">Your PC has about <b>${memG} GB</b> RAM. The server needs some, Windows and your game need the rest.</p>
            <div class="ram-row">${[2, 3, 4, 5, 6, 8, 10, 12].filter(g => g < memG).map(g => `<button class="ram ${W.ram === g + 'G' ? 'on' : ''}" data-ram="${g}G"><b>${g} GB</b>${g === recRam ? '<span>recommended</span>' : g <= 2 ? '<span>light</span>' : g >= 8 ? '<span>big worlds</span>' : ''}</button>`).join('')}</div>
            <div class="dim small" style="margin-top:12px">Tip: if you play on the same PC, leave at least 6 GB free for your own game.</div>`;
          case 5: {
            const pl = S.snap.playit;
            return `<h2 class="wz-h">Let friends join</h2><p class="muted">playit.gg gives your server a free public address without router setup.</p>
            <div class="setup-steps">
              <div class="ss ${pl.path ? 'done' : ''}"><i>${pl.path ? ic('check') : '1'}</i><div><b>Install playit.gg</b><span>${pl.path ? 'Found: ' + esc(pl.path) : 'Official signed download, verified before running.'}</span></div>
                ${pl.path ? (pl.running ? '<span class="tag green">running</span>' : `<button class="btn btn-ghost btn-sm" id="plStart">${ic('play')}Open</button>`) : `<button class="btn btn-primary btn-sm" id="plInstall">${ic('download')}Install</button>`}</div>
              <div class="ss"><i>2</i><div><b>Link it to your free account</b><span>In the playit window, open the <b>claim link</b> and sign in / sign up. (Only you can do this step.)</span></div><a class="btn btn-ghost btn-sm" href="https://playit.gg/login" target="_blank" rel="noopener">${ic('external')}playit.gg</a></div>
              <div class="ss"><i>3</i><div><b>Add a tunnel</b><span>Tunnels → Add tunnel → <b>Minecraft Java</b>, local address <b class="mono">127.0.0.1</b>, local port <b class="mono">${esc(S.snap.port)}</b></span></div><button class="btn btn-ghost btn-sm" id="cpPort">${ic('copy')}Copy port</button></div>
              <div class="ss"><i>4</i><div style="flex:1"><b>Paste the address it gives you</b><input class="input mono" id="wAddr" value="${esc(W.address)}" placeholder="name.gl.joinmc.link or xxx.ply.gg:12345" style="margin-top:8px"></div></div>
            </div>
            <label class="row" style="margin-top:14px"><span class="switch"><input type="checkbox" id="wSc" ${W.shortcut ? 'checked' : ''}><span></span></span><span>Put a <b>Minecraft Server</b> shortcut on my desktop</span></label>
            <div class="dim small" style="margin-top:8px">You can skip playit for now and play on this PC with address <b class="mono">localhost:${esc(S.snap.port)}</b>.</div>`;
          }
        }
        return '';
      };

      const summary = () => `<div class="wz-sum"><div class="eyebrow">Summary</div>
        <div class="motd" style="margin:6px 0 12px">${mcFormat(W.motd)}</div>
        <div class="kv"><span>Players</span><b>${W.cracked ? 'TLauncher / cracked OK' : 'Official accounts'}</b></div>
        <div class="kv"><span>Version</span><b>${W.version === 'latest' ? (W.latest || 'latest') : esc(W.version)}</b></div>
        <div class="kv"><span>Mode</span><b>${titleCase(W.mode)} · ${W.mode === 'hardcore' ? 'hard' : W.difficulty}</b></div>
        <div class="kv"><span>Players max</span><b>${W.maxPlayers}</b></div>
        <div class="kv"><span>RAM</span><b>${W.ram}</b></div>
        <div class="kv"><span>Address</span><b class="mono" style="font-size:12px">${esc(W.address || '—')}</b></div>
        ${S.snap.hasJar ? '<div class="banner warn" style="margin-top:14px;padding:10px"><div class="b-text"><span>A server already exists here. Your world is kept — only settings & version change.</span></div></div>' : ''}</div>`;

      function draw() {
        view.innerHTML = `<div class="wizard">${stepper()}
          <div class="wz-grid"><div class="card wz-card">${body()}
            <div class="wz-nav"><button class="btn btn-ghost" id="wBack" ${W.step === 1 ? 'disabled' : ''}>Back</button><span style="flex:1"></span>
              ${W.step < 5 ? `<button class="btn btn-primary" id="wNext">Next ${ic('play').replace('<svg ', '<svg style="width:12px;height:12px" ')}</button>` : `<button class="btn btn-success" id="wCreate" style="height:44px;padding:0 22px">${ic('sparkle')}${S.snap.hasJar ? 'Apply & start' : 'Create my server'}</button>`}</div></div>
          ${summary()}</div></div>`;
        bindW();
      }
      function capture() {
        const g = id => $(id, view);
        if (g('#wMotd')) W.motd = g('#wMotd').value.trim() || 'My Minecraft Server';
        if (g('#wEula')) W.eula = g('#wEula').checked;
        if (g('#wVer')) W.version = g('#wVer').value;
        if (g('#wSeed')) W.seed = g('#wSeed').value.trim();
        if (g('#wType')) W.type = g('#wType').value;
        if (g('#wAddr')) W.address = g('#wAddr').value.trim();
        if (g('#wSc')) W.shortcut = g('#wSc').checked;
      }
      function go(n) {
        capture();
        if (n > 1 && W.step === 1 && !W.eula) { toast('Please accept the Minecraft EULA to continue.', 'err'); return; }
        W.step = Math.max(1, Math.min(5, n)); draw();
      }
      function bindW() {
        $$('[data-go]', view).forEach(b => b.onclick = () => go(Number(b.dataset.go)));
        const bk = $('#wBack'); if (bk) bk.onclick = () => go(W.step - 1);
        const nx = $('#wNext'); if (nx) nx.onclick = () => go(W.step + 1);
        $$('.choice', view).forEach(b => b.onclick = () => {
          capture();
          const k = b.dataset.key, v = b.dataset.val;
          if (k === 'cracked') W.cracked = v === 'true';
          if (k === 'mode') W.mode = v;
          if (k === 'version') W.version = v === 'latest' ? 'latest' : (W.versions && W.versions[0] ? W.versions[0].id : 'latest');
          draw();
        });
        $$('[data-diff]', view).forEach(b => b.onclick = () => { capture(); W.difficulty = b.dataset.diff; draw(); });
        $$('[data-ram]', view).forEach(b => b.onclick = () => { W.ram = b.dataset.ram; W.ramTouched = true; draw(); });
        const mx = $('#wMax'); if (mx) mx.oninput = () => { W.maxPlayers = Number(mx.value); $('#mpVal').textContent = mx.value; };
        const m = $('#wMotd'); if (m) m.oninput = () => { W.motd = m.value; $('.motd-preview', view).innerHTML = mcFormat(m.value); };
        const pi = $('#plInstall'); if (pi) pi.onclick = () => { capture(); post('/api/playit/install').catch(e => toast(e.message, 'err')); };
        const ps = $('#plStart'); if (ps) ps.onclick = () => post('/api/playit/start').then(() => toast('playit.gg opened in its own window')).catch(e => toast(e.message, 'err'));
        const cp = $('#cpPort'); if (cp) cp.onclick = () => copyText(String(S.snap.port));
        const cr = $('#wCreate'); if (cr) cr.onclick = create;
      }
      async function create() {
        capture();
        if (!W.eula) { W.step = 1; draw(); return toast('Please accept the Minecraft EULA first.', 'err'); }
        const hardcore = W.mode === 'hardcore';
        const properties = {
          motd: W.motd, 'online-mode': String(!W.cracked), 'enforce-secure-profile': String(!W.cracked),
          gamemode: hardcore ? 'survival' : W.mode, difficulty: hardcore ? 'hard' : W.difficulty, hardcore: String(hardcore),
          'max-players': String(W.maxPlayers), 'level-type': W.type,
        };
        if (W.seed) properties['level-seed'] = W.seed;
        try {
          await post('/api/setup', { eula: true, version: W.version, ram: W.ram, address: W.address, properties, shortcut: W.shortcut, startNow: true });
          $('#wCreate').disabled = true; $('#wCreate').innerHTML = '<span class="spinner"></span> Working…';
        } catch (e) { toast(e.message, 'err'); }
      }
      draw();
      on((k, t) => {
        if (k === 'taskdone' && t && t.title === 'Create server' && !t.error) { S.wizard = null; toast('Your server is ready!', 'ok', 5000); location.hash = '#/overview'; }
        else if (k === 'taskdone' && t && t.title === 'Create server') draw();
        else if ((k === 'state' || k === 'taskdone') && W.step === 5) { capture(); draw(); }
      });
    },
  };
  window.BH.init();
})();
