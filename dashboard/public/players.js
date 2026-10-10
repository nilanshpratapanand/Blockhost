/* Blockhost dashboard — Players page (v1.2): live list, bulk actions, teleport to/from you, kits, effects, inspect */
(() => {
  'use strict';
  const { $, $$, esc, ic, api, post, cmd, toast, modal, confirmBox, fmtDur, titleCase, avatar, store, S, pages } = window.BH;
  const online = () => S.snap && S.snap.state === 'online';
  const safeName = n => /^[\w.\-]{1,16}$/.test(n);

  const MODES = [['survival', 'S', 'heart'], ['creative', 'C', 'sparkle'], ['adventure', 'A', 'pin'], ['spectator', 'SP', 'globe']];
  const EFFECTS = [
    ['speed', 'Speed', 'bolt'], ['haste', 'Haste', 'sparkle'], ['jump_boost', 'Jump boost', 'upload'], ['night_vision', 'Night vision', 'moon'],
    ['invisibility', 'Invisible', 'x'], ['regeneration', 'Regeneration', 'heart'], ['resistance', 'Resistance', 'shield'], ['fire_resistance', 'Fire resistance', 'sun'],
    ['water_breathing', 'Water breathing', 'rain'], ['strength', 'Strength', 'crown'], ['slow_falling', 'Slow falling', 'download'], ['glowing', 'Glowing', 'sparkle'],
  ];
  const KITS = {
    starter: { label: 'Starter', icon: 'box', items: [['stone_sword', 1], ['stone_pickaxe', 1], ['stone_axe', 1], ['bread', 16], ['torch', 32], ['oak_log', 32]] },
    diamond: { label: 'Diamond', icon: 'sparkle', items: [['diamond_sword', 1], ['diamond_pickaxe', 1], ['diamond_axe', 1], ['diamond_helmet', 1], ['diamond_chestplate', 1], ['diamond_leggings', 1], ['diamond_boots', 1], ['golden_apple', 8], ['cooked_beef', 32]] },
    netherite: { label: 'Netherite', icon: 'crown', items: [['netherite_sword', 1], ['netherite_pickaxe', 1], ['netherite_helmet', 1], ['netherite_chestplate', 1], ['netherite_leggings', 1], ['netherite_boots', 1], ['enchanted_golden_apple', 4], ['totem_of_undying', 2]] },
    builder: { label: 'Builder', icon: 'box', items: [['stone_bricks', 256], ['oak_planks', 256], ['glass', 128], ['oak_log', 64], ['torch', 64], ['lantern', 16]] },
    food: { label: 'Food', icon: 'food', items: [['cooked_beef', 64], ['golden_carrot', 32], ['bread', 32]] },
    travel: { label: 'Travel', icon: 'pin', items: [['elytra', 1], ['firework_rocket', 64], ['ender_pearl', 16], ['compass', 1], ['map', 1]] },
  };
  // Fun actions: each returns the console commands to run for target t (a name or @a)
  const FW = '{LifeTime:20,FireworksItem:{id:"minecraft:firework_rocket",count:1,components:{"minecraft:fireworks":{flight_duration:1,explosions:[{shape:"large_ball",colors:[I;16711680,16776960,65535,16711935],has_twinkle:true,has_trail:true}]}}}}';
  const FUN = {
    smite: { l: 'Lightning', i: 'bolt', c: t => [`execute at ${t} run summon minecraft:lightning_bolt ~ ~ ~`] },
    fireworks: { l: 'Fireworks', i: 'sparkle', c: t => [`execute at ${t} run summon minecraft:firework_rocket ~ ~1 ~ ${FW}`, `execute at ${t} run summon minecraft:firework_rocket ~2 ~1 ~ ${FW}`, `execute at ${t} run summon minecraft:firework_rocket ~-2 ~1 ~ ${FW}`] },
    launch: { l: 'Launch up', i: 'upload', c: t => [`effect give ${t} minecraft:levitation 2 8 true`] },
    skydrop: { l: 'Sky drop (safe)', i: 'download', c: t => [`effect give ${t} minecraft:slow_falling 20 0 true`, `execute as ${t} at @s run tp @s ~ ~40 ~`] },
    tiny: { l: 'Make tiny', i: 'download', c: t => [`attribute ${t} minecraft:scale base set 0.35`] },
    giant: { l: 'Make giant', i: 'upload', c: t => [`attribute ${t} minecraft:scale base set 2.5`] },
    normal: { l: 'Normal size', i: 'restart', c: t => [`attribute ${t} minecraft:scale base reset`] },
    superjump: { l: 'Super jump', i: 'upload', c: t => [`effect give ${t} minecraft:jump_boost 30 4 true`] },
    zoom: { l: 'Zoomies', i: 'bolt', c: t => [`effect give ${t} minecraft:speed 30 5 true`] },
    drunk: { l: 'Dizzy', i: 'restart', c: t => [`effect give ${t} minecraft:nausea 15 0 true`] },
    freeze: { l: 'Freeze 8s', i: 'shield', c: t => [`effect give ${t} minecraft:slowness 8 255 true`, `effect give ${t} minecraft:mining_fatigue 8 255 true`] },
    dark: { l: 'Spooky dark', i: 'moon', c: t => [`effect give ${t} minecraft:darkness 8 0 true`, `execute at ${t} run playsound minecraft:entity.warden.heartbeat hostile ${t} ~ ~ ~ 1 1`] },
    scare: { l: 'Creeper hiss', i: 'skull', c: t => [`execute at ${t} run playsound minecraft:entity.creeper.primed hostile ${t} ~ ~ ~ 1 1`] },
    roar: { l: 'Dragon roar', i: 'megaphone', c: t => [`execute at ${t} run playsound minecraft:entity.ender_dragon.growl master ${t} ~ ~ ~ 1 1`] },
    chickens: { l: 'Chicken rain', i: 'food', c: t => Array.from({ length: 8 }, (_, i) => `execute at ${t} run summon minecraft:chicken ~${(i % 3) - 1} ~6 ~${Math.floor(i / 3) - 1}`) },
    cat: { l: 'Spawn a cat', i: 'heart', c: t => [`execute at ${t} run summon minecraft:cat ~1 ~ ~`] },
    cake: { l: 'Party cake', i: 'gift', c: t => [`give ${t} minecraft:cake 1`, `execute at ${t} run playsound minecraft:entity.player.levelup master ${t} ~ ~ ~ 1 1`] },
    glow: { l: 'Glow', i: 'sun', c: t => [`effect give ${t} minecraft:glowing 60 0 true`] },
  };
  const ITEMS = ['diamond', 'netherite_ingot', 'iron_ingot', 'golden_apple', 'enchanted_golden_apple', 'totem_of_undying', 'elytra', 'ender_pearl', 'experience_bottle', 'cooked_beef', 'torch', 'oak_log', 'shulker_box', 'beacon', 'trident', 'mending_book'];

  window.BH.FUN = FUN;
  pages.players = {
    title: 'Players', sub: 'Everyone online — teleport, change game mode, give items and more',
    render(view, on) {
      let lists = { ops: [], whitelist: [], bans: [], ipbans: [], known: [] };
      let tab = store.get('playerTab', 'ops');
      const sel = new Set();
      const info = S.playerInfo || (S.playerInfo = {});
      const isOp = n => lists.ops.some(o => o.name.toLowerCase() === n.toLowerCase());
      const me = () => S.snap.myName;

      view.innerHTML = `<div class="stack"><div id="plHead"></div><div id="plBulk"></div><div id="plOnline"></div><div class="card" id="plLists"></div></div>`;

      // ---------------------------------------------------------------- "me"
      async function ensureMe() {
        if (me()) return me();
        const names = S.snap.players.map(p => p.name);
        return new Promise(resolve => {
          modal(`<h3>What's your Minecraft name?</h3><p>Used for “Teleport to me” and “Go to them”. Saved for next time.</p>
            ${names.length ? `<div class="chips" style="margin-bottom:12px">${names.map(n => `<button class="chip" data-me="${esc(n)}">${esc(n)}</button>`).join('')}</div>` : ''}
            <input class="input" id="meIn" placeholder="your in-game name">
            <div class="modal-actions"><button class="btn btn-ghost" data-close>Cancel</button><button class="btn btn-primary" id="meOk">Save</button></div>`, (m, close) => {
            $$('[data-me]', m).forEach(b => b.onclick = () => { $('#meIn', m).value = b.dataset.me; });
            $('#meOk', m).onclick = async () => {
              const v = $('#meIn', m).value.trim(); if (!v) return;
              try { await post('/api/config', { config: { myName: v } }); S.snap.myName = v; close(); drawHead(); resolve(v); } catch (e) { toast(e.message, 'err'); }
            };
          });
        });
      }

      // ---------------------------------------------------------------- actions
      const T = targets => targets.length === 1 ? targets[0] : targets.length === S.snap.players.length ? '@a' : null;
      async function run(targets, fn) {
        // run a command for each target (or @a when everyone is selected)
        const all = T(targets);
        if (all) return fn(all);
        for (const t of targets) await fn(t, true);
        toast(`Done for ${targets.length} players`);
      }

      async function act(a, targets, extra) {
        if (!online()) return toast('Server is offline', 'err');
        const many = targets.length > 1;
        const one = targets[0];
        if (FUN[a]) { await run(targets, async (t, q) => { for (const c of FUN[a].c(t)) await cmd(c, true); if (!q) toast(`${FUN[a].l}: ${t === '@a' ? 'everyone' : t}`); }); return; }
        switch (a) {
          case 'survival': case 'creative': case 'adventure': case 'spectator':
            await run(targets, (t, q) => cmd(`gamemode ${a} ${t}`, q));
            targets.forEach(t => { if (info[t]) info[t].gamemode = a; }); drawOnline(); break;
          case 'tpme': { const m = await ensureMe(); if (!m) return; await run(targets.filter(t => t !== m), (t, q) => cmd(`tp ${t} ${m}`, q)); break; }
          case 'goto': { const m = await ensureMe(); if (!m) return; cmd(`tp ${m} ${one}`); break; }
          case 'tp': tpModal(one); break;
          case 'heal': await run(targets, (t, q) => cmd(`effect give ${t} minecraft:instant_health 1 5 true`, q)); break;
          case 'feed': await run(targets, (t, q) => cmd(`effect give ${t} minecraft:saturation 1 20 true`, q)); break;
          case 'give': giveModal(targets); break;
          case 'effects': effectsModal(targets); break;
          case 'inspect': inspectModal(one); break;
          case 'more': moreModal(one); break;
          case 'op': await cmd(isOp(one) ? `deop ${one}` : `op ${one}`); setTimeout(load, 700); break;
          case 'msg': { const v = await confirmBox({ title: many ? `Message ${targets.length} players` : `Message ${one}`, ok: 'Send', input: { placeholder: 'Hey!', required: true } }); if (v) await run(targets, (t, q) => cmd(`tell ${t} ${v}`, q)); break; }
          case 'title': { const v = await confirmBox({ title: 'Show big text on screen', text: 'Appears in the middle of their screen for a few seconds.', ok: 'Show', input: { placeholder: 'Welcome!', required: true } }); if (v) await run(targets, (t, q) => cmd(`title ${t} title ${JSON.stringify({ text: v, color: 'gold' })}`, q)); break; }
          case 'xp': { const v = await confirmBox({ title: 'Give XP levels', ok: 'Give', input: { label: 'Levels', value: '10', required: true } }); if (v && /^-?\d+$/.test(v)) await run(targets, (t, q) => cmd(`xp add ${t} ${v} levels`, q)); break; }
          case 'xpreset': await run(targets, (t, q) => cmd(`xp set ${t} 0 levels`, q)); break;
          case 'spawnpoint': await run(targets, (t, q) => cmd(`spawnpoint ${t}`, q)); toast('Respawn point set where they stand'); break;
          case 'worldspawn': cmd(`execute at ${one} run setworldspawn ~ ~ ~`); break;
          case 'clearfx': await run(targets, (t, q) => cmd(`effect clear ${t}`, q)); break;
          case 'fun': funModal(targets); break;
          case 'clear': if (await confirmBox({ title: `Clear inventory of ${many ? targets.length + ' players' : one}?`, text: 'All their items are deleted. This cannot be undone.', ok: 'Clear', danger: true })) await run(targets, (t, q) => cmd(`clear ${t}`, q)); break;
          case 'kill': if (await confirmBox({ title: `Kill ${many ? targets.length + ' players' : one}?`, text: 'They respawn and drop their items (unless keep inventory is on).', ok: 'Kill', danger: true })) await run(targets, (t, q) => cmd(`kill ${t}`, q)); break;
          case 'kick': { const v = await confirmBox({ title: `Kick ${many ? targets.length + ' players' : one}?`, text: 'They can rejoin right away.', ok: 'Kick', danger: true, input: { label: 'Reason (optional)', placeholder: 'Kicked by an operator' } }); if (v !== false) for (const t of targets) await cmd(`kick ${t}${v && v !== true ? ' ' + v : ''}`, many); break; }
          case 'ban': { const v = await confirmBox({ title: `Ban ${many ? targets.length + ' players' : one}?`, text: 'They cannot join until unbanned (Banned tab).', ok: 'Ban', danger: true, input: { label: 'Reason (optional)', placeholder: 'Griefing' } }); if (v !== false) { for (const t of targets) await cmd(`ban ${t}${v && v !== true ? ' ' + v : ''}`, many); setTimeout(load, 700); } break; }
        }
      }

      function tpModal(n) {
        const others = S.snap.players.filter(p => p.name !== n);
        modal(`<h3>Teleport ${esc(n)}</h3>
          <div class="grid g-2" style="margin-bottom:14px"><button class="btn btn-primary" data-q="tpme">${ic('download')}Bring to me</button><button class="btn btn-ghost" data-q="goto">${ic('upload')}Send me to them</button></div>
          ${others.length ? `<div class="field"><label>Send ${esc(n)} to…</label><div class="row">${others.map(p => `<button class="btn btn-ghost btn-sm" data-to="${esc(p.name)}">${esc(p.name)}</button>`).join('')}</div></div>
          <div class="field" style="margin-top:12px"><label>Bring someone to ${esc(n)}</label><div class="row">${others.map(p => `<button class="btn btn-ghost btn-sm" data-from="${esc(p.name)}">${esc(p.name)} → ${esc(n)}</button>`).join('')}</div></div>` : ''}
          <div class="field" style="margin-top:12px"><label>To coordinates (x y z)</label><div class="input-group"><input class="input mono" id="tpXYZ" placeholder="0 80 0"><button class="btn btn-primary" id="tpGo">Go</button></div></div>
          <div class="field" style="margin-top:12px"><label>Other dimension</label><div class="row">
            <button class="btn btn-ghost btn-sm" data-dim="overworld">${ic('globe')}Overworld</button><button class="btn btn-ghost btn-sm" data-dim="the_nether">${ic('sun')}Nether</button><button class="btn btn-ghost btn-sm" data-dim="the_end">${ic('moon')}The End</button></div>
            <div class="hint">Keeps their x/z (Nether is scaled ÷8 automatically by the game only via portals, so you may land underground - they get Slow Falling for safety).</div></div>
          <div class="modal-actions"><button class="btn btn-ghost" data-close>Close</button></div>`, (m, close) => {
          $$('[data-q]', m).forEach(b => b.onclick = () => { close(); act(b.dataset.q, [n]); });
          $$('[data-to]', m).forEach(b => b.onclick = () => { cmd(`tp ${n} ${b.dataset.to}`); close(); });
          $$('[data-from]', m).forEach(b => b.onclick = () => { cmd(`tp ${b.dataset.from} ${n}`); close(); });
          $$('[data-dim]', m).forEach(b => b.onclick = async () => {
            await cmd(`effect give ${n} minecraft:slow_falling 20 0 true`, true);
            cmd(`execute in minecraft:${b.dataset.dim} run tp ${n} ~ ${b.dataset.dim === 'the_end' ? 100 : 120} ~`); close();
          });
          $('#tpGo', m).onclick = () => { const v = $('#tpXYZ', m).value.trim(); if (/^(~?-?[\d.]*\s+){2}~?-?[\d.]*$/.test(v)) { cmd(`tp ${n} ${v}`); close(); } else toast('Use three numbers like: 100 70 -250', 'err'); };
        });
      }

      function giveModal(targets) {
        modal(`<h3>Give to ${targets.length > 1 ? targets.length + ' players' : esc(targets[0])}</h3><p>One-click kits, or any single item.</p>
          <div class="kit-grid">${Object.entries(KITS).map(([k, v]) => `<button class="choice" data-kit="${k}">${ic(v.icon)}<b>${v.label} kit</b><span>${v.items.length} items</span></button>`).join('')}</div>
          <div class="field" style="margin-top:16px"><label>Single item</label>
            <div class="chips" style="margin-bottom:10px">${ITEMS.map(i => `<button class="chip" data-i="${i}">${i.replace(/_/g, ' ')}</button>`).join('')}</div>
            <div class="input-group"><input class="input mono" id="gItem" placeholder="minecraft:diamond"><input class="input mono" id="gCount" type="number" min="1" max="6400" value="1" style="max-width:90px"><button class="btn btn-primary" id="gGo">${ic('gift')}Give</button></div></div>
          <div class="modal-actions"><button class="btn btn-ghost" data-close>Close</button></div>`, (m, close) => {
          $$('[data-kit]', m).forEach(b => b.onclick = async () => {
            const kit = KITS[b.dataset.kit]; close();
            for (const t of targets) for (const [it, c] of kit.items) await cmd(`give ${t} minecraft:${it} ${c}`, true);
            toast(`${kit.label} kit given`);
          });
          $$('[data-i]', m).forEach(b => b.onclick = () => { $('#gItem', m).value = b.dataset.i === 'mending_book' ? 'minecraft:enchanted_book[stored_enchantments={"minecraft:mending":1}]' : 'minecraft:' + b.dataset.i; $$('[data-i]', m).forEach(x => x.classList.toggle('on', x === b)); });
          $('#gGo', m).onclick = async () => {
            let it = $('#gItem', m).value.trim().replace(/\s+/g, '_'); const c = Math.max(1, Math.min(6400, parseInt($('#gCount', m).value, 10) || 1));
            if (!/^[\w:.\-]+(\[.*\]|\{.*\})?$/.test(it)) return toast('Enter an item ID like minecraft:diamond', 'err');
            if (!it.includes(':')) it = 'minecraft:' + it;
            close(); for (const t of targets) await cmd(`give ${t} ${it} ${c}`, targets.length > 1);
          };
        });
      }

      function funModal(targets) {
        modal(`<h3>Fun for ${targets.length > 1 ? targets.length + ' players' : esc(targets[0])}</h3><p>Harmless pranks and party tricks. Size changes last until you press “Normal size”.</p>
          <div class="fx-grid">${Object.entries(FUN).map(([k, f]) => `<button class="pa" data-f="${k}">${ic(f.i)}${f.l}</button>`).join('')}</div>
          <div class="modal-actions"><button class="btn btn-ghost" data-close>Done</button></div>`, m => {
          $$('[data-f]', m).forEach(b => b.onclick = () => act(b.dataset.f, targets));
        });
      }

      function effectsModal(targets) {
        modal(`<h3>Effects for ${targets.length > 1 ? targets.length + ' players' : esc(targets[0])}</h3><p>Pick a duration, then tap effects.</p>
          <div class="row" style="margin-bottom:12px"><span class="muted small">Duration</span><div class="seg" id="fxDur">${[['30', '30s'], ['300', '5 min'], ['1800', '30 min'], ['infinite', 'Forever']].map(([v, l], i) => `<button data-d="${v}" class="${i === 1 ? 'on' : ''}">${l}</button>`).join('')}</div>
            <span class="muted small">Level</span><div class="seg" id="fxLvl">${[0, 1, 2, 4].map((v, i) => `<button data-l="${v}" class="${i === 0 ? 'on' : ''}">${v + 1}</button>`).join('')}</div></div>
          <div class="fx-grid">${EFFECTS.map(([id, l, i]) => `<button class="pa" data-fx="${id}">${ic(i)}${l}</button>`).join('')}</div>
          <div class="modal-actions"><button class="btn btn-ghost" id="fxClear">${ic('x')}Remove all effects</button><button class="btn btn-ghost" data-close>Done</button></div>`, m => {
          let dur = '300', lvl = '0';
          $$('#fxDur button', m).forEach(b => b.onclick = () => { dur = b.dataset.d; $$('#fxDur button', m).forEach(x => x.classList.toggle('on', x === b)); });
          $$('#fxLvl button', m).forEach(b => b.onclick = () => { lvl = b.dataset.l; $$('#fxLvl button', m).forEach(x => x.classList.toggle('on', x === b)); });
          $$('[data-fx]', m).forEach(b => b.onclick = () => run(targets, (t, q) => cmd(`effect give ${t} minecraft:${b.dataset.fx} ${dur} ${lvl} true`, q)));
          $('#fxClear', m).onclick = () => run(targets, (t, q) => cmd(`effect clear ${t}`, q));
        });
      }

      async function inspectModal(n) {
        const close = modal(`<h3>${esc(n)}</h3><div id="insBody"><div class="empty"><div class="spinner"></div>Reading player data…</div></div><div class="modal-actions"><button class="btn btn-ghost" data-close>Close</button></div>`);
        void close;
        try {
          const d = await api('/api/players/inspect?name=' + encodeURIComponent(n)); info[n] = d; drawOnline();
          const b = $('#insBody'); if (!b) return;
          b.innerHTML = `<div class="ins-grid">
            <div class="ins"><span>Health</span><b>${d.health ?? '?'} / 20</b><div class="meter"><i style="width:${(d.health || 0) * 5}%;background:linear-gradient(90deg,#ff5c63,#ff8a8f)"></i></div></div>
            <div class="ins"><span>Food</span><b>${d.food ?? '?'} / 20</b><div class="meter"><i style="width:${(d.food || 0) * 5}%;background:linear-gradient(90deg,#e88a5a,#f6c453)"></i></div></div>
            <div class="ins"><span>XP level</span><b>${d.xp ?? '?'}</b></div>
            <div class="ins"><span>Game mode</span><b>${titleCase(d.gamemode || '?')}</b></div>
            <div class="ins"><span>Dimension</span><b>${titleCase(d.dimension || '?')}</b></div>
            <div class="ins"><span>Position</span><b class="mono">${d.pos ? d.pos.join(' ') : '?'}</b>${d.pos ? `<button class="btn btn-ghost btn-sm" id="cpPos">${ic('copy')}Copy</button>` : ''}</div></div>`;
          const cp = $('#cpPos'); if (cp) cp.onclick = () => window.BH.copyText(d.pos.join(' '));
        } catch (e) { const b = $('#insBody'); if (b) b.innerHTML = `<div class="empty">${ic('alert')}<div>${esc(e.message)}</div></div>`; }
      }

      function moreModal(n) {
        const G = [
          ['Teleport', [['tpme', 'Bring to me', 'download'], ['goto', 'Go to them', 'upload'], ['tp', 'Teleport…', 'pin']]],
          ['Help them', [['heal', 'Heal', 'heart'], ['feed', 'Feed', 'food'], ['give', 'Give / kits', 'gift'], ['effects', 'Effects', 'sparkle'], ['xp', 'Give XP', 'sparkle'], ['spawnpoint', 'Set respawn here', 'pin']]],
          ['Talk', [['msg', 'Private message', 'msg'], ['title', 'Big screen text', 'megaphone']]],
          ['World', [['worldspawn', 'Make world spawn here', 'globe'], ['inspect', 'Inspect (hp, pos…)', 'search']]],
          ['Fun', Object.entries(FUN).map(([k, f]) => [k, f.l, f.i])],
          ['Moderation', [['op', isOp(n) ? 'Remove op' : 'Make op', 'crown'], ['xpreset', 'Reset XP', 'restart'], ['clearfx', 'Clear effects', 'x'], ['clear', 'Clear inventory', 'eraser'], ['kill', 'Kill', 'skull'], ['kick', 'Kick', 'kick'], ['ban', 'Ban', 'ban']]],
        ];
        modal(`<div class="row" style="margin-bottom:12px">${avatar(n)}<div><h3 style="margin:0">${esc(n)}</h3><div class="muted small">All actions</div></div></div>
          <div class="field"><label>Game mode</label><div class="gm-seg big">${MODES.map(([mo, s, i]) => `<button data-a="${mo}" class="${info[n] && info[n].gamemode === mo ? 'on' : ''}">${ic(i)}${titleCase(mo)}</button>`).join('')}</div></div>
          ${G.map(([g, items]) => `<div class="field" style="margin-top:14px"><label>${g}</label><div class="more-grid">${items.map(([a, l, i]) => `<button class="pa ${['clear', 'kill', 'kick', 'ban'].includes(a) ? 'danger' : ''}" data-a="${a}">${ic(i)}${l}</button>`).join('')}</div></div>`).join('')}
          <div class="modal-actions"><button class="btn btn-ghost" data-close>Close</button></div>`, (m, close) => {
          $$('[data-a]', m).forEach(b => b.onclick = () => { const a = b.dataset.a; if (!MODES.some(x => x[0] === a)) close(); else { $$('.gm-seg button', m).forEach(x => x.classList.toggle('on', x === b)); } act(a, [n]); });
        });
      }

      // ---------------------------------------------------------------- drawing
      const drawHead = () => {
        const count = S.snap.onlineCount ?? S.snap.players.length;
        $('#plHead').innerHTML = `<div class="row between">
          <div class="row"><h2 style="margin:0;font-size:18px">Online now</h2><span class="tag ${count ? 'green' : ''}">${count} / ${S.snap.maxPlayers}</span>
            ${count > S.snap.players.length ? `<span class="tag gold">${count - S.snap.players.length} hidden from list</span>` : ''}</div>
          <div class="row">
            <button class="btn btn-ghost btn-sm" id="meBtn">${ic('users')}You: <b>${esc(me() || 'not set')}</b></button>
            ${S.snap.players.length > 1 ? `<button class="btn btn-ghost btn-sm" id="selAll">${ic('check')}${sel.size === S.snap.players.length ? 'Clear selection' : 'Select all'}</button>` : ''}
            ${online() ? `<button class="btn btn-ghost btn-sm" id="plRefresh">${ic('restart')}Refresh</button>` : ''}</div></div>`;
        $('#meBtn').onclick = async () => { S.snap.myName = ''; await ensureMe(); };
        const sa = $('#selAll'); if (sa) sa.onclick = () => { if (sel.size === S.snap.players.length) sel.clear(); else S.snap.players.forEach(p => sel.add(p.name)); drawAll(); };
        const rf = $('#plRefresh'); if (rf) rf.onclick = () => { refreshInfo(true); cmd('list', true); };
      };

      const drawBulk = () => {
        [...sel].forEach(n => { if (!S.snap.players.some(p => p.name === n)) sel.delete(n); });
        const n = sel.size;
        $('#plBulk').innerHTML = n ? `<div class="bulk"><b>${n} selected</b>
          <div class="gm-seg">${MODES.map(([m, s]) => `<button data-b="${m}" title="${titleCase(m)}">${s}</button>`).join('')}</div>
          <button class="btn btn-ghost btn-sm" data-b="tpme">${ic('download')}TP to me</button>
          <button class="btn btn-ghost btn-sm" data-b="heal">${ic('heart')}Heal</button>
          <button class="btn btn-ghost btn-sm" data-b="feed">${ic('food')}Feed</button>
          <button class="btn btn-ghost btn-sm" data-b="give">${ic('gift')}Give</button>
          <button class="btn btn-ghost btn-sm" data-b="effects">${ic('sparkle')}Effects</button>
          <button class="btn btn-ghost btn-sm" data-b="fun">${ic('bolt')}Fun</button>
          <button class="btn btn-ghost btn-sm" data-b="msg">${ic('msg')}Message</button>
          <button class="btn btn-ghost btn-sm" data-b="kick">${ic('kick')}Kick</button>
          <button class="icon-btn" id="bulkX" title="Clear">${ic('x')}</button></div>` : '';
        $$('[data-b]', $('#plBulk')).forEach(b => b.onclick = () => act(b.dataset.b, [...sel]));
        const x = $('#bulkX'); if (x) x.onclick = () => { sel.clear(); drawAll(); };
      };

      const drawOnline = () => {
        const ps = S.snap.players;
        const count = S.snap.onlineCount ?? ps.length;
        $('#plOnline').innerHTML = ps.length ? `<div class="player-grid">${ps.map(p => {
          const d = info[p.name] || {};
          const ok = safeName(p.name);
          return `<div class="card player ${sel.has(p.name) ? 'selected' : ''}" data-n="${esc(p.name)}">
            <div class="player-top">
              <label class="pick" title="Select"><input type="checkbox" ${sel.has(p.name) ? 'checked' : ''}><span>${ic('check')}</span></label>
              ${avatar(p.name)}
              <div style="min-width:0;flex:1"><div class="player-name">${esc(p.name)}${isOp(p.name) ? ic('crown') : ''}${p.name === me() ? '<span class="tag purple" style="margin-left:4px">you</span>' : ''}</div>
                <div class="muted small">${p.joinedAt ? 'online ' + fmtDur(Date.now() - p.joinedAt) : ''}${d.dimension ? ' · ' + titleCase(d.dimension) : ''}${d.pos ? ' · <span class="mono">' + d.pos.join(' ') + '</span>' : ''}</div></div>
              <button class="icon-btn" data-a="more" title="All actions">${ic('menu')}</button>
            </div>
            ${d.health != null ? `<div class="vitals"><span title="Health">${ic('heart')}<i class="bar"><i style="width:${d.health * 5}%;background:#ff5c63"></i></i></span><span title="Food">${ic('food')}<i class="bar"><i style="width:${(d.food || 0) * 5}%;background:#f6c453"></i></i></span><span class="tag">${ic('sparkle')}lvl ${d.xp ?? 0}</span></div>` : ''}
            ${ok ? `<div class="gm-seg">${MODES.map(([m, s, i]) => `<button data-a="${m}" class="${d.gamemode === m ? 'on' : ''}" title="${titleCase(m)}">${ic(i)}${titleCase(m)}</button>`).join('')}</div>
            <div class="player-actions">
              <button class="pa good" data-a="tpme">${ic('download')}TP to me</button>
              <button class="pa" data-a="goto">${ic('upload')}Go to them</button>
              <button class="pa good" data-a="heal">${ic('heart')}Heal</button>
              <button class="pa good" data-a="feed">${ic('food')}Feed</button>
              <button class="pa" data-a="give">${ic('gift')}Give</button>
              <button class="pa" data-a="effects">${ic('sparkle')}Effects</button>
              <button class="pa" data-a="fun">${ic('sparkle')}Fun</button>
              <button class="pa" data-a="more">${ic('menu')}More</button>
            </div>` : `<div class="dim small">This name has characters that commands can't target. Use Kick/Ban from the lists below.</div>`}
          </div>`;
        }).join('')}</div>`
          : count ? `<div class="card empty">${ic('users')}<div><b>${count} player${count > 1 ? 's' : ''} online</b> but their names are hidden (they turned off “Allow server listings”). Click Refresh to load names from the console.</div></div>`
            : `<div class="card empty">${ic('users')}<div>${online() ? 'No one is online right now.' : S.snap.external ? 'The server is running outside Blockhost — see the Overview.' : 'The server is offline.'}</div>${S.snap.address ? `<div class="small">Friends join with <b class="mono">${esc(S.snap.address)}</b></div>` : ''}</div>`;
        $$('.player', view).forEach(card => {
          const n = card.dataset.n;
          $$('[data-a]', card).forEach(b => b.onclick = () => act(b.dataset.a, [n]));
          const pk = $('.pick input', card); pk.onchange = () => { pk.checked ? sel.add(n) : sel.delete(n); card.classList.toggle('selected', pk.checked); drawBulk(); drawHead(); };
        });
      };

      const TABS = [['ops', 'Operators', 'crown'], ['whitelist', 'Whitelist', 'check'], ['bans', 'Banned', 'ban'], ['ipbans', 'Banned IPs', 'shield'], ['known', 'All players', 'users']];
      const drawLists = () => {
        const L = lists[tab] || [];
        const addable = tab !== 'known';
        $('#plLists').innerHTML = `
          <div class="tabs">${TABS.map(([k, l]) => `<button class="${tab === k ? 'on' : ''}" data-t="${k}">${l}<span class="count">${(lists[k] || []).length}</span></button>`).join('')}</div>
          ${tab === 'whitelist' ? `<div class="row between" style="margin-bottom:14px"><div><b>Whitelist is ${S.snap.whitelist ? 'ON' : 'OFF'}</b><div class="muted small">${S.snap.whitelist ? 'Only players on this list can join.' : 'Anyone with the address can join.'}</div></div><label class="switch"><input type="checkbox" id="wlToggle" ${S.snap.whitelist ? 'checked' : ''}><span></span></label></div>` : ''}
          ${addable ? `<form class="input-group" id="lAdd" style="margin-bottom:10px"><input class="input" id="lName" placeholder="${tab === 'ipbans' ? 'IP address' : 'Player name'}" autocomplete="off">${tab === 'bans' || tab === 'ipbans' ? '<input class="input" id="lReason" placeholder="Reason (optional)">' : ''}<button class="btn btn-primary">${ic('plus')}Add</button></form>` : ''}
          <div class="list">${L.length ? L.map(e => {
            const name = e.name || e.ip;
            const sub = tab === 'ops' ? `level ${e.level}` : (tab === 'bans' || tab === 'ipbans') ? `${esc(e.reason || '')} · ${esc(e.created || '')}` : tab === 'known' ? `seen recently` : esc(e.uuid || '');
            return `<div class="list-row">${tab === 'ipbans' ? `<div class="avatar sm">${ic('shield')}</div>` : avatar(name, 'sm')}<div class="grow"><b>${esc(name)}</b> <span class="sub">${sub}</span></div>
              ${tab === 'known' ? `<button class="btn btn-ghost btn-sm" data-q="ops" data-n="${esc(name)}">${ic('crown')}${isOp(name) ? 'Op ✓' : 'Op'}</button><button class="btn btn-ghost btn-sm" data-q="whitelist" data-n="${esc(name)}">${ic('check')}Whitelist</button><button class="icon-btn danger" title="Ban" data-q="bans" data-n="${esc(name)}">${ic('ban')}</button>`
              : `<button class="icon-btn danger" title="Remove" data-rm="${esc(name)}">${ic('x')}</button>`}</div>`;
          }).join('') : `<div class="empty">${ic(TABS.find(t => t[0] === tab)[2])}<div>Nothing here yet.</div></div>`}</div>`;
        $$('[data-t]', $('#plLists')).forEach(b => b.onclick = () => { tab = b.dataset.t; store.set('playerTab', tab); drawLists(); });
        const f = $('#lAdd'); if (f) f.onsubmit = e => { e.preventDefault(); const n = $('#lName').value.trim(); if (n) change(tab, 'add', n, $('#lReason') ? $('#lReason').value.trim() : ''); };
        $$('[data-rm]', $('#plLists')).forEach(b => b.onclick = () => change(tab, 'remove', b.dataset.rm));
        $$('[data-q]', $('#plLists')).forEach(b => b.onclick = async () => {
          if (b.dataset.q === 'bans' && !(await confirmBox({ title: `Ban ${b.dataset.n}?`, ok: 'Ban', danger: true }))) return;
          change(b.dataset.q, b.dataset.q === 'ops' && isOp(b.dataset.n) ? 'remove' : 'add', b.dataset.n);
        });
        const wt = $('#wlToggle'); if (wt) wt.onchange = async () => {
          if (online()) await cmd(wt.checked ? 'whitelist on' : 'whitelist off', true);
          await post('/api/properties', { changes: { 'white-list': String(wt.checked) } });
          toast(`Whitelist ${wt.checked ? 'enabled' : 'disabled'}`);
        };
      };
      async function change(list, action, name, reason) {
        try { lists = await post('/api/lists', { list, action, name, reason }); toast(`${action === 'add' ? 'Added' : 'Removed'} ${name}`); drawLists(); drawOnline(); }
        catch (e) { toast(e.message, 'err'); }
      }
      async function load() { try { lists = await api('/api/lists'); } catch { /* keep */ } drawLists(); drawOnline(); }
      function drawAll() { drawHead(); drawBulk(); drawOnline(); }

      // live vitals: quietly re-read every 20 s while the page is open
      let busy = false;
      async function refreshInfo(force) {
        if (busy || !online() || document.hidden) return; busy = true;
        for (const p of S.snap.players.slice(0, 8)) {
          if (!safeName(p.name)) continue;
          try { info[p.name] = await api('/api/players/inspect?name=' + encodeURIComponent(p.name)); } catch { /* left */ }
        }
        busy = false; drawOnline(); void force;
      }

      drawAll(); load(); refreshInfo();
      const t1 = setInterval(refreshInfo, 30000);
      const t2 = setInterval(() => { if (S.snap.players.length) drawOnline(); }, 30000);
      on(kind => {
        if (kind === 'players') { drawAll(); refreshInfo(); }
        if (kind === 'state') { drawAll(); drawLists(); }
      });
      return () => { clearInterval(t1); clearInterval(t2); };
    },
  };
})();
