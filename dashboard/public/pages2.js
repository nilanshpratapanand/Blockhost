/* Blockhost dashboard — configuration & data pages */
(() => {
  'use strict';
  const { $, $$, esc, ic, api, post, cmd, toast, modal, confirmBox, fmtBytes, fmtDate, ago, titleCase, mcFormat, store, S, pages } = window.BH;
  const online = () => S.snap && S.snap.state === 'online';
  const running = () => S.snap && ['online', 'starting', 'stopping'].includes(S.snap.state);

  function restartPrompt(msg) {
    if (!running()) { toast(msg || 'Saved'); return; }
    const el = document.createElement('div');
    el.className = 'toast';
    el.innerHTML = `${ic('info')}<div style="flex:1">${esc(msg || 'Saved')} — restart to apply.</div><button class="btn btn-primary btn-sm">Restart</button>`;
    $('button', el).onclick = () => { post('/api/restart'); el.remove(); };
    $('#toasts').appendChild(el); setTimeout(() => el.remove(), 9000);
  }

  // ============================================================== OPTIONS (server.properties)
  const PROP_GROUPS = [
    ['General', 'sliders', [
      ['motd', 'Message of the day', 'motd', 'Shown in the multiplayer server list'],
      ['max-players', 'Max players', 'number'],
      ['gamemode', 'Default game mode', ['survival', 'creative', 'adventure', 'spectator']],
      ['difficulty', 'Difficulty', ['peaceful', 'easy', 'normal', 'hard']],
      ['hardcore', 'Hardcore', 'bool'],
      ['force-gamemode', 'Force game mode on join', 'bool'],
      ['allow-flight', 'Allow flight', 'bool', 'Stops "flying is not enabled" kicks'],
      ['spawn-protection', 'Spawn protection radius', 'number'],
      ['player-idle-timeout', 'AFK kick (minutes, 0 = off)', 'number'],
      ['pause-when-empty-seconds', 'Pause when empty (seconds)', 'number'],
    ]],
    ['World', 'globe', [
      ['level-name', 'World folder name', 'text'],
      ['level-seed', 'Seed', 'text', 'Only used when a new world is created'],
      ['level-type', 'World type', ['minecraft:normal', 'minecraft:flat', 'minecraft:large_biomes', 'minecraft:amplified', 'minecraft:single_biome_surface']],
      ['generate-structures', 'Generate structures', 'bool'],
      ['view-distance', 'View distance (chunks)', 'number', 'Lower = less lag. 8–12 is typical'],
      ['simulation-distance', 'Simulation distance (chunks)', 'number'],
      ['max-world-size', 'Max world radius', 'number'],
    ]],
    ['Access', 'shield', [
      ['online-mode', 'Online mode (premium accounts only)', 'bool', 'Turn OFF for TLauncher / cracked players'],
      ['white-list', 'Whitelist', 'bool'],
      ['enforce-whitelist', 'Kick non-whitelisted on reload', 'bool'],
      ['enforce-secure-profile', 'Require signed chat', 'bool', 'Keep OFF for cracked players'],
      ['hide-online-players', 'Hide player list in server menu', 'bool'],
      ['op-permission-level', 'Operator permission level', ['1', '2', '3', '4']],
    ]],
    ['Network', 'link', [
      ['server-port', 'Server port', 'number', 'Must match your playit.gg tunnel target'],
      ['server-ip', 'Bind IP (leave empty)', 'text'],
      ['enable-status', 'Show in server list', 'bool'],
      ['network-compression-threshold', 'Compression threshold', 'number'],
      ['rate-limit', 'Packet rate limit (0 = off)', 'number'],
      ['log-ips', 'Log player IPs', 'bool'],
    ]],
    ['Resource pack', 'image', [
      ['resource-pack', 'Resource pack URL', 'text'],
      ['resource-pack-sha1', 'Pack SHA-1', 'text'],
      ['require-resource-pack', 'Require resource pack', 'bool'],
      ['resource-pack-prompt', 'Prompt text', 'text'],
    ]],
  ];

  pages.options = {
    title: 'Options', sub: 'server.properties — most changes apply after a restart',
    render(view) {
      let props = {}, changes = {};
      const known = new Set(PROP_GROUPS.flatMap(g => g[2].map(p => p[0])));
      view.innerHTML = `<div class="stack" id="opWrap"><div class="card"><div class="skeleton" style="width:30%"></div></div></div>`;

      const val = k => (k in changes ? changes[k] : props[k] ?? '');
      const control = (k, type) => {
        const v = val(k);
        if (type === 'bool') return `<label class="switch"><input type="checkbox" data-k="${k}" ${v === 'true' ? 'checked' : ''}><span></span></label>`;
        if (Array.isArray(type)) return `<select class="input" data-k="${k}">${(type.includes(v) || !v ? type : [v, ...type]).map(o => `<option ${o === v ? 'selected' : ''} value="${esc(o)}">${esc(titleCase(o))}</option>`).join('')}</select>`;
        return `<input class="input ${type === 'number' ? 'mono' : ''}" data-k="${k}" type="${type === 'number' ? 'number' : 'text'}" value="${esc(v)}">`;
      };

      const draw = () => {
        const adv = Object.keys(props).filter(k => !known.has(k) && k !== 'motd').sort();
        $('#opWrap').innerHTML = `
          <div class="card">
            <div class="card-h"><h2>Look in the server list</h2></div>
            <div class="grid g-2" style="align-items:start">
              <div class="field"><label>MOTD</label><input class="input mono" data-k="motd" id="motdIn" value="${esc(val('motd'))}" maxlength="160">
                <div class="color-codes" id="mcCodes">${Object.entries({ 0: '#000', 1: '#00A', 2: '#0A0', 3: '#0AA', 4: '#A00', 5: '#A0A', 6: '#FA0', 7: '#AAA', 8: '#555', 9: '#55F', a: '#5F5', b: '#5FF', c: '#F55', d: '#F5F', e: '#FF5', f: '#FFF' }).map(([c, h]) => `<button style="background:${h}" data-c="${c}" title="§${c}"></button>`).join('')}
                  <button data-c="l" style="background:#2a3145" title="Bold">B</button><button data-c="o" style="background:#2a3145;font-style:italic" title="Italic">I</button><button data-c="r" style="background:#2a3145" title="Reset">R</button></div>
                <div class="hint">Use \\n for a second line. Click a color to insert its code.</div></div>
              <div class="field"><label>Preview</label>
                <div class="row" style="gap:12px;align-items:flex-start;flex-wrap:nowrap"><div class="server-icon" id="iconPrev" style="cursor:pointer" title="Change icon"><img src="/api/icon?${Date.now()}" onerror="this.replaceWith(Object.assign(document.createElement('span'),{className:'dim small',textContent:'64×64'}))"></div>
                <div class="motd-preview" id="motdPrev" style="flex:1"></div></div>
                <div class="row"><button class="btn btn-ghost btn-sm" id="iconBtn">${ic('image')}Upload server icon</button><input type="file" id="iconFile" accept="image/*" hidden><span class="dim small">Any image — resized to 64×64</span></div>
              </div>
            </div>
          </div>
          ${PROP_GROUPS.map(([g, icon, items]) => `<div class="card"><div class="card-h">${ic(icon).replace('<svg ', '<svg width="18" height="18" ')}<h2>${g}</h2></div>
            <div class="opt-grid">${items.filter(([k]) => k !== 'motd').map(([k, label, type, hint]) => `<div class="opt ${k in changes ? 'dirty' : ''}" data-row="${k}"><div class="opt-text"><b>${esc(label)}</b><span title="${esc(hint || k)}">${esc(hint || k)}</span></div>${control(k, type)}</div>`).join('')}</div></div>`).join('')}
          <details class="card"><summary style="cursor:pointer;font-weight:700">Advanced — all other properties (${adv.length})</summary>
            <div class="opt-grid" style="margin-top:14px">${adv.map(k => `<div class="opt ${k in changes ? 'dirty' : ''}" data-row="${k}"><div class="opt-text"><b>${esc(k)}</b></div>${/secret|password/.test(k) ? `<input class="input" type="password" data-k="${k}" value="${esc(val(k))}">` : control(k, props[k] === 'true' || props[k] === 'false' ? 'bool' : 'text')}</div>`).join('')}</div></details>
          <div class="savebar ${Object.keys(changes).length ? '' : 'hidden'}" id="saveBar"><span class="grow"><b>${Object.keys(changes).length}</b> unsaved change${Object.keys(changes).length === 1 ? '' : 's'}</span><button class="btn btn-ghost btn-sm" id="discard">Discard</button><button class="btn btn-primary btn-sm" id="saveProps">${ic('save')}Save changes</button></div>`;

        const prev = () => { $('#motdPrev').innerHTML = mcFormat(val('motd') || 'A Minecraft Server'); };
        prev();
        const mark = (k, v) => {
          if (String(v) === String(props[k] ?? '')) delete changes[k]; else changes[k] = String(v);
          const row = $(`[data-row="${CSS.escape(k)}"]`); if (row) row.classList.toggle('dirty', k in changes);
          const n = Object.keys(changes).length, sb = $('#saveBar');
          sb.classList.toggle('hidden', !n); $('b', sb).textContent = n;
          if (k === 'motd') prev();
        };
        $$('[data-k]', view).forEach(el => {
          const ev = el.type === 'checkbox' ? 'change' : 'input';
          el.addEventListener(ev, () => {
            const k = el.dataset.k, v = el.type === 'checkbox' ? String(el.checked) : el.value;
            if (k === 'online-mode' && v === 'true' && props[k] === 'false') toast('Heads up: with online mode ON, TLauncher/cracked players can no longer join.', 'info', 6000);
            mark(k, v);
          });
        });
        $$('#mcCodes button').forEach(b => b.onclick = () => { const i = $('#motdIn'); const p = i.selectionStart ?? i.value.length; i.value = i.value.slice(0, p) + '§' + b.dataset.c + i.value.slice(p); i.focus(); i.setSelectionRange(p + 2, p + 2); mark('motd', i.value); });
        $('#discard').onclick = () => { changes = {}; draw(); };
        $('#saveProps').onclick = async () => {
          try {
            if (changes['server-port'] && changes['server-port'] !== props['server-port']) toast('Remember to update the local port in your playit.gg tunnel too.', 'info', 7000);
            const r = await post('/api/properties', { changes });
            props = { ...props, ...changes }; changes = {}; draw();
            if (r.restartNeeded) restartPrompt('Options saved'); else toast('Options saved');
          } catch (e) { toast(e.message, 'err'); }
        };
        const pickIcon = () => $('#iconFile').click();
        $('#iconBtn').onclick = pickIcon; $('#iconPrev').onclick = pickIcon;
        $('#iconFile').onchange = e => {
          const f = e.target.files[0]; if (!f) return;
          const img = new Image();
          img.onload = () => {
            const c = document.createElement('canvas'); c.width = c.height = 64;
            const x = c.getContext('2d'); const s = Math.min(img.width, img.height);
            x.imageSmoothingQuality = 'high';
            x.drawImage(img, (img.width - s) / 2, (img.height - s) / 2, s, s, 0, 0, 64, 64);
            c.toBlob(async blob => {
              try { const r = await api('/api/icon', { method: 'POST', raw: blob }); draw(); r.restartNeeded ? restartPrompt('Icon updated') : toast('Icon updated'); }
              catch (err) { toast(err.message, 'err'); }
            }, 'image/png');
            URL.revokeObjectURL(img.src);
          };
          img.src = URL.createObjectURL(f);
        };
      };
      api('/api/properties').then(r => { props = r.properties; draw(); }).catch(e => toast(e.message, 'err'));
    },
  };

  // ============================================================== GAME RULES
  const RULE_HELP = {
    keep_inventory: 'Keep items after death', advance_time: 'Day/night cycle', advance_weather: 'Weather changes', spawn_mobs: 'Mobs spawn naturally',
    mob_griefing: 'Creepers/Endermen change blocks', pvp: 'Players can hurt each other', natural_health_regeneration: 'Regenerate health from food',
    immediate_respawn: 'Skip the death screen', show_death_messages: 'Death messages in chat', show_advancement_messages: 'Announce advancements',
    fall_damage: 'Fall damage', fire_damage: 'Fire damage', drowning_damage: 'Drowning damage', freeze_damage: 'Powder snow damage',
    spawn_phantoms: 'Phantoms when not sleeping', random_tick_speed: 'Crop/plant growth speed (default 3)', players_sleeping_percentage: '% of players needed to skip night',
    respawn_radius: 'Spawn area radius', tnt_explodes: 'TNT explodes', raids: 'Raids happen', locator_bar: 'Locator bar on HUD',
    block_drops: 'Blocks drop items', mob_drops: 'Mobs drop loot', command_block_output: 'Command blocks log to chat', send_command_feedback: 'Show command feedback',
    max_entity_cramming: 'Entities per block before damage', spawn_wardens: 'Wardens spawn', spawn_patrols: 'Pillager patrols', spawn_wandering_traders: 'Wandering traders',
    fire_spread_radius_around_player: 'Fire spread distance (0 = off)',
  };
  const FEATURED = ['keep_inventory', 'advance_time', 'advance_weather', 'mob_griefing', 'pvp', 'spawn_mobs', 'immediate_respawn', 'spawn_phantoms', 'players_sleeping_percentage', 'random_tick_speed'];

  pages.gamerules = {
    title: 'Game rules', sub: 'Stored inside the world — changes apply instantly while online',
    render(view, on) {
      let data = null, q = '';
      const draw = () => {
        if (!data) { view.innerHTML = `<div class="card"><div class="skeleton" style="width:30%"></div></div>`; return; }
        const bare = r => r.key.replace(/^minecraft:/, '');
        const rules = data.rules.filter(r => !q || bare(r).includes(q) || (RULE_HELP[bare(r)] || '').toLowerCase().includes(q));
        const feat = rules.filter(r => FEATURED.includes(bare(r))).sort((a, b) => FEATURED.indexOf(bare(a)) - FEATURED.indexOf(bare(b)));
        const rest = rules.filter(r => !FEATURED.includes(bare(r))).sort((a, b) => bare(a).localeCompare(bare(b)));
        const dis = !online();
        const row = r => {
          const k = bare(r), isBool = r.type === 'boolean' || typeof r.value === 'boolean' || r.value === 'true' || r.value === 'false';
          const v = r.value;
          const ctl = isBool ? (v === null || v === undefined
            ? `<div class="seg"><button data-r="${esc(r.key)}" data-v="true" ${dis ? 'disabled' : ''}>On</button><button data-r="${esc(r.key)}" data-v="false" ${dis ? 'disabled' : ''}>Off</button></div>`
            : `<label class="switch"><input type="checkbox" data-rb="${esc(r.key)}" ${String(v) === 'true' ? 'checked' : ''} ${dis ? 'disabled' : ''}><span></span></label>`)
            : `<div class="input-group" style="width:150px"><input class="input mono" style="width:80px;height:32px" type="number" data-ri="${esc(r.key)}" value="${esc(v ?? '')}" placeholder="?" ${dis ? 'disabled' : ''}><button class="btn btn-ghost btn-sm" data-rs="${esc(r.key)}" ${dis ? 'disabled' : ''}>Set</button></div>`;
          return `<div class="opt"><div class="opt-text"><b>${esc(RULE_HELP[k] || titleCase(k))}</b><span>${esc(k)}</span></div>${ctl}</div>`;
        };
        view.innerHTML = `<div class="stack">
          ${dis ? `<div class="banner warn"><div class="b-ico">${ic('info')}</div><div class="b-text"><b>Start the server to change game rules</b><span>They are saved inside the world, so the server has to be running.</span></div></div>` : ''}
          <div class="row between"><div style="position:relative;width:min(320px,100%)"><input class="input" id="grQ" placeholder="Search rules…" value="${esc(q)}" style="padding-left:34px"><span style="position:absolute;left:11px;top:11px;color:var(--dim)">${ic('search').replace('<svg ', '<svg width="16" height="16" ')}</span></div>
            <span class="tag ${data.source === 'live' ? 'green' : 'gold'}">${data.source === 'live' ? 'Live values from the server' : 'Current values unknown — set them directly'}</span></div>
          ${feat.length ? `<div class="card"><div class="card-h"><h2>Most used</h2></div><div class="opt-grid">${feat.map(row).join('')}</div></div>` : ''}
          ${rest.length ? `<div class="card"><div class="card-h"><h2>All rules</h2><span class="sub">${rest.length}</span></div><div class="opt-grid">${rest.map(row).join('')}</div></div>` : ''}
        </div>`;
        const qi = $('#grQ'); qi.oninput = () => { q = qi.value.toLowerCase().trim(); const p = qi.selectionStart; draw(); const n = $('#grQ'); n.focus(); n.setSelectionRange(p, p); };
        $$('[data-rb]', view).forEach(el => el.onchange = () => setRule(el.dataset.rb, el.checked));
        $$('[data-r]', view).forEach(el => el.onclick = () => setRule(el.dataset.r, el.dataset.v === 'true'));
        $$('[data-rs]', view).forEach(el => el.onclick = () => { const i = $(`[data-ri="${CSS.escape(el.dataset.rs)}"]`, view); if (i.value !== '' && /^-?\d+$/.test(i.value)) setRule(el.dataset.rs, parseInt(i.value, 10)); });
      };
      async function setRule(key, value) {
        try {
          await post('/api/gamerules', { key, value });
          const r = data.rules.find(x => x.key === key); if (r) r.value = value;
          toast(`${titleCase(key)} → ${value}`);
          if (data.source !== 'live') draw();
        } catch (e) { toast(e.message, 'err'); }
      }
      const load = () => api('/api/gamerules').then(r => { data = r; draw(); }).catch(e => toast(e.message, 'err'));
      draw(); load();
      on(k => { if (k === 'state') load(); });
    },
  };

  // ============================================================== SOFTWARE
  pages.software = {
    title: 'Software', sub: 'Vanilla Minecraft versions straight from Mojang',
    render(view, on) {
      let v = null, java = null, snaps = false, q = '';
      const draw = () => {
        const s = S.snap;
        const cur = s.installedVersion;
        const upd = v && cur && v.latest.release !== cur;
        view.innerHTML = `<div class="stack">
          <div class="grid g-3">
            <div class="card"><div class="current-ver"><div class="ver-badge">${esc(cur || '—')}</div><div><div class="eyebrow">Installed</div><div style="font-size:18px;font-weight:800">${cur ? 'Vanilla ' + esc(cur) : 'Nothing installed'}</div><div class="muted small">${s.javaNeeded ? 'Needs Java ' + s.javaNeeded : ''}${s.version && s.version !== cur ? ' · running ' + esc(s.version) : ''}</div></div></div></div>
            <div class="card"><div class="eyebrow">Latest release</div><div style="font:700 26px var(--pixel);margin:4px 0 8px">${v ? esc(v.latest.release) : '<span class="skeleton" style="display:inline-block;width:80px"></span>'}</div>
              ${upd ? `<button class="btn btn-primary" id="updBtn">${ic('sparkle')}Update to ${esc(v.latest.release)}</button><div class="dim small" style="margin-top:8px">Stops the server, backs up the world, downloads & verifies, then starts again.</div>` : v ? `<span class="tag green">${ic('check')}You're up to date</span>` : ''}</div>
            <div class="card"><div class="eyebrow">Java</div>${java ? (java.best ? `<div style="font:700 26px var(--pixel);margin:4px 0 4px">Java ${java.best.major}</div><div class="dim small mono" style="word-break:break-all">${esc(java.best.path)}</div>`
              : `<div style="margin:6px 0 10px"><span class="tag red">${ic('alert')}Java ${java.need}+ not found</span></div><button class="btn btn-warn btn-sm" id="jInst">${ic('download')}Install Java ${java.need}</button>`) : '<div class="skeleton" style="width:60%;margin-top:10px"></div>'}
              ${java && java.found.length > 1 ? `<div class="dim small" style="margin-top:6px">Also found: ${java.found.filter(f => !java.best || f.path !== java.best.path).map(f => 'Java ' + f.major).join(', ')}</div>` : ''}</div>
          </div>
          <div class="card">
            <div class="card-h"><h2>All versions</h2><span class="spacer"></span>
              <input class="input" id="vQ" placeholder="Filter e.g. 1.21" style="width:180px;height:32px" value="${esc(q)}">
              <label class="row small muted" style="gap:6px"><span class="switch"><input type="checkbox" id="vSnap" ${snaps ? 'checked' : ''}><span></span></span>Snapshots</label></div>
            <div class="banner warn" style="margin-bottom:12px"><div class="b-ico">${ic('alert')}</div><div class="b-text"><b>Going to an older version can break your world</b><span>Worlds only upgrade forward. To downgrade, restore a backup made on that version or start a new world. All players must use the same version in TLauncher.</span></div></div>
            <div class="ver-list">${v ? v.versions.filter(x => !q || x.id.includes(q)).map(x => `<div class="ver-row"><b>${esc(x.id)}</b>${x.type === 'snapshot' ? '<span class="tag gold">snapshot</span>' : x.id === v.latest.release ? '<span class="tag purple">latest</span>' : ''}<span class="grow muted small">${fmtDate(x.releaseTime)}</span>
              ${x.id === cur ? `<span class="tag green">${ic('check')}installed</span><button class="btn btn-ghost btn-sm" data-re="${esc(x.id)}">Reinstall</button>` : `<button class="btn btn-ghost btn-sm" data-v="${esc(x.id)}">${ic('download')}Install</button>`}</div>`).join('')
              : `<div class="empty"><div class="spinner"></div>Loading versions from Mojang…</div>`}</div>
          </div></div>`;
        const u = $('#updBtn'); if (u) u.onclick = () => install(v.latest.release);
        const ji = $('#jInst'); if (ji) ji.onclick = () => window.BH.javaModal(java.need);
        $('#vSnap').onchange = e => { snaps = e.target.checked; load(); };
        $('#vQ').oninput = e => { q = e.target.value.trim(); const p = e.target.selectionStart; draw(); const n = $('#vQ'); n.focus(); n.setSelectionRange(p, p); };
        $$('[data-v]', view).forEach(b => b.onclick = () => install(b.dataset.v));
        $$('[data-re]', view).forEach(b => b.onclick = () => install(b.dataset.re, { reinstall: true }));
      };
      async function install(id, extra = {}) {
        const cur = S.snap.installedVersion;
        const ok = await confirmBox({ title: `Install Minecraft ${id}?`, text: `${running() ? 'The server will be stopped, ' : ''}${cur ? 'your world backed up, ' : ''}and the official server.jar downloaded from Mojang and checked.${running() ? ' It starts again when done.' : ''}`, ok: 'Install' });
        if (!ok) return;
        try {
          const t = await post('/api/install', { version: id, ...extra });
          void t;
        } catch (e) { toast(e.message, 'err'); }
      }
      const load = () => {
        api('/api/versions' + (snaps ? '?snapshots=1' : '')).then(r => { v = r; draw(); }).catch(e => { toast('Could not reach Mojang: ' + e.message, 'err'); });
        api('/api/java').then(r => { java = r; draw(); }).catch(() => {});
      };
      draw(); load();
      on(async (k, t) => {
        if (k === 'taskdone' && t && t.code === 'DOWNGRADE') {
          const id = t.title.replace(/^Install /, '');
          if (await confirmBox({ title: 'Downgrade anyway?', text: esc(t.error) + ' A backup is made first, but the world may fail to load. Only continue if you know what you are doing.', ok: 'Downgrade anyway', danger: true })) post('/api/install', { version: id, force: true }).catch(e => toast(e.message, 'err'));
          return;
        }
        if (k === 'taskdone' || k === 'state') load();
      });
    },
  };

  // ============================================================== BACKUPS
  pages.backups = {
    title: 'Backups', sub: 'Snapshots of your world — safe to make while the server runs',
    render(view, on) {
      let list = null, cfg = null;
      const draw = () => {
        view.innerHTML = `<div class="stack">
          <div class="grid g-2">
            <div class="card"><div class="card-h"><h2>Create a backup</h2></div>
              <form class="input-group" id="bkForm"><input class="input" id="bkLabel" placeholder="Label, e.g. before-nether-trip" maxlength="40"><button class="btn btn-primary">${ic('archive')}Back up now</button></form>
              <div class="dim small" style="margin-top:8px">Includes the world (overworld, nether, end), ops, whitelist, bans and server.properties. ${online() ? 'Saving is paused for a moment so the copy is consistent.' : ''}</div></div>
            <div class="card"><div class="card-h"><h2>Automatic backups</h2></div>
              <div class="row between"><span class="muted small">Every</span><div class="seg" id="autoSeg">${[[0, 'Off'], [30, '30m'], [60, '1h'], [180, '3h'], [360, '6h'], [720, '12h'], [1440, '24h']].map(([m, l]) => `<button data-m="${m}" class="${cfg && Number(cfg.autoBackupMinutes) === m ? 'on' : ''}">${l}</button>`).join('')}</div></div>
              <div class="row between" style="margin-top:12px"><span class="muted small">Keep the newest automatic backups</span><input class="input mono" id="keepN" type="number" min="1" max="200" value="${cfg ? cfg.backupsToKeep : 10}" style="width:90px;height:32px"></div>
              <div class="dim small" style="margin-top:8px">Only runs while the server is online. Manual backups are never deleted automatically.</div></div>
          </div>
          <div class="card"><div class="card-h"><h2>Saved backups</h2>${list ? `<span class="tag">${list.length}</span><span class="sub">${fmtBytes(list.reduce((a, b) => a + b.size, 0))} total</span>` : ''}</div>
            <div class="list">${!list ? '<div class="skeleton"></div>' : list.length ? list.map(b => `<div class="list-row"><div class="avatar sm" style="color:var(--amethyst-2)">${ic('archive')}</div>
              <div class="grow"><b>${esc(b.label)}</b> <span class="sub">${fmtDate(b.created)} · ${ago(b.created)} · ${fmtBytes(b.size)}</span></div>
              <button class="btn btn-ghost btn-sm" data-rs="${esc(b.name)}">${ic('restart')}Restore</button>
              <a class="icon-btn" title="Download" href="/api/backups/download?name=${encodeURIComponent(b.name)}">${ic('download')}</a>
              <button class="icon-btn danger" title="Delete" data-del="${esc(b.name)}">${ic('trash')}</button></div>`).join('')
              : `<div class="empty">${ic('archive')}<div>No backups yet. Make your first one above.</div></div>`}</div></div>
        </div>`;
        $('#bkForm').onsubmit = async e => { e.preventDefault(); try { await post('/api/backups', { label: $('#bkLabel').value.trim() || 'manual' }); } catch (err) { toast(err.message, 'err'); } };
        $$('#autoSeg button').forEach(b => b.onclick = () => saveCfg({ autoBackupMinutes: Number(b.dataset.m) }));
        $('#keepN').onchange = e => saveCfg({ backupsToKeep: Math.max(1, parseInt(e.target.value, 10) || 10) });
        $$('[data-del]', view).forEach(b => b.onclick = async () => {
          if (!(await confirmBox({ title: 'Delete this backup?', text: esc(b.dataset.del) + ' will be permanently deleted.', ok: 'Delete', danger: true }))) return;
          try { await api('/api/backups?name=' + encodeURIComponent(b.dataset.del), { method: 'DELETE' }); toast('Backup deleted'); load(); } catch (e) { toast(e.message, 'err'); }
        });
        $$('[data-rs]', view).forEach(b => b.onclick = () => restore(b.dataset.rs));
      };
      function restore(name) {
        modal(`<h3>Restore this backup?</h3><p>Your current world is replaced with <b class="mono">${esc(name)}</b>. A safety backup of the current world is made first.</p>
          <label class="row" style="margin-bottom:6px"><span class="switch"><input type="checkbox" id="rsCfg"><span></span></span><span>Also restore settings (server.properties, ops, whitelist, bans)</span></label>
          ${running() ? `<div class="banner warn" style="margin-top:12px"><div class="b-ico">${ic('alert')}</div><div class="b-text"><b>The server is running</b><span>It will be stopped first.</span></div></div>` : ''}
          <div class="modal-actions"><button class="btn btn-ghost" data-close>Cancel</button><button class="btn btn-danger" id="rsGo">${ic('restart')}Restore</button></div>`, (m, close) => {
          $('#rsGo', m).onclick = async () => {
            const includeConfig = $('#rsCfg', m).checked; close();
            try {
              if (running()) { toast('Stopping server…', 'info'); await post('/api/stop'); await waitOffline(); }
              await post('/api/backups/restore', { name, includeConfig });
            } catch (e) { toast(e.message, 'err'); }
          };
        });
      }
      async function saveCfg(patch) { try { cfg = (await post('/api/config', { config: { ...cfg, ...patch } })).config; toast('Saved'); draw(); } catch (e) { toast(e.message, 'err'); } }
      const load = () => Promise.all([api('/api/backups'), api('/api/config')]).then(([b, c]) => { list = b.backups; cfg = c.config; draw(); }).catch(e => toast(e.message, 'err'));
      draw(); load();
      on(k => { if (k === 'taskdone') load(); });
    },
  };

  function waitOffline(timeout = 120000) {
    return new Promise((res, rej) => {
      const t0 = Date.now();
      const iv = setInterval(() => { if (!running()) { clearInterval(iv); res(); } else if (Date.now() - t0 > timeout) { clearInterval(iv); rej(new Error('Server did not stop in time')); } }, 400);
    });
  }

  // ============================================================== WORLD
  pages.world = {
    title: 'World', sub: 'Download, replace or reset your world',
    render(view, on) {
      const draw = () => {
        const s = S.snap;
        view.innerHTML = `<div class="stack">
          <div class="grid g-3">
            <div class="card stat"><div class="eyebrow">${ic('globe')}World</div><div class="stat-value" style="font-size:22px">${esc(s.levelName)}</div><div class="muted small">${s.worldSize ? fmtBytes(s.worldSize) + ' on disk' : 'size is measured every minute'}</div></div>
            <div class="card"><div class="card-h"><h3>Download world</h3></div><p class="muted small" style="margin:0 0 12px">A .zip with the overworld, nether and end — open it in singleplayer or keep it safe.</p>
              <a class="btn btn-primary" href="/api/world/download" id="dlWorld">${ic('download')}Download .zip</a></div>
            <div class="card"><div class="card-h"><h3>Seed</h3></div><p class="muted small" style="margin:0 0 12px">${online() ? 'Asks the server for the world seed.' : 'Start the server to read the seed.'}</p>
              <button class="btn btn-ghost" id="seedBtn" ${online() ? '' : 'disabled'}>${ic('key')}Show seed in console</button></div>
          </div>
          <div class="card"><div class="card-h"><h2>Upload a world</h2><span class="sub">Replace the current world with a .zip (singleplayer saves work)</span></div>
            ${running() ? `<div class="banner warn"><div class="b-ico">${ic('info')}</div><div class="b-text"><b>Stop the server first</b><span>Worlds can only be swapped while the server is offline.</span></div></div>` : `
            <label class="dropzone" id="drop">${ic('upload')}<div><b>Drop a world .zip here</b> or click to choose</div><div class="dim small">Must contain a folder with level.dat. Your current world is backed up first.</div><input type="file" id="wFile" accept=".zip" hidden></label>`}
          </div>
          <div class="card" style="border-color:rgba(255,92,99,.25)"><div class="card-h"><h2 style="color:var(--redstone)">Reset world</h2><span class="sub">Generate a brand-new world</span></div>
            <div class="grid g-2">
              <div class="field"><label>New seed (optional)</label><input class="input mono" id="rsSeed" placeholder="leave empty for random"></div>
              <div class="field"><label>World type</label><select class="input" id="rsType">${['minecraft:normal', 'minecraft:flat', 'minecraft:large_biomes', 'minecraft:amplified'].map(t => `<option value="${t}">${titleCase(t)}</option>`).join('')}</select></div>
            </div>
            <div class="row" style="margin-top:14px"><button class="btn btn-danger" id="rsBtn" ${running() ? 'disabled' : ''}>${ic('trash')}Reset world</button><span class="dim small">${running() ? 'Stop the server first.' : 'A backup is made before anything is deleted.'}</span></div>
          </div></div>`;
        const sb = $('#seedBtn'); if (sb) sb.onclick = () => { cmd('seed', true); location.hash = '#/console'; };
        $('#dlWorld').onclick = () => toast('Preparing zip… the download starts in a moment.', 'info');
        const drop = $('#drop');
        if (drop) {
          const handle = f => { if (!f) return; if (!/\.zip$/i.test(f.name)) return toast('Please choose a .zip file', 'err'); upload(f); };
          $('#wFile').onchange = e => handle(e.target.files[0]);
          drop.ondragover = e => { e.preventDefault(); drop.classList.add('over'); };
          drop.ondragleave = () => drop.classList.remove('over');
          drop.ondrop = e => { e.preventDefault(); drop.classList.remove('over'); handle(e.dataTransfer.files[0]); };
        }
        $('#rsBtn').onclick = async () => {
          const v = await confirmBox({ title: 'Reset the world?', text: `Type <b class="mono">${esc(S.snap.levelName)}</b> to confirm. Everything built will be gone (a backup is kept).`, ok: 'Reset world', danger: true, input: { mustEqual: S.snap.levelName, placeholder: S.snap.levelName } });
          if (v) post('/api/world/reset', { seed: $('#rsSeed').value.trim(), levelType: $('#rsType').value }).catch(e => toast(e.message, 'err'));
        };
      };
      async function upload(f) {
        if (!(await confirmBox({ title: 'Replace the world?', text: `Upload <b>${esc(f.name)}</b> (${fmtBytes(f.size)}) and make it the server world? The current world is backed up first.`, ok: 'Upload & replace', danger: true }))) return;
        toast('Uploading… keep this tab open.', 'info', 5000);
        try { await api('/api/world/upload', { method: 'POST', raw: f }); } catch (e) { toast(e.message, 'err'); }
      }
      draw();
      on(k => { if (k === 'state' || k === 'taskdone') draw(); });
    },
  };

  // ============================================================== FILES
  pages.files = {
    title: 'Files', sub: 'Browse and edit everything in your server folder',
    render(view) {
      let cwd = store.get('filesCwd', ''), data = null;
      const TEXT = /\.(txt|json|properties|yml|yaml|toml|cfg|conf|log|mcmeta|mcfunction|md|csv|ini|bat|sh|js)$/i;
      const draw = () => {
        const parts = cwd ? cwd.split('/') : [];
        view.innerHTML = `<div class="card">
          <div class="card-h" style="flex-wrap:wrap"><div class="crumbs"><button data-p="">${ic('folder').replace('<svg ', '<svg width="15" height="15" style="vertical-align:-2px" ')} server</button>${parts.map((p, i) => `<span class="sep">/</span><button data-p="${esc(parts.slice(0, i + 1).join('/'))}">${esc(p)}</button>`).join('')}</div>
            <span class="spacer"></span>
            <button class="btn btn-ghost btn-sm" id="fNew">${ic('folderPlus')}New folder</button>
            <button class="btn btn-ghost btn-sm" id="fNewFile">${ic('file')}New file</button>
            <button class="btn btn-primary btn-sm" id="fUp">${ic('upload')}Upload</button><input type="file" id="fFile" multiple hidden></div>
          <div class="list">${!data ? '<div class="skeleton"></div>' : (cwd ? `<div class="list-row file-row dir" data-open="${esc(parts.slice(0, -1).join('/'))}" data-dir="1">${ic('folder', 'ft')}<div class="grow">..</div></div>` : '') + (data.entries.length ? data.entries.map(e => {
            const p = (cwd ? cwd + '/' : '') + e.name;
            return `<div class="list-row file-row ${e.dir ? 'dir' : ''}" data-open="${esc(p)}" ${e.dir ? 'data-dir="1"' : ''}>${ic(e.dir ? 'folder' : 'file', 'ft')}<div class="grow">${esc(e.name)}</div>
              <span class="sub" style="min-width:80px;text-align:right">${e.dir ? '' : fmtBytes(e.size)}</span><span class="sub" style="min-width:120px;text-align:right">${fmtDate(e.mtime)}</span>
              ${e.dir ? '<span style="width:34px"></span>' : `<a class="icon-btn" title="Download" data-stop href="/api/files/download?path=${encodeURIComponent(p)}">${ic('download')}</a>`}
              <button class="icon-btn danger" title="Delete" data-rm="${esc(p)}" data-stop>${ic('trash')}</button></div>`;
          }).join('') : `<div class="empty">${ic('folder')}<div>Empty folder</div></div>`)}</div></div>`;
        $$('[data-p]', view).forEach(b => b.onclick = () => go(b.dataset.p));
        $$('[data-open]', view).forEach(r => r.onclick = e => {
          if (e.target.closest('[data-stop]')) return;
          if (r.dataset.dir) go(r.dataset.open); else edit(r.dataset.open);
        });
        $$('[data-rm]', view).forEach(b => b.onclick = async () => {
          if (!(await confirmBox({ title: 'Delete?', text: `<b class="mono">${esc(b.dataset.rm)}</b> will be permanently deleted${running() ? ' (careful: the server is running)' : ''}.`, ok: 'Delete', danger: true }))) return;
          try { await api('/api/files?path=' + encodeURIComponent(b.dataset.rm), { method: 'DELETE' }); toast('Deleted'); load(); } catch (e) { toast(e.message, 'err'); }
        });
        $('#fNew').onclick = async () => { const n = await confirmBox({ title: 'New folder', ok: 'Create', input: { placeholder: 'folder name', required: true } }); if (n) post('/api/files/mkdir', { path: (cwd ? cwd + '/' : '') + n }).then(load).catch(e => toast(e.message, 'err')); };
        $('#fNewFile').onclick = async () => { const n = await confirmBox({ title: 'New file', ok: 'Create', input: { placeholder: 'notes.txt', required: true } }); if (n) post('/api/files/write', { path: (cwd ? cwd + '/' : '') + n, content: '' }).then(() => { load(); edit((cwd ? cwd + '/' : '') + n); }).catch(e => toast(e.message, 'err')); };
        $('#fUp').onclick = () => $('#fFile').click();
        $('#fFile').onchange = async e => {
          for (const f of e.target.files) {
            try { await api(`/api/files/upload?path=${encodeURIComponent(cwd)}&name=${encodeURIComponent(f.name)}`, { method: 'POST', raw: f }); toast('Uploaded ' + f.name); } catch (err) { toast(err.message, 'err'); }
          }
          load();
        };
      };
      function go(p) { cwd = p; store.set('filesCwd', cwd); data = null; draw(); load(); }
      async function edit(p) {
        if (!TEXT.test(p) && !(await confirmBox({ title: 'Open as text?', text: 'This file type may not be text.', ok: 'Open' }))) return;
        let content;
        try { content = (await api('/api/files/read?path=' + encodeURIComponent(p))).content; } catch (e) { return toast(e.message, 'err'); }
        modal(`<div class="row between" style="margin-bottom:10px"><h3 style="margin:0" class="mono">${esc(p)}</h3><span class="dim small">${running() && /server\.properties|ops\.json|whitelist\.json|banned/.test(p) ? 'Server may overwrite this while running' : ''}</span></div>
          <textarea class="input" id="edArea" spellcheck="false" style="height:60vh">${esc(content)}</textarea>
          <div class="modal-actions"><button class="btn btn-ghost" data-close>Close</button><button class="btn btn-primary" id="edSave">${ic('save')}Save</button></div>`, (m, close) => {
          const ta = $('#edArea', m);
          ta.onkeydown = e => { if ((e.ctrlKey || e.metaKey) && e.key === 's') { e.preventDefault(); $('#edSave', m).click(); } if (e.key === 'Tab') { e.preventDefault(); const s = ta.selectionStart; ta.setRangeText('  ', s, ta.selectionEnd, 'end'); } };
          $('#edSave', m).onclick = async () => {
            if (/\.json$/i.test(p)) { try { JSON.parse(ta.value); } catch (err) { return toast('Invalid JSON: ' + err.message, 'err', 6000); } }
            try { await post('/api/files/write', { path: p, content: ta.value }); toast('Saved ' + p); close(); load(); } catch (e) { toast(e.message, 'err'); }
          };
        }, true);
      }
      const load = () => api('/api/files?path=' + encodeURIComponent(cwd)).then(r => { data = r; draw(); }).catch(() => { if (cwd) go(''); });
      draw(); load();
    },
  };

  // ============================================================== LOGS
  pages.logs = {
    title: 'Logs', sub: 'Past server sessions (logs folder)',
    render(view) {
      let logs = null, sel = null, content = '', q = '';
      const draw = () => {
        let shown = content;
        if (q) shown = content.split('\n').filter(l => l.toLowerCase().includes(q)).join('\n');
        view.innerHTML = `<div class="grid" style="grid-template-columns:minmax(220px,280px) minmax(0,1fr)">
          <div class="card" style="padding:12px;max-height:calc(100vh - 170px);overflow:auto"><div class="list">${!logs ? '<div class="skeleton"></div>' : logs.length ? logs.map(l => `<div class="list-row file-row" data-l="${esc(l.name)}" style="${sel === l.name ? 'background:rgba(139,108,255,.14);border-radius:8px' : ''}">${ic('logs', 'ft')}<div class="grow"><b style="font-size:13px">${esc(l.name.replace(/\.log(\.gz)?$/, ''))}</b><div class="sub">${fmtBytes(l.size)}</div></div></div>`).join('') : '<div class="empty">No logs yet</div>'}</div></div>
          <div class="console" style="height:calc(100vh - 170px)"><div class="console-bar"><div class="lights"><i></i><i></i><i></i></div><b class="mono small">${esc(sel || 'Pick a log')}</b><span style="flex:1"></span>
            <input class="input" id="lgQ" placeholder="Filter lines…" style="width:220px;height:30px" value="${esc(q)}">${sel ? `<a class="icon-btn" title="Download" href="/api/files/download?path=${encodeURIComponent('logs/' + sel)}">${ic('download')}</a>` : ''}</div>
            <div class="console-body" id="lgBody">${sel ? shown.split('\n').slice(-5000).map(t => {
              const lvl = /\/(ERROR|FATAL)\]/.test(t) ? 'error' : /\/WARN\]/.test(t) ? 'warn' : / joined the game$/.test(t) ? 'join' : / left the game$/.test(t) ? 'leave' : /Done \(/.test(t) ? 'success' : /\]: <[^>]+> /.test(t) ? 'chat' : 'info';
              return `<div class="ln ${lvl}">${esc(t)}</div>`;
            }).join('') : '<div class="dim">Select a log file on the left.</div>'}</div></div></div>`;
        $$('[data-l]', view).forEach(r => r.onclick = () => open(r.dataset.l));
        const qi = $('#lgQ'); qi.oninput = () => { q = qi.value.toLowerCase(); const p = qi.selectionStart; draw(); const n = $('#lgQ'); n.focus(); n.setSelectionRange(p, p); };
        const b = $('#lgBody'); if (b && !q) b.scrollTop = b.scrollHeight;
      };
      async function open(name) { sel = name; content = ''; draw(); try { content = (await api('/api/logs/read?name=' + encodeURIComponent(name))).content; } catch (e) { toast(e.message, 'err'); } draw(); }
      api('/api/logs').then(r => { logs = r.logs; draw(); if (logs.length) open(logs[0].name); }).catch(e => toast(e.message, 'err'));
      draw();
    },
  };

  // ============================================================== SETTINGS (dashboard config)
  pages.settings = {
    title: 'Settings', sub: 'How Blockhost runs your server',
    render(view) {
      let cfg = null, java = null, dirty = false;
      const ramOpts = () => { const tot = S.stats && S.stats.memTotal ? Math.floor(S.stats.memTotal / 1073741824) : 16; const o = []; for (let g = 1; g <= Math.max(2, tot - 1); g++) o.push(g + 'G'); return o; };
      const draw = () => {
        if (!cfg) { view.innerHTML = '<div class="card"><div class="skeleton" style="width:30%"></div></div>'; return; }
        const sw = (k, label, hint) => `<div class="opt"><div class="opt-text"><b>${label}</b>${hint ? `<span>${hint}</span>` : ''}</div><label class="switch"><input type="checkbox" data-c="${k}" ${cfg[k] ? 'checked' : ''}><span></span></label></div>`;
        const ro = ramOpts();
        view.innerHTML = `<div class="stack">
          <div class="card"><div class="card-h">${ic('link').replace('<svg ', '<svg width="18" height="18" ')}<h2>Address & tunnel</h2></div>
            <div class="grid g-2">
              <div class="field"><label>Public address (from playit.gg)</label><input class="input mono" data-c="serverAddress" value="${esc(cfg.serverAddress)}" placeholder="something.tun.ply.gg:12345 or *.joinmc.link"><div class="hint">Shown on the Overview with a copy button. Copy it exactly from your playit dashboard.</div></div>
              <div class="field"><label>playit.exe location</label><input class="input mono" data-c="playitPath" value="${esc(cfg.playitPath)}" placeholder="auto-detect"><div class="hint">${S.snap.playit.path ? 'Found: ' + esc(S.snap.playit.path) : 'Not found automatically - paste the full path to playit.exe'}</div></div>
            </div>
            <div class="opt-grid" style="margin-top:14px">${sw('autoStartPlayit', 'Start playit.gg with the dashboard', 'Opens it in its own window')}</div></div>

          <div class="card"><div class="card-h">${ic('msg').replace('<svg ', '<svg width="18" height="18" ')}<h2>Welcome message</h2></div>
            <div class="opt-grid">${sw('welcomeEnabled', 'Greet players when they join', 'Shown in chat, only to that player')}${sw('welcomeFirstOnly', 'Only the first time they join')}</div>
            <div class="field" style="margin-top:12px"><label>Message</label><input class="input" data-c="welcomeText" value="${esc(cfg.welcomeText)}" maxlength="250"><div class="hint">Use {player} for their name and {address} for the server address.</div></div></div>

          <div class="card"><div class="card-h">${ic('key').replace('<svg ', '<svg width="18" height="18" ')}<h2>CurseForge library</h2></div>
            <div class="field"><label>CurseForge API key (free)</label><div class="input-group"><input class="input mono" type="password" data-c="curseforgeKey" id="cfKeyIn" value="${esc(cfg.curseforgeKey)}" placeholder="paste key here (starts with $2a$10$)"><button type="button" class="btn btn-ghost" id="cfTest">${ic('check')}Test key</button></div><div id="cfRes" class="small" style="margin-top:6px"></div><div class="hint">Adds CurseForge to the pack search and as a backup source. Get a free key: <a href="https://console.curseforge.com/" target="_blank" rel="noopener">console.curseforge.com</a> → sign in → API keys → copy. Modrinth works without a key.</div></div></div>

          <div class="card"><div class="card-h">${ic('memory').replace('<svg ', '<svg width="18" height="18" ')}<h2>Performance</h2></div>
            <div class="grid g-3">
              <div class="field"><label>Minimum RAM (-Xms)</label><select class="input" data-c="minRam">${ro.map(r => `<option ${cfg.minRam === r ? 'selected' : ''}>${r}</option>`).join('')}${ro.includes(cfg.minRam) ? '' : `<option selected>${esc(cfg.minRam)}</option>`}</select></div>
              <div class="field"><label>Maximum RAM (-Xmx)</label><select class="input" data-c="maxRam">${ro.map(r => `<option ${cfg.maxRam === r ? 'selected' : ''}>${r}</option>`).join('')}${ro.includes(cfg.maxRam) ? '' : `<option selected>${esc(cfg.maxRam)}</option>`}</select><div class="hint">4–6G is plenty for a vanilla server with friends. Leave RAM for Windows & playit.</div></div>
              <div class="field"><label>Java executable</label><select class="input" data-c="javaPath"><option value="">Auto (best match)</option>${java ? java.found.map(f => `<option value="${esc(f.path)}" ${cfg.javaPath === f.path ? 'selected' : ''}>Java ${f.major} — ${esc(f.path)}</option>`).join('') : ''}</select></div>
            </div>
            <div class="field" style="margin-top:14px"><label>JVM flags</label><textarea class="input" data-c="jvmFlags" rows="2">${esc(cfg.jvmFlags)}</textarea><div class="hint">Advanced. The defaults are safe G1GC flags that work on Java 21 and 25.</div></div></div>

          <div class="card"><div class="card-h">${ic('power').replace('<svg ', '<svg width="18" height="18" ')}<h2>Behaviour</h2></div>
            <div class="opt-grid">
              ${sw('autoRestart', 'Auto-restart after a crash', 'Up to 3 times in 10 minutes')}
              ${sw('autoStartServer', 'Start the server when the dashboard opens')}
              ${sw('checkUpdatesOnLaunch', 'Check Mojang for updates on launch')}
              ${sw('openBrowser', 'Open the browser automatically')}
              ${sw('useManagementApi', 'Use Minecraft management API', 'Live players & game rules (localhost only)')}
              <div class="opt"><div class="opt-text"><b>Management API port</b><span>localhost only</span></div><input class="input mono" type="number" data-c="rpcPort" value="${esc(cfg.rpcPort)}"></div>
              <div class="opt"><div class="opt-text"><b>Dashboard port</b><span>http://localhost:${esc(cfg.port)} - restart dashboard to apply</span></div><input class="input mono" type="number" data-c="port" value="${esc(cfg.port)}"></div>
            </div></div>

          <div class="card"><div class="card-h">${ic('folder').replace('<svg ', '<svg width="18" height="18" ')}<h2>About</h2></div>
            <div class="list"><div class="list-row"><div class="grow">Server folder</div><span class="sub">${esc(S.snap.serverDir)}</span></div>
            <div class="list-row"><div class="grow">Dashboard</div><span class="sub">Blockhost 1.0 · Node ${esc('local')}</span></div></div></div>
          <div class="savebar ${dirty ? '' : 'hidden'}" id="cfgBar"><span class="grow">Unsaved settings</span><button class="btn btn-ghost btn-sm" id="cfgDiscard">Discard</button><button class="btn btn-primary btn-sm" id="cfgSave">${ic('save')}Save</button></div>
        </div>`;
        $$('[data-c]', view).forEach(el => el.addEventListener(el.type === 'checkbox' ? 'change' : 'input', () => {
          const k = el.dataset.c;
          cfg[k] = el.type === 'checkbox' ? el.checked : (el.type === 'number' ? Number(el.value) : el.value);
          dirty = true; $('#cfgBar').classList.remove('hidden');
        }));
        const ct = $('#cfTest'); if (ct) ct.onclick = async () => {
          const out = $('#cfRes'); ct.disabled = true; out.innerHTML = '<span class="spinner"></span> Asking CurseForge…';
          try { const r = await post('/api/curseforge/test', { key: $('#cfKeyIn').value }); out.innerHTML = `<span style="color:var(--emerald)">${ic('check').replace('<svg ', '<svg width="12" height="12" ')} Key works (${esc(r.game || 'Minecraft')}).</span> ${dirty ? 'Press <b>Save</b> below.' : ''}`; }
          catch (e) { out.innerHTML = `<span style="color:var(--redstone)">${esc(e.message)}</span>`; }
          ct.disabled = false;
        };
        $('#cfgDiscard').onclick = () => { dirty = false; load(); };
        $('#cfgSave').onclick = async () => {
          if (parseInt(cfg.minRam, 10) * (/g/i.test(cfg.minRam) ? 1024 : 1) > parseInt(cfg.maxRam, 10) * (/g/i.test(cfg.maxRam) ? 1024 : 1)) return toast('Minimum RAM cannot be larger than maximum RAM', 'err');
          try { cfg = (await post('/api/config', { config: cfg })).config; dirty = false; draw(); restartPrompt('Settings saved'); } catch (e) { toast(e.message, 'err'); }
        };
      };
      const load = () => Promise.all([api('/api/config'), api('/api/java')]).then(([c, j]) => { cfg = c.config; java = j; draw(); }).catch(e => toast(e.message, 'err'));
      draw(); load();
    },
  };

})();
