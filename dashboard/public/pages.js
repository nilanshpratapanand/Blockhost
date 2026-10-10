/* Blockhost dashboard — pages */
(() => {
  'use strict';
  const { $, $$, esc, ic, api, post, cmd, toast, modal, confirmBox, fmtBytes, fmtDur, fmtDate, ago, titleCase, avatar, mcFormat, stripMc, store, S, pages, startServer, stopServer, sparkline, copyText } = window.BH;
  const online = () => S.snap && S.snap.state === 'online';
  const running = () => S.snap && ['online', 'starting', 'stopping'].includes(S.snap.state);

  // ============================================================== console line renderer (shared)
  const LINE_RE = /^\[(\d\d:\d\d:\d\d)\] \[([^\]]+?)\/(\w+)\]: ?([\s\S]*)$/;
  function lineHTML(l, hl) {
    const m = l.text.match(LINE_RE);
    let ts, lv, msg;
    if (m) { ts = m[1]; lv = m[3]; msg = m[4]; }
    else { ts = new Date(l.t).toTimeString().slice(0, 8); lv = l.level === 'dash' ? 'PANEL' : l.level === 'cmd' ? 'YOU' : ''; msg = l.text; }
    let body = esc(msg);
    if (hl) { const re = new RegExp(hl.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'); body = body.replace(re, x => `<mark>${x}</mark>`); }
    return `<div class="ln ${l.level}"><span class="ts">${ts}</span><span class="lv">${esc(lv)}</span>${body}</div>`;
  }

  // ============================================================== OVERVIEW
  pages.overview = {
    title: 'Overview', sub: 'Start, stop and keep an eye on your server',
    render(view, on) {
      view.innerHTML = `<div class="stack">
        <div id="ovBanners" class="stack"></div>
        <div class="card hero" id="ovHero"></div>
        <div class="grid g-4" id="ovStats"></div>
        <div class="grid g-2">
          <div class="card"><div class="card-h"><h3>Quick actions</h3><span class="sub" id="qaHint"></span></div><div id="ovQA"></div></div>
          <div class="card" style="display:flex;flex-direction:column"><div class="card-h"><h3>Live console</h3><span class="spacer"></span><a class="btn btn-ghost btn-sm" href="#/console">${ic('terminal')}Open</a></div>
            <div class="console" style="flex:1"><div class="console-body" id="ovCon" style="height:250px"></div>
            <form class="console-input" id="ovForm"><span class="prompt">/</span><input id="ovIn" placeholder="Type a command (e.g. time set day)" autocomplete="off"></form></div>
          </div>
        </div></div>`;

      const drawBanners = () => {
        const s = S.snap, b = [];
        if (!s.hasJar) b.push(`<div class="banner"><div class="b-ico">${ic('sparkle')}</div><div class="b-text"><b>No server here yet</b><span>The setup wizard creates one in about a minute — just press buttons.</span></div><a class="btn btn-primary btn-sm" href="#/setup">Start setup</a></div>`);
        else if (s.latestRelease && s.installedVersion && s.latestRelease !== s.installedVersion) b.push(`<div class="banner"><div class="b-ico">${ic('sparkle')}</div><div class="b-text"><b>Minecraft ${esc(s.latestRelease)} is available</b><span>You're on ${esc(s.installedVersion)}. Updating makes a backup first.</span></div><a class="btn btn-primary btn-sm" href="#/software">Update</a></div>`);
        if (s.hasJar && !s.address && !s.playit.path) b.push(`<div class="banner"><div class="b-ico">${ic('tunnel')}</div><div class="b-text"><b>Want friends to join from anywhere?</b><span>Install playit.gg with one click and get a free public address.</span></div><a class="btn btn-primary btn-sm" href="#/setup?step=5">Set up playit</a></div>`);
        if (s.hasJar && !s.eula) b.push(`<div class="banner warn"><div class="b-ico">${ic('info')}</div><div class="b-text"><b>EULA not accepted</b><span>You need to accept Mojang's EULA once before starting.</span></div><button class="btn btn-warn btn-sm" id="eulaBtn">Review</button></div>`);
        if (s.external && s.state !== 'online') b.push(`<div class="banner warn"><div class="b-ico">${ic('alert')}</div><div class="b-text"><b>Your server is running outside Blockhost</b><span>${s.external.online} player${s.external.online === 1 ? '' : 's'} online${s.external.players.length ? ': ' + s.external.players.map(p => esc(p.name)).join(', ') : ''}. It was started another way (probably the old run.bat), so Blockhost can't send commands. Press the button to stop it safely and take over here.</span></div><button class="btn btn-warn btn-sm" id="takeOver">Take over</button></div>`);
        if (s.lastFailure && s.state !== 'online' && s.state !== 'starting') b.push(`<div class="banner danger"><div class="b-ico">${ic('alert')}</div><div class="b-text"><b>The server couldn't start</b><span>${esc(s.lastFailure.hint)}</span></div>${s.lastFailure.code === 'PORT_BUSY' || s.lastFailure.code === 'WORLD_LOCKED' ? `<button class="btn btn-danger btn-sm" id="fixBusy">Fix it</button>` : `<a class="btn btn-danger btn-sm" href="#/console">Console</a>`}</div>`);
        if (s.state === 'crashed' && !s.lastFailure) b.push(`<div class="banner danger"><div class="b-ico">${ic('alert')}</div><div class="b-text"><b>The server crashed</b><span>Check the console for the error. ${esc('Auto-restart is tried up to 3 times.')}</span></div><a class="btn btn-danger btn-sm" href="#/console">View console</a></div>`);
        $('#ovBanners').innerHTML = b.join('');
        const eb = $('#eulaBtn'); if (eb) eb.onclick = () => window.BH.eulaModal();
        const to = $('#takeOver'); if (to) to.onclick = () => startServer();
        const fb = $('#fixBusy'); if (fb) fb.onclick = () => startServer();
      };

      const drawHero = () => {
        const s = S.snap;
        const lbl = { offline: 'Start', crashed: 'Start', starting: 'Starting', online: 'Online', stopping: 'Stopping' }[s.state];
        const sub = s.state === 'online' ? `Up ${fmtDur(Date.now() - s.onlineAt)} · click to stop` : s.state === 'starting' ? 'Loading the world...' : s.state === 'stopping' ? 'Saving & shutting down...' : 'Click to start the server';
        $('#ovHero').innerHTML = `
          <div style="min-width:0;position:relative">
            <div class="server-id">
              <div class="server-icon" id="heroIcon"><img src="/api/icon?${Date.now()}" alt="" onerror="this.parentNode.innerHTML='<svg viewBox=&quot;0 0 32 32&quot;><path fill=&quot;#7c5cff&quot; d=&quot;M16 2 29 9v14l-13 7-13-7V9z&quot;/><path fill=&quot;#b8a3ff&quot; d=&quot;M16 2 29 9l-13 7L3 9z&quot;/><path fill=&quot;#5634d4&quot; d=&quot;M16 16v14l13-7V9z&quot;/></svg>'"></div>
              <div style="min-width:0"><div class="eyebrow">Minecraft Java · ${esc(s.version || s.installedVersion || 'not installed')}</div><div class="motd">${mcFormat(s.motd)}</div></div>
            </div>
            ${s.address ? `<div class="big-address">${esc(s.address)}<button class="icon-btn" id="cpAddr" title="Copy">${ic('copy')}</button></div><div class="muted small">Share this address with friends. They join via Multiplayer → Add Server.</div>`
              : `<div class="big-address empty">No public address set. <a href="#/settings">Add your playit.gg address</a> so friends know where to join.</div>`}
            <div class="hero-meta">
              <span class="tag ${s.playit.running ? 'green' : ''}">${ic('tunnel')}playit ${s.playit.running ? 'running' : 'not running'}</span>
              ${!s.playit.running && s.playit.path ? `<button class="btn btn-ghost btn-sm" id="playitBtn">${ic('play')}Start playit</button>` : ''}
              ${!s.playit.path ? `<a class="btn btn-ghost btn-sm" href="#/setup?step=5">${ic('download')}Get playit</a>` : ''}
              ${s.serverPack ? `<span class="tag purple">${ic('image')}${esc(s.serverPack.name).slice(0, 28)}</span>` : ''}
              <span class="tag">${ic('link')}port ${esc(s.port)}</span>
              <span class="tag ${s.onlineMode ? 'blue' : 'gold'}">${ic('shield')}${s.onlineMode ? 'Premium only' : 'Cracked allowed'}</span>
              ${s.whitelist ? `<span class="tag purple">${ic('check')}Whitelist on</span>` : ''}
              <span class="tag">${ic('gamepad')}${esc(s.gamemode)} · ${esc(s.difficulty)}</span>
            </div>
          </div>
          <div class="power-wrap">
            <button class="power" id="powerBtn" ${['starting', 'stopping'].includes(s.state) ? 'disabled' : ''} aria-label="${lbl}">${ic(s.state === 'online' ? 'power' : ['starting', 'stopping'].includes(s.state) ? 'clock' : 'play')}</button>
            <div class="power-label">${lbl}</div>
            <div class="power-sub" id="powerSub">${sub}</div>
            ${running() ? `<div class="power-extra"><button class="btn btn-ghost btn-sm" id="rsBtn">${ic('restart')}Restart</button><button class="btn btn-ghost btn-sm" id="killBtn" title="Force stop (may lose unsaved progress)">${ic('skull')}Kill</button></div>` : ''}
          </div>`;
        $('#powerBtn').onclick = () => (s.state === 'online' ? stopServer() : startServer());
        const cp = $('#cpAddr'); if (cp) cp.onclick = () => copyText(s.address);
        const pb = $('#playitBtn'); if (pb) pb.onclick = () => post('/api/playit/start').then(() => toast('playit.gg starting in its own window')).catch(e => toast(e.message, 'err'));
        const rs = $('#rsBtn'); if (rs) rs.onclick = () => post('/api/restart');
        const kb = $('#killBtn'); if (kb) kb.onclick = async () => { if (await confirmBox({ title: 'Force kill the server?', text: 'Only use this if it is frozen. Anything not saved in the last few minutes can be lost.', ok: 'Kill', danger: true })) post('/api/kill'); };
      };

      const drawStats = () => {
        const s = S.snap, st = S.stats || {}, h = S.history;
        const maxRam = S.cfgMaxRam || 0;
        $('#ovStats').innerHTML = `
          <div class="card stat"><div class="eyebrow">${ic('users')}Players</div><div class="stat-value">${s.state !== 'online' && s.external ? s.external.online : (s.onlineCount ?? s.players.length)}<small>/ ${s.maxPlayers}</small></div>
            <div class="faces">${s.players.slice(0, 8).map(p => avatar(p.name, 'face')).join('') || ((s.onlineCount || (s.external && s.external.online)) ? '<span class="dim small">names hidden</span>' : '<span class="dim small">Nobody online</span>')}</div></div>
          <div class="card stat"><div class="eyebrow">${ic('cpu')}PC CPU</div><div class="stat-value">${st.cpu ?? 0}<small>%</small></div>${sparkline(h.map(x => x.cpu), '#8b6cff', 100)}</div>
          <div class="card stat"><div class="eyebrow">${ic('memory')}Server RAM</div><div class="stat-value">${st.serverMem ? fmtBytes(st.serverMem).replace(' ', '<small>') + '</small>' : '0<small>MB</small>'}</div>${sparkline(h.map(x => x.mem), '#34d99a')}</div>
          <div class="card stat"><div class="eyebrow">${ic('globe')}World</div><div class="stat-value">${s.worldSize ? fmtBytes(s.worldSize).replace(' ', '<small>') + '</small>' : '<small>measuring…</small>'}</div>
            <div class="muted small" style="margin-top:6px">PC RAM ${fmtBytes(st.memUsed || 0)} / ${fmtBytes(st.memTotal || 0)}</div><div class="meter"><i style="width:${st.memTotal ? Math.round(st.memUsed * 100 / st.memTotal) : 0}%"></i></div></div>`;
        void maxRam;
      };

      const QA = [
        { k: 'day', l: 'Day', i: 'sun', c: 'sun', cmd: 'time set day' },
        { k: 'night', l: 'Night', i: 'moon', c: 'moon', cmd: 'time set night' },
        { k: 'clear', l: 'Clear sky', i: 'sun', c: 'sun', cmd: 'weather clear' },
        { k: 'rain', l: 'Rain', i: 'rain', c: 'moon', cmd: 'weather rain' },
        { k: 'thunder', l: 'Thunder', i: 'bolt', c: 'moon', cmd: 'weather thunder' },
        { k: 'save', l: 'Save world', i: 'save', c: 'green', cmd: 'save-all' },
        { k: 'say', l: 'Broadcast', i: 'megaphone', c: '', fn: broadcast },
        { k: 'heal', l: 'Heal all', i: 'heart', c: 'red', cmd: 'effect give @a minecraft:instant_health 1 5 true' },
        { k: 'feed', l: 'Feed all', i: 'food', c: 'sun', cmd: 'effect give @a minecraft:saturation 1 20 true' },
        { k: 'drops', l: 'Clear drops', i: 'broom', c: '', cmd: 'kill @e[type=minecraft:item]', sub: 'fixes item lag' },
        { k: 'tps', l: 'Check TPS', i: 'gauge', c: 'green', cmd: 'tick query', sub: 'see console' },
        { k: 'list', l: 'Who\'s on', i: 'users', c: '', cmd: 'list' },
        { k: 'allme', l: 'Everyone to me', i: 'download', c: 'green', fn: () => withMe(m => cmd(`tp @a ${m}`)) },
        { k: 'allc', l: 'All creative', i: 'sparkle', c: '', cmd: 'gamemode creative @a' },
        { k: 'alls', l: 'All survival', i: 'heart', c: 'red', cmd: 'gamemode survival @a' },
        { k: 'party', l: 'Fireworks party', i: 'sparkle', c: 'sun', fn: async () => { for (const c of window.BH.FUN.fireworks.c('@a')) await cmd(c, true); toast('Fireworks for everyone!'); }, sub: 'everyone' },
        { k: 'chickenrain', l: 'Chicken rain', i: 'food', c: '', fn: async () => { for (const c of window.BH.FUN.chickens.c('@a')) await cmd(c, true); toast('Chicken rain!'); }, sub: 'everyone' },
        { k: 'spawnme', l: 'Spawn at me', i: 'pin', c: 'green', fn: () => withMe(m => cmd(`execute at ${m} run setworldspawn ~ ~ ~`)), sub: 'world spawn' },
      ];
      async function withMe(fn) {
        let m = S.snap.myName;
        if (!m) {
          const names = S.snap.players.map(p => p.name);
          m = await confirmBox({ title: 'What is your Minecraft name?', text: names.length ? 'Online now: ' + names.map(esc).join(', ') : '', ok: 'Save', input: { value: names.length === 1 ? names[0] : '', required: true } });
          if (!m) return; await post('/api/config', { config: { myName: m } }); S.snap.myName = m;
        }
        fn(m);
      }
      const drawQA = () => {
        const dis = !online();
        $('#qaHint').textContent = dis ? 'Start the server to use these' : '';
        $('#ovQA').innerHTML = `<div class="qa-grid">${QA.map(q => `<button class="qa ${q.c}" data-k="${q.k}" ${dis ? 'disabled' : ''}><span class="qa-ico">${ic(q.i)}</span><span>${q.l}${q.sub ? `<small>${q.sub}</small>` : ''}</span></button>`).join('')}</div>
          <div class="eyebrow" style="margin:18px 0 8px">World switches</div><div class="switch-grid" id="ovSw">${SWITCHES.map(([k, l]) => `<label class="sw"><span>${l}</span><span class="switch"><input type="checkbox" data-rule="${k}" ${dis ? 'disabled' : ''}><span></span></span></label>`).join('')}</div>
          <div class="row between" style="margin-top:14px"><span class="muted small">Difficulty</span><div class="seg" id="diffSeg">${['peaceful', 'easy', 'normal', 'hard'].map(d => `<button class="${S.snap.difficulty === d ? 'on' : ''}" data-d="${d}" ${dis ? 'disabled' : ''}>${d}</button>`).join('')}</div></div>`;
        $$('.qa', $('#ovQA')).forEach(b => b.onclick = () => { const q = QA.find(x => x.k === b.dataset.k); q.fn ? q.fn() : cmd(q.cmd); });
        loadSwitches();
        $$('#ovSw [data-rule]').forEach(el => el.onchange = async () => {
          try { await post('/api/gamerules', { key: el.dataset.rule, value: el.checked }); toast(`${el.closest('.sw').firstElementChild.textContent}: ${el.checked ? 'on' : 'off'}`); } catch (e) { toast(e.message, 'err'); el.checked = !el.checked; }
        });
        $$('#diffSeg button').forEach(b => b.onclick = async () => { if (await cmd('difficulty ' + b.dataset.d)) { $$('#diffSeg button').forEach(x => x.classList.toggle('on', x === b)); post('/api/properties', { changes: { difficulty: b.dataset.d } }); } });
      };
      const SWITCHES = [['minecraft:keep_inventory', 'Keep inventory'], ['minecraft:advance_time', 'Day/night cycle'], ['minecraft:advance_weather', 'Weather changes'], ['minecraft:mob_griefing', 'Mob griefing'], ['minecraft:pvp', 'PvP'], ['minecraft:spawn_mobs', 'Mob spawning'], ['minecraft:spawn_phantoms', 'Phantoms'], ['minecraft:immediate_respawn', 'Instant respawn']];
      async function loadSwitches() {
        if (!online()) return;
        try {
          const r = await api('/api/gamerules');
          for (const rule of r.rules) {
            const el = document.querySelector(`#ovSw [data-rule="${CSS.escape(rule.key)}"]`) || document.querySelector(`#ovSw [data-rule="minecraft:${CSS.escape(String(rule.key).replace(/^minecraft:/, ''))}"]`);
            if (el && rule.value != null) el.checked = String(rule.value) === 'true';
          }
        } catch { /* ignore */ }
      }
      function broadcast() {
        confirmBox({ title: 'Broadcast a message', text: 'Everyone online will see this in chat.', ok: 'Send', input: { placeholder: 'Server restarting in 5 minutes!', required: true } })
          .then(v => { if (v) cmd('say ' + v); });
      }

      const con = $('#ovCon');
      const drawCon = () => { con.innerHTML = S.lines.slice(-80).map(l => lineHTML(l)).join(''); con.scrollTop = con.scrollHeight; };
      $('#ovForm').onsubmit = e => { e.preventDefault(); const v = $('#ovIn').value.trim(); if (!v) return; cmd(v, true); $('#ovIn').value = ''; };

      drawBanners(); drawHero(); drawStats(); drawQA(); drawCon();
      api('/api/config').then(r => { S.cfgMaxRam = r.config.maxRam; }).catch(() => {});
      const tick = setInterval(() => { const ps = $('#powerSub'); if (ps && online()) ps.textContent = `Up ${fmtDur(Date.now() - S.snap.onlineAt)} · click to stop`; }, 1000);
      on(kind => {
        if (kind === 'state' || kind === 'taskdone') { drawBanners(); drawHero(); drawQA(); drawStats(); }
        else if (kind === 'players') drawStats();
        else if (kind === 'stats') drawStats();
        else if (kind === 'line') {
          const atBottom = con.scrollHeight - con.scrollTop - con.clientHeight < 40;
          con.insertAdjacentHTML('beforeend', lineHTML(S.lines[S.lines.length - 1]));
          while (con.children.length > 120) con.firstChild.remove();
          if (atBottom) con.scrollTop = con.scrollHeight;
        }
      });
      return () => clearInterval(tick);
    },
  };

  // ============================================================== CONSOLE
  const CMD_HINTS = [
    ['list', 'who is online'], ['say ', 'broadcast message'], ['tell ', 'private message'], ['time set day', 'make it day'], ['time set night', 'make it night'],
    ['weather clear', 'stop rain'], ['weather rain', 'start rain'], ['gamemode survival ', 'set gamemode'], ['gamemode creative ', 'set gamemode'],
    ['difficulty ', 'peaceful/easy/normal/hard'], ['op ', 'make operator'], ['deop ', 'remove operator'], ['kick ', 'kick player'], ['ban ', 'ban player'],
    ['pardon ', 'unban player'], ['whitelist add ', 'allow player'], ['whitelist on', 'enable whitelist'], ['whitelist off', 'disable whitelist'],
    ['tp ', 'teleport'], ['give ', 'give item'], ['effect give ', 'give effect'], ['xp add ', 'give experience'], ['gamerule ', 'change a rule'],
    ['tick query', 'server performance (TPS)'], ['save-all', 'save world now'], ['seed', 'show world seed'], ['setworldspawn', 'set spawn here'],
    ['spawnpoint ', 'set player spawn'], ['kill ', 'kill entity/player'], ['clear ', 'clear inventory'], ['enchant ', 'enchant held item'],
    ['locate structure ', 'find a structure'], ['worldborder set ', 'set border size'], ['stop', 'stop server'],
  ];
  pages.console = {
    title: 'Console', sub: 'Live server log — type any command without the slash',
    render(view, on) {
      const filters = { all: () => true, chat: l => l.level === 'chat', joins: l => l.level === 'join' || l.level === 'leave', warn: l => l.level === 'warn', error: l => l.level === 'error', cmd: l => l.level === 'cmd' || l.level === 'dash' };
      let filter = 'all', search = '', auto = true;
      const hist = store.get('cmdHistory', []); let hIdx = hist.length;
      view.innerHTML = `<div class="console" style="height:calc(100vh - 190px);min-height:420px">
        <div class="console-bar"><div class="lights"><i></i><i></i><i></i></div>
          <div class="chips" id="cFil">${[['all', 'All'], ['chat', 'Chat'], ['joins', 'Joins'], ['warn', 'Warnings'], ['error', 'Errors'], ['cmd', 'Commands']].map(([k, l]) => `<button class="chip ${k === 'all' ? 'on' : ''}" data-f="${k}">${l}</button>`).join('')}</div>
          <span style="flex:1"></span>
          <div style="position:relative;width:200px"><input class="input" id="cSearch" placeholder="Search log…" style="height:30px;padding-left:30px"><span style="position:absolute;left:9px;top:7px;color:var(--dim)">${ic('search').replace('<svg ', '<svg width="15" height="15" ')}</span></div>
          <label class="row small muted" style="gap:6px"><span class="switch"><input type="checkbox" id="cAuto" checked><span></span></span>Auto-scroll</label>
        </div>
        <div class="console-body" id="cBody"></div>
        <div class="chips" style="padding:8px 12px;border-top:1px solid var(--line)">${['list', 'tick query', 'save-all', 'time set day', 'weather clear', 'seed', 'whitelist list', 'banlist'].map(c => `<button class="chip" data-c="${c}">${c}</button>`).join('')}</div>
        <form class="console-input" id="cForm"><span class="prompt">/</span><input id="cIn" placeholder="${online() ? 'Enter a command…' : 'Server is offline'}" autocomplete="off" spellcheck="false"><button class="btn btn-primary btn-sm" type="submit">Send</button></form>
      </div>`;
      const body = $('#cBody'), input = $('#cIn');
      const draw = () => { body.innerHTML = S.lines.filter(filters[filter]).filter(l => !search || l.text.toLowerCase().includes(search)).slice(-1500).map(l => lineHTML(l, search)).join('') || `<div class="dim">Nothing here yet.</div>`; if (auto) body.scrollTop = body.scrollHeight; };
      $$('#cFil .chip').forEach(b => b.onclick = () => { filter = b.dataset.f; $$('#cFil .chip').forEach(x => x.classList.toggle('on', x === b)); draw(); });
      $('#cSearch').oninput = e => { search = e.target.value.toLowerCase(); draw(); };
      $('#cAuto').onchange = e => { auto = e.target.checked; if (auto) body.scrollTop = body.scrollHeight; };
      $$('[data-c]', view).forEach(b => b.onclick = () => send(b.dataset.c));

      let sugIdx = -1, sugList = [];
      const sugBox = document.createElement('div'); sugBox.className = 'suggest hidden'; $('#cForm').appendChild(sugBox);
      const showSug = () => {
        const v = input.value.toLowerCase();
        sugList = v ? CMD_HINTS.filter(([c]) => c.startsWith(v) && c !== v).slice(0, 7) : [];
        sugIdx = -1;
        sugBox.classList.toggle('hidden', !sugList.length);
        sugBox.innerHTML = sugList.map(([c, d], i) => `<div data-i="${i}">${esc(c)}<span>${esc(d)}</span></div>`).join('');
        $$('div', sugBox).forEach(d => d.onmousedown = e => { e.preventDefault(); input.value = sugList[+d.dataset.i][0]; showSug(); input.focus(); });
      };
      input.oninput = showSug;
      input.onblur = () => setTimeout(() => sugBox.classList.add('hidden'), 100);
      input.onkeydown = e => {
        if (!sugBox.classList.contains('hidden') && sugList.length) {
          if (e.key === 'Tab' || (e.key === 'ArrowDown') || (e.key === 'ArrowUp' && sugIdx >= 0)) {
            e.preventDefault();
            if (e.key === 'Tab') { input.value = sugList[Math.max(0, sugIdx)][0]; showSug(); return; }
            sugIdx = (sugIdx + (e.key === 'ArrowDown' ? 1 : -1) + sugList.length) % sugList.length;
            $$('div', sugBox).forEach((d, i) => d.classList.toggle('on', i === sugIdx));
            return;
          }
          if (e.key === 'Enter' && sugIdx >= 0) { e.preventDefault(); input.value = sugList[sugIdx][0]; showSug(); return; }
        }
        if (e.key === 'ArrowUp' && hist.length) { e.preventDefault(); hIdx = Math.max(0, hIdx - 1); input.value = hist[hIdx] || ''; }
        if (e.key === 'ArrowDown' && hist.length) { e.preventDefault(); hIdx = Math.min(hist.length, hIdx + 1); input.value = hist[hIdx] || ''; }
      };
      async function send(c) {
        c = c.trim().replace(/^\//, ''); if (!c) return;
        if (c === 'stop') { stopServer(); return; }
        if (await cmd(c, true)) { hist.push(c); while (hist.length > 50) hist.shift(); store.set('cmdHistory', hist); hIdx = hist.length; }
      }
      $('#cForm').onsubmit = e => { e.preventDefault(); send(input.value); input.value = ''; sugBox.classList.add('hidden'); };
      draw();
      on(kind => {
        if (kind === 'line') {
          const l = S.lines[S.lines.length - 1];
          if (!filters[filter](l) || (search && !l.text.toLowerCase().includes(search))) return;
          body.insertAdjacentHTML('beforeend', lineHTML(l, search));
          while (body.children.length > 1500) body.firstChild.remove();
          if (auto) body.scrollTop = body.scrollHeight;
        }
        if (kind === 'state') input.placeholder = online() ? 'Enter a command…' : 'Server is offline';
      });
      setTimeout(() => input.focus(), 50);
    },
  };

  window.BH_PAGES_PART1 = true;
})();
