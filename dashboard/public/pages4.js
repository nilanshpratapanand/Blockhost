/* Blockhost dashboard — Live Sync: friends' Minecraft follows the player kit automatically */
(() => {
  'use strict';
  const { $, $$, esc, ic, api, post, toast, confirmBox, S, pages } = window.BH;

  const MODES = {
    next: { label: 'Next launch', icon: 'clock', text: 'Downloads in the background and installs when they close Minecraft. Nobody is interrupted.' },
    ask: { label: 'Ask to restart', icon: 'msg', text: 'A pop-up asks each friend “Restart now?”. Yes = game closes safely, update installs, TLauncher opens again.' },
    now: { label: 'Restart now', icon: 'restart', text: '60-second countdown on their screen (+ a chat message), then Minecraft restarts with the update. For must-have changes.' },
  };
  const STATE = {
    synced: ['green', 'check', 'Up to date'], pending: ['gold', 'clock', 'Update waiting'], restarting: ['blue', 'restart', 'Restarting'],
    error: ['red', 'alert', 'Problem'],
  };
  const ago = s => s < 60 ? 'just now' : s < 3600 ? `${Math.round(s / 60)} min ago` : s < 86400 ? `${Math.round(s / 3600)} h ago` : `${Math.round(s / 86400)} d ago`;

  pages.sync = {
    title: 'Live Sync', sub: 'Your friends’ Minecraft updates itself whenever you change the player kit',
    render(view, on) {
      let st = S.sync || null, pushMode = 'next', testing = false, testRes = null, pushing = false, lastPush = null;

      const step = (n, title, done, body) => `<div class="card sync-step ${done ? 'done' : ''}"><div class="row" style="flex-wrap:nowrap;align-items:flex-start;gap:14px">
        <div class="step-n">${done ? ic('check') : n}</div><div style="flex:1;min-width:0"><h2 style="margin:2px 0 6px;font-size:16px">${title}</h2>${body}</div></div></div>`;

      const draw = () => {
        if (!st) { view.innerHTML = '<div class="card"><div class="skeleton" style="width:40%"></div></div>'; return; }
        const keep = { msg: $('#syMsg') && $('#syMsg').value, addr: $('#syAddr') && $('#syAddr').value, focus: document.activeElement && document.activeElement.id };
        const online = st.clients.filter(c => c.online);
        const behind = st.clients.filter(c => c.rev && st.rev && c.rev !== st.rev);
        view.innerHTML = `<div class="stack">
          <div class="card sync-hero"><div class="row" style="flex-wrap:nowrap;gap:16px;align-items:center">
            <div class="inst-ico">${ic('sync')}</div>
            <div style="flex:1;min-width:0"><h2 style="margin:0 0 4px;font-size:18px">Friends run one file once — after that, everything is automatic</h2>
              <div class="muted small">Add or remove shaders, texture packs or mods on <a href="#/packs">Packs & shaders</a> and every friend's PC follows within a minute: new files download in the background, old ones are removed, Iris / the Fabric version in TLauncher / the server list are set up. If Minecraft is open it waits for the game to close — or restarts it, if you push with “Restart now”.</div></div>
            <label class="row" style="gap:8px;flex:none"><span class="switch"><input type="checkbox" id="syEn" ${st.enabled ? 'checked' : ''}><span></span></span><b>${st.enabled ? 'On' : 'Off'}</b></label>
          </div>
          ${st.error ? `<div class="banner danger" style="margin-top:12px"><div class="b-ico">${ic('alert')}</div><div class="b-text"><b>${esc(st.error)}</b></div></div>` : ''}
          ${st.enabled && st.running ? `<div class="dim small" style="margin-top:10px">${ic('check').replace('<svg ', '<svg width="12" height="12" style="vertical-align:-2px;color:var(--emerald)" ')} Sync service running on local port <b class="mono">${st.port}</b> · host key <span class="mono">${esc(st.keyId)}</span></div>` : ''}
          </div>

          ${st.enabled ? `
          ${st.restartNeeded ? `<div class="banner warn"><div class="b-ico">${ic('restart')}</div><div class="b-text"><b>Restart the Minecraft server once to finish</b><span>Live Sync now shares the Minecraft tunnel. Players can stay connected until you restart.</span></div><button class="btn btn-primary btn-sm" id="syRestart">${ic('restart')}Restart now</button></div>` : ''}
          ${st.front && st.front.error ? `<div class="banner danger"><div class="b-ico">${ic('alert')}</div><div class="b-text"><b>${esc(st.front.error)}</b><span>Close the other server window, then press Test again.</span></div></div>` : ''}
          <div class="card push-card">
            <div class="row between" style="align-items:flex-start"><div><h2 style="margin:0 0 4px;font-size:18px">${ic('megaphone').replace('<svg ', '<svg width="17" height="17" style="vertical-align:-3px;margin-right:6px;color:var(--amethyst-2)" ')}Push to everyone</h2>
              <div class="muted small">One click sends your kit every way that works: data packs (server), server texture pack (every player, nothing to install), Live Sync (shaders, mods, settings, auto-fixes) and a chat message. If one route fails, the next one is used.</div></div>
              ${lastPush ? `<span class="dim small">last push ${esc(new Date(lastPush.at).toLocaleString())}</span>` : ''}</div>
            <div class="seg" id="syPm" style="margin-top:12px">${Object.entries(MODES).map(([k, m]) => `<button data-m="${k}" class="${pushMode === k ? 'on' : ''}">${ic(m.icon).replace('<svg ', '<svg width="13" height="13" style="vertical-align:-2px;margin-right:4px" ')}${m.label}</button>`).join('')}</div>
            <div class="dim small" style="margin:6px 0 10px">If a friend is playing: ${esc(MODES[pushMode].text)}</div>
            <div class="input-group"><input class="input" id="syMsg" maxlength="140" placeholder="What changed? (shown to friends, optional) e.g. New cozy leaves pack"><button class="btn btn-primary" id="syPush" ${pushing ? 'disabled' : ''}>${pushing ? '<span class="spinner"></span>Pushing…' : ic('megaphone') + 'Push now'}</button></div>
            ${lastPush ? `<div class="list" style="margin-top:12px">${lastPush.results.map(r => `<div class="list-row"><span class="tag ${r.skipped ? '' : r.ok ? 'green' : 'red'}">${ic(r.skipped ? 'info' : r.ok ? 'check' : 'x')}</span><div class="grow"><b>${esc(r.name)}</b> <span class="sub">${esc(r.detail)}</span></div></div>`).join('')}</div>` : ''}
          </div>

          <div class="card"><div class="card-h"><h2>Routes to your friends</h2>${testRes && testRes.results ? `<span class="tag ${testRes.ok ? 'green' : 'red'}">${testRes.ok ? 'reachable' : 'not reachable'}</span>` : ''}<span class="spacer"></span>
              <button class="btn btn-primary btn-sm" id="syTest" ${testing ? 'disabled' : ''}>${testing ? '<span class="spinner"></span>' : ic('search')}Test from the internet</button></div>
            <div class="muted small">Friends' helpers try these in order and remember what worked. playit's free Minecraft tunnel only carries Minecraft traffic, so the helper wraps Sync inside Minecraft packets - no extra tunnel needed.</div>
            <div class="opt" style="margin-top:12px"><div class="opt-text"><b>Fast lane (free Cloudflare tunnel)</b><span>Fastest route, and needed to send more than one texture pack to every player through the server. No account. Downloads Cloudflare's signed cloudflared once.${st.fast && st.fast.url ? ` Online: <span class="mono">${esc(st.fast.url)}</span>` : st.fast && st.fast.error ? ` <span style="color:var(--redstone)">${esc(st.fast.error)}</span>` : ''}</span></div>
              <label class="switch"><input type="checkbox" id="syFast" ${st.fast && st.fast.wanted ? 'checked' : ''}><span></span></label></div>
            <div class="list" style="margin-top:8px">${(testRes && testRes.results ? testRes.results : [
              { name: 'Fast lane (Cloudflare)', detail: st.fast && st.fast.url ? st.fast.url : 'off', ok: null },
              { name: 'Minecraft-wrapped (playit)', detail: st.url ? st.url.replace(/^http:\/\//, '') : 'no address', ok: null },
              { name: 'Server-list packets (playit)', detail: 'slowest, works through any Minecraft tunnel', ok: null }]).map(r => `<div class="list-row"><span class="tag ${r.ok === true ? 'green' : r.ok === false ? 'red' : ''}">${ic(r.ok === true ? 'check' : r.ok === false ? 'x' : 'info')}</span><div class="grow"><b>${esc(r.name)}</b> <span class="sub">${esc(r.detail || '')}</span></div></div>`).join('')}</div>
            ${typeof testRes === 'string' ? `<div class="small" style="color:var(--redstone);margin-top:8px">${esc(testRes)}</div>` : testRes && testRes.summary ? `<div class="small" style="margin-top:8px;color:${testRes.ok ? 'var(--emerald)' : 'var(--redstone)'}">${esc(testRes.summary)}</div>` : ''}
            ${st.urlNote ? `<div class="small" style="color:var(--gold);margin-top:8px">${esc(st.urlNote)}</div>` : ''}
            <details style="margin-top:10px"><summary class="dim small" style="cursor:pointer">Address not found / wrong?</summary>
              <form class="input-group" id="syPubF" style="margin-top:8px;max-width:520px"><input class="input mono" id="syPub" placeholder="Public address e.g. 147.185.221.225:64902" value="${esc(st.publicAddress || '')}"><button class="btn btn-ghost">${ic('save')}Save</button></form></details>
          </div>

          ${step(1, 'Send friends the Sync file (once)', false, `
            <div class="muted small">Each friend runs it <b>once</b> (Windows: “More info → Run anyway”). It installs everything in the kit, fixes mods that stop them joining, puts a small Blockhost icon in their tray and starts with Windows. Every later push reaches them by itself.</div>
            <div class="row" style="margin-top:12px"><a class="btn btn-primary ${st.url || (st.fast && st.fast.url) ? '' : 'disabled-link'}" id="syDl" href="/api/sync/client">${ic('download')}Download Blockhost Sync (.bat)</a>
              <span class="dim small">Same file for everyone. Send it on WhatsApp / Discord.</span></div>
            <div class="dim small" style="margin-top:10px">Safe by design: it only installs files from <i>your</i> signed list (RSA signature + SHA-1 per file), never touches mods it didn't install (except moving ones that break joining into mods\\_disabled-by-blockhost), and can be removed from its tray icon.</div>`)}

          <div class="card"><div class="card-h"><h2>Friends' PCs</h2><span class="tag ${online.length ? 'green' : ''}">${online.length} online</span>${behind.length ? `<span class="tag gold">${behind.length} behind</span>` : ''}<span class="spacer"></span><span class="dim small">current version <span class="mono">${esc(st.rev || '—')}</span></span></div>
            <div class="list">${st.clients.length ? st.clients.map(c => {
              const cur = !c.rev || c.rev === st.rev;
              let s = !c.online ? ['', 'power', 'Offline'] : STATE[c.state] || ['', 'info', c.state || '?'];
              if (c.online && !cur && c.state === 'synced') s = ['blue', 'sync', 'Getting update'];
              return `<div class="list-row"><div class="avatar sm">${esc((c.name || '?')[0])}</div>
                <div class="grow"><b>${esc(c.name)}</b> <span class="sub">${esc(c.pc || '')}${c.game ? ' · playing' : ''} · ${ago(c.ago)}${c.pending ? ` · ${c.pending} file(s) waiting` : ''}${c.error ? ' · ' + esc(c.error) : ''}</span></div>
                <span class="tag ${s[0]}">${ic(s[1])}${s[2]}</span></div>`;
            }).join('') : `<div class="muted small">Nobody yet. Friends appear here as soon as they run the Sync file (they report every minute while their PC is on).</div>`}</div></div>

          <details class="card"><summary><b>Advanced</b></summary>
            <div class="field" style="margin-top:12px"><label>When the kit changes without a push, friends who are playing get it:</label>
              <div class="seg" id="syDef">${Object.entries(MODES).map(([k, m]) => `<button data-m="${k}" class="${st.defaultMode === k ? 'on' : ''}">${m.label}</button>`).join('')}</div></div>
            <div class="row" style="margin-top:12px;gap:16px;align-items:flex-end">
              <label class="row small muted" style="gap:6px"><span class="switch"><input type="checkbox" id="syShared" ${st.shared ? 'checked' : ''}><span></span></span>Share the Minecraft tunnel (free)</label>
              ${!st.shared ? `<form class="input-group" id="syAddrF" style="flex-basis:100%;max-width:520px"><input class="input mono" id="syAddr" placeholder="Separate TCP tunnel (playit Premium) e.g. something.ply.gg:12345" value="${esc(st.address)}"><button class="btn btn-ghost">${ic('save')}Save</button></form>` : ''}
              <div class="field" style="width:170px"><label>Internal Minecraft port</label><input class="input mono" id="syIntPort" type="number" min="1024" max="65535" value="${st.internalPort || 25567}"></div>
              <div class="field" style="width:160px"><label>Local sync port</label><input class="input mono" id="syPort" type="number" min="1024" max="65535" value="${st.port}"></div>
              <button class="btn btn-ghost" id="syPortSave">${ic('save')}Save port</button>
              <label class="row small muted" style="gap:6px"><span class="switch"><input type="checkbox" id="syIris" ${st.iris ? 'checked' : ''}><span></span></span>Include Fabric + Iris + Sodium when the kit has shaders</label>
              <span class="spacer"></span>
              <button class="btn btn-ghost" id="syReset">${ic('key')}New access token</button>
            </div>
            <div class="dim small" style="margin-top:8px">With sharing on, Minecraft itself runs on the internal port and Blockhost forwards your server port to it. Turn sharing off only if you pay for a separate playit TCP tunnel. A new token locks out every Sync file you sent before (use it if a file leaked). Friends then need the new file.</div>
          </details>` : `
          <div class="card empty">${ic('sync')}<div><b>Live Sync is off.</b> Switch it on above. It uses your existing Minecraft tunnel — no extra playit setup. (Turning it on needs one server restart.)</div></div>`}
        </div>`;
        if (keep.msg && $('#syMsg')) $('#syMsg').value = keep.msg;
        if (keep.addr != null && $('#syAddr') && keep.addr !== st.address && keep.focus === 'syAddr') $('#syAddr').value = keep.addr;
        if (keep.focus && $('#' + keep.focus)) { const el = $('#' + keep.focus); el.focus(); if (el.setSelectionRange && el.type !== 'number') try { el.setSelectionRange(el.value.length, el.value.length); } catch { /* ignore */ } }
        bind();
      };

      const save = async patch => { try { st = await post('/api/sync/settings', patch); S.sync = st; draw(); return true; } catch (e) { toast(e.message, 'err', 6000); return false; } };

      function bind() {
        const en = $('#syEn'); if (en) en.onchange = () => save({ enabled: en.checked }).then(() => setTimeout(load, 600));
        const af = $('#syAddrF'); if (af) af.onsubmit = async e => { e.preventDefault(); testRes = null; if (await save({ address: $('#syAddr').value })) toast('Saved'); };
        const tb = $('#syTest'); if (tb) tb.onclick = async () => {
          testing = true; testRes = null; draw();
          try { testRes = await post('/api/sync/test'); } catch (e) { testRes = e.message; }
          testing = false; draw();
        };
        const fl = $('#syFast'); if (fl) fl.onchange = async () => {
          try { await post('/api/fastlane', { enabled: fl.checked }); toast(fl.checked ? 'Starting the fast lane… (first time downloads cloudflared)' : 'Fast lane off', 'ok', 5000); } catch (e) { toast(e.message, 'err'); }
          setTimeout(load, 1500);
        };
        const dl = $('#syDl'); if (dl) dl.onclick = e => { if (!st.url && !(st.fast && st.fast.url)) { e.preventDefault(); toast(st.urlNote || 'Set the address first (step 1)', 'err'); } else toast('Sync file downloaded — send it to your friends', 'ok', 5000); };
        $$('#syDef button').forEach(b => b.onclick = () => save({ defaultMode: b.dataset.m }));
        $$('#syPm button').forEach(b => b.onclick = () => { pushMode = b.dataset.m; draw(); });
        const pb = $('#syPush'); if (pb) pb.onclick = async () => {
          if (pushMode === 'now' && !(await confirmBox({ title: 'Restart everyone’s Minecraft?', text: 'Friends who are playing get a 60-second countdown, then their game closes and restarts with the update. Their worlds are saved first.', ok: 'Push & restart', danger: true }))) return;
          pushing = true; draw();
          try {
            await post('/api/push', { mode: pushMode, message: ($('#syMsg') || {}).value || '' });
            await new Promise(res => { const iv = setInterval(() => { const t = S.snap && S.snap.task; if (!t || t.done) { clearInterval(iv); res(); } }, 500); });
            const t = S.snap && S.snap.task; if (t && t.error) toast(t.error, 'err', 8000);
            lastPush = await api('/api/push/last');
            toast(lastPush && lastPush.results.every(r => r.ok) ? 'Pushed everywhere ✓' : 'Pushed - check the routes marked red', lastPush && lastPush.results.every(r => r.ok) ? 'ok' : 'err', 6000);
          } catch (e) { toast(e.message, 'err'); }
          pushing = false; load();
        };
        const sh = $('#syShared'); if (sh) sh.onchange = () => { testRes = null; save({ shared: sh.checked }); };
        const ipb = $('#syIntPort'); if (ipb) ipb.onchange = () => save({ internalPort: Number(ipb.value) }).then(ok => ok && toast('Saved - restart the server to use it'));
        const rr = $('#syRestart'); if (rr) rr.onclick = async () => { rr.disabled = true; try { await post('/api/restart'); toast('Restarting the server…'); setTimeout(load, 8000); setTimeout(load, 20000); } catch (e) { toast(e.message, 'err'); rr.disabled = false; } };
        const ps = $('#syPortSave'); if (ps) ps.onclick = async () => { if (await save({ port: Number($('#syPort').value) })) toast('Port saved — update the playit tunnel to the same port', 'ok', 6000); };
        const ir = $('#syIris'); if (ir) ir.onchange = () => save({ iris: ir.checked });
        const rs = $('#syReset'); if (rs) rs.onclick = async () => {
          if (!(await confirmBox({ title: 'Make a new access token?', text: 'Every Sync file you already sent stops working. Friends need to run the new file once.', ok: 'New token', danger: true }))) return;
          try { await post('/api/sync/token/reset'); toast('New token made — download the Sync file again'); load(); } catch (e) { toast(e.message, 'err'); }
        };
      }

      async function load() { try { st = await api('/api/sync/status'); S.sync = st; if (!lastPush) lastPush = await api('/api/push/last').catch(() => null); } catch (e) { toast(e.message, 'err'); } draw(); }
      draw(); load();
      const iv = setInterval(() => { if (st && st.clients.length) draw(); }, 30000);   // refresh "x min ago"
      on(k => { if (k === 'sync') { st = S.sync; draw(); } });
      return () => clearInterval(iv);
    },
  };
})();
