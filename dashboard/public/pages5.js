/* Cloud Host: the server follows whoever starts it; the world lives in free cloud storage. */
(() => {
  const { $, $$, esc, ic, api, post, toast, confirmBox, copyText, pages, S, fmtBytes } = window.BH;

  const rel = ms => { if (!ms) return ''; const s = Math.round(ms / 1000); if (s < 60) return s + 's'; const m = Math.round(s / 60); return m < 60 ? m + ' min' : Math.floor(m / 60) + ' h ' + (m % 60) + ' min'; };
  const agoStr = t => { if (!t) return 'never'; const s = Math.round((Date.now() - t) / 1000); return s < 10 ? 'just now' : s < 90 ? s + 's ago' : s < 5400 ? Math.round(s / 60) + ' min ago' : Math.round(s / 3600) + ' h ago'; };
  const icn = (n, px = 16) => ic(n).replace('<svg ', `<svg width="${px}" height="${px}" `);
  const genSecret = () => { const a = new Uint8Array(18); crypto.getRandomValues(a); return Array.from(a, b => 'abcdefghijkmnpqrstuvwxyz23456789'[b % 32]).join(''); };

  pages.cloud = {
    title: 'Cloud Host', sub: 'No always-on PC needed: whoever starts the server hosts it, and the world follows',
    render(view, on) {
      let b = null, info = null, testing = null, busy = false, showCode = false, secret = genSecret(), seedTask = null;
      const tick = [];

      const load = async () => { try { b = await api('/api/baton'); } catch (e) { toast(e.message, 'err'); } draw(); if (b && b.configured && !b.remote) refresh(); };
      const refresh = async () => { if (!b || !b.configured || busy) return; try { const s = await post('/api/baton/refresh'); b = { ...b, ...s }; draw(); } catch { /* offline */ } };
      on(kind => { if (kind === 'baton' && S.baton) { b = { ...(b || {}), ...S.baton }; draw(); } if (kind === 'taskdone') load(); });
      tick.push(setInterval(refresh, 10000), setInterval(() => { if (b && b.hosting) draw(); }, 5000));

      const act = (id, fn) => { const el = $('#' + id, view); if (el) el.onclick = async () => { if (busy) return; busy = true; el.disabled = true; try { await fn(); } catch (e) { toast(e.message, 'err', 7000); } busy = false; await load(); }; };

      const stateOf = () => {
        const r = b.remote, ph = b.phase;
        if (ph === 'hosting') return { key: 'hosting', color: 'var(--emerald)', title: 'Your PC is hosting', text: 'Friends can join now. The server hands itself back after ' + b.idleMin + ' minutes with nobody online.' };
        if (['checking', 'acquiring', 'downloading', 'starting'].includes(ph)) return { key: 'working', color: 'var(--gold)', title: ph === 'downloading' ? 'Getting the latest world' : 'Starting up', text: b.message || 'One moment...' };
        if (['saving', 'uploading'].includes(ph)) return { key: 'working', color: 'var(--gold)', title: 'Saving to the cloud', text: b.message || 'Do not close the dashboard yet.' };
        if (ph === 'error') return { key: 'error', color: 'var(--redstone)', title: 'Something needs attention', text: b.message };
        if (ph === 'lost') return { key: 'error', color: 'var(--redstone)', title: 'Another host took over', text: b.message };
        if (r && r.state === 'hosted') return { key: 'other', color: 'var(--diamond)', title: `${esc(r.host.name)} is hosting`, text: `${r.host.players} playing right now. Just join with the address below.` };
        return { key: 'free', color: 'var(--amethyst)', title: 'Server is asleep', text: r && r.wanted ? `${r.wanted.by} is waiting to play.` : 'Nobody is hosting. Start it and your PC becomes the host until everyone leaves.' };
      };

      const heroAddress = st => {
        const r = b.remote;
        const addr = st.key === 'hosting' ? b.address : (r && r.state === 'hosted' ? r.host.address : '');
        if (st.key === 'hosting' && !b.address) return `<div class="banner warn" style="margin-top:14px"><div class="b-ico">${ic('alert')}</div><div class="b-text"><b>No public address set on this PC</b><span>Friends cannot reach you yet. <a href="#/settings">Add your playit.gg address</a> (free).</span></div></div>`;
        if (!addr) return '';
        return `<div class="big-address" style="margin-top:16px">${esc(addr)}<button class="icon-btn" id="cpAddr" title="Copy">${ic('copy')}</button></div><div class="muted small">Multiplayer &rarr; Add Server &rarr; paste this address</div>`;
      };

      const mainButton = st => {
        const r = b.remote;
        if (st.key === 'hosting') return `<button class="btn btn-danger" id="btStop" style="padding:14px 22px;font-size:15px">${icn('stop', 18)}Stop &amp; save to cloud</button>`;
        if (st.key === 'working') return `<div class="spinner" style="width:34px;height:34px"></div>`;
        if (st.key === 'error') {
          const retry = /Retry upload/.test(b.message || '') ? `<button class="btn btn-primary" id="btRetry" style="padding:14px 22px">Retry upload</button>` : `<button class="btn btn-primary" id="btStart" style="padding:14px 22px;font-size:15px">${icn('play', 18)}Try again</button>`;
          return retry + (/Java/i.test(b.message || '') ? `<button class="btn btn-ghost btn-sm" id="btJava">Install Java</button>` : '');
        }
        if (st.key === 'other') return `<span class="tag blue" style="font-size:13px;padding:8px 14px">${icn('users', 14)}Hosted by ${esc(r.host.name)}</span>`;
        if (!b.ramPlan.ok) return `<button class="btn btn-primary" id="btAsk" style="padding:14px 22px;font-size:15px">${icn('msg', 18)}Ask a friend to host</button>`;
        return `<button class="btn btn-primary" id="btStart" style="padding:14px 26px;font-size:16px">${icn('play', 18)}Start server</button>`;
      };

      const pct = () => b.progress && b.progress.total ? Math.round(100 * b.progress.done / b.progress.total) : null;

      const drawJoined = () => {
        const st = stateOf(), r = b.remote, rp = b.ramPlan, p = pct();
        const emptyLeft = b.hosting && b.emptyForMs ? Math.max(0, b.idleMin * 60000 - b.emptyForMs) : null;
        view.innerHTML = `<div class="stack">
          <div class="card hero cloud-hero" style="--state:${st.color}">
            <div style="min-width:0;position:relative">
              <div class="eyebrow">Cloud Host &middot; ${esc(b.me ? b.me.name : '')}</div>
              <h2 style="margin:6px 0 4px;font-size:26px;letter-spacing:-.4px">${st.title}</h2>
              <div class="muted">${esc(st.text)}</div>
              ${p != null ? `<div class="bar" style="display:block;height:8px;border-radius:9px;background:rgba(255,255,255,.08);margin-top:14px;max-width:420px;overflow:hidden"><i style="display:block;height:100%;width:${p}%;background:var(--state);transition:width .3s"></i></div>` : ''}
              ${heroAddress(st)}
              ${b.remoteErr ? `<div class="small" style="margin-top:10px;color:var(--redstone)">Cannot reach the group right now: ${esc(b.remoteErr)}</div>` : ''}
            </div>
            <div style="display:grid;place-items:center;position:relative;gap:10px;align-content:center">${mainButton(st)}
              ${st.key === 'free' && rp.ok ? `<button class="btn btn-ghost btn-sm" id="btAsk">${icn('msg', 14)}Ask a friend to host instead</button>` : ''}</div>
          </div>

          <div class="grid g-3">
            <div class="card"><div class="muted small">This PC</div><div style="font:700 22px var(--font);margin:4px 0">${rp.totalGB} GB RAM</div>
              <div class="small ${rp.ok ? 'muted' : ''}" style="${rp.ok ? '' : 'color:var(--gold)'}">${rp.ok ? `The server would get <b>${rp.ramGB} GB</b> (max ${rp.cap} GB), leaving the rest for Minecraft and Windows.` : `Needs at least ${rp.minGB} GB to host. You can still play and ask a friend to host.`}</div></div>
            <div class="card"><div class="muted small">Cloud copy</div><div style="font:700 22px var(--font);margin:4px 0">${b.lastSync ? 'v' + b.lastSync.version : 'not synced yet'}</div>
              <div class="small muted">${b.lastSync ? `Synced ${agoStr(b.lastSync.at)}${b.lastSync.files ? ` &middot; ${b.lastSync.files} file${b.lastSync.files === 1 ? '' : 's'} changed` : ' &middot; already up to date'}.` : 'Syncs when you start or stop hosting.'}${b.hosting ? ` Auto-uploads every ${b.syncMin} min.` : ''}</div></div>
            <div class="card"><div class="muted small">Auto-sleep</div><div style="font:700 22px var(--font);margin:4px 0">${emptyLeft != null && b.emptyForMs > 0 ? 'in ' + rel(emptyLeft) : b.idleMin + ' min'}</div>
              <div class="small muted">${b.hosting ? (b.emptyForMs > 0 ? 'Nobody online - it will save and hand back.' : 'Players online - staying awake.') : 'Stops after this long with nobody online.'}</div></div>
          </div>

          <div class="card"><div class="card-h">${icn('bolt', 18)}<h2>Standby helper</h2></div>
            <div class="row" style="flex-wrap:nowrap;gap:14px;align-items:flex-start"><label class="switch" style="flex:none;margin-top:2px"><input type="checkbox" id="cbStandby" ${b.standby ? 'checked' : ''} ${rp.ok ? '' : 'disabled'}><span></span></label>
              <div style="min-width:0"><b>Start automatically when a friend is waiting</b><div class="muted small" style="margin-top:3px">Leave Blockhost open and this PC hosts whenever someone presses "Ask a friend to host". Needs ${rp.minGB} GB of RAM or more.${rp.ok ? '' : ' This PC is below that.'}</div></div></div></div>

          <div class="card"><div class="card-h">${icn('key', 18)}<h2>Group</h2></div>
            <div class="grid g-3" style="align-items:start">
              <div class="field"><label>Your name in the group</label><input class="input" id="cbName" value="${esc(b.name || '')}" placeholder="${esc(b.me ? b.me.name : '')}" maxlength="40"></div>
              <div class="field"><label>Sleep after nobody is online for (minutes)</label><input class="input mono" type="number" min="5" max="240" id="cbIdle" value="${esc(b.idleMin)}"></div>
              <div class="field"><label>Max RAM for the server (GB)</label><input class="input mono" type="number" min="2" max="16" id="cbRam" value="${esc(b.maxRamGB)}"><div class="hint">Smaller PCs automatically get less.</div></div>
            </div>
            <div class="row" style="gap:8px;margin-top:12px;flex-wrap:wrap">
              <button class="btn btn-primary btn-sm" id="cbSave">${icn('save', 14)}Save</button>
              <button class="btn btn-ghost btn-sm" id="cbTest">${icn('check', 14)}Test connection</button>
              <button class="btn btn-ghost btn-sm" id="cbCode">${icn('key', 14)}${showCode ? 'Hide' : 'Show'} group code</button>
              <button class="btn btn-ghost btn-sm" id="cbLeave" style="color:var(--redstone)">Leave group</button></div>
            ${showCode ? `<div class="field" style="margin-top:12px"><label>Group code (send to friends privately - it contains the group secret)</label><div class="input-group"><input class="input mono" readonly value="${esc(b.code)}" id="cbCodeIn"><button class="btn btn-ghost" id="cbCopy">${icn('copy', 14)}Copy</button></div></div>` : ''}
            ${testing ? `<div class="list" style="margin-top:12px">${testing === 'running' ? '<div class="list-row"><span class="spinner"></span>&nbsp; Testing...</div>' : testing.map(s => `<div class="list-row"><div style="color:${s.ok ? 'var(--emerald)' : 'var(--redstone)'};flex:none">${s.ok ? icn('check') : icn('alert')}</div><div class="grow"><b>${esc(s.name)}</b><div class="muted small">${esc(s.note || '')}${s.ms ? ' &middot; ' + s.ms + ' ms' : ''}</div></div></div>`).join('')}</div>` : ''}
          </div>

          <details class="card"><summary style="cursor:pointer;font-weight:700">How Cloud Host works</summary>
            <div class="muted small" style="margin-top:10px;line-height:1.6">
              One friend's PC runs the server at a time. When someone presses <b>Start server</b>, that PC takes the "baton", downloads only the world files that changed, starts the server with RAM that fits the PC, and shares its address.
              While people play, changed files are uploaded every ${b.syncMin} minutes without stopping the game. When nobody has been online for ${b.idleMin} minutes the server stops, uploads the final world, and gives the baton back.
              Only the baton holder can write to the cloud copy, so two PCs can never overwrite each other. Replaced files are kept in a trash folder for 3 days. If a host's PC dies, the next host continues from the last upload.</div></details>
        </div>`;
        const g = id => $('#' + id, view);
        const cp = g('cpAddr'); if (cp) cp.onclick = () => copyText(cp.parentNode.firstChild.textContent.trim());
        act('btStart', async () => { const r = await post('/api/baton/start'); if (r.ok === false) { if (r.code === 'BUSY') toast(r.error, 'info'); else if (r.code === 'JAVA') window.BH.javaModal(r.need); else throw new Error(r.error); } });
        act('btRetry', () => post('/api/baton/stop'));
        const bj = g('btJava'); if (bj) bj.onclick = () => window.BH.javaModal(25);
        act('btStop', async () => { if (await confirmBox({ title: 'Stop and save?', text: 'Everyone is disconnected, the world is uploaded, and the baton is released so a friend can host.', ok: 'Stop & save' })) await post('/api/baton/stop'); });
        act('btAsk', async () => { const r = await post('/api/baton/request'); toast(r.remote && r.remote.wanted ? 'Your friends\' standby PCs will start the server' : 'Request sent', 'ok'); });
        const sb = g('cbStandby'); if (sb) sb.onchange = async () => { try { await post('/api/baton/standby', { on: sb.checked }); } catch (e) { toast(e.message, 'err'); } };
        act('cbSave', async () => { await post('/api/baton/settings', { name: g('cbName').value, idleMin: g('cbIdle').value, maxRamGB: g('cbRam').value }); toast('Saved', 'ok'); });
        act('cbTest', async () => { testing = 'running'; draw(); testing = (await post('/api/baton/test')).steps; });
        const cc = g('cbCode'); if (cc) cc.onclick = () => { showCode = !showCode; draw(); };
        const cy = g('cbCopy'); if (cy) cy.onclick = () => copyText(b.code);
        act('cbLeave', async () => { if (await confirmBox({ title: 'Leave this group?', text: 'This PC stops using Cloud Host. Your local world files stay here as they are.', ok: 'Leave', danger: true })) { await post('/api/baton/leave'); showCode = false; testing = null; } });
      };

      const cmd = c => `<div class="input-group" style="margin-top:6px"><input class="input mono" readonly value="${esc(c)}"><button class="btn btn-ghost" data-copy="${esc(c)}">${icn('copy', 14)}</button></div>`;
      const drawSetup = () => {
        view.innerHTML = `<div class="stack">
          <div class="card hero cloud-hero" style="--state:var(--amethyst)"><div style="position:relative;min-width:0">
            <div class="eyebrow">Free &middot; no always-on PC &middot; no VPS</div>
            <h2 style="margin:6px 0 6px;font-size:26px;letter-spacing:-.4px">Let your friends' PCs host the server</h2>
            <div class="muted" style="max-width:640px">The world lives in a free Cloudflare account. When someone wants to play, their PC downloads the latest world, runs the server (4 GB max, sized to the PC) and shares it. After ${30} minutes with nobody online it saves, uploads and sleeps.</div></div></div>

          <div class="grid g-2">
            <div class="card"><div class="card-h">${icn('users', 18)}<h2>I have a group code</h2></div>
              <div class="muted small" style="margin-bottom:10px">Your friend who created the group sends you a code that starts with <b>bh1.</b></div>
              <div class="field"><label>Group code</label><input class="input mono" id="jcCode" placeholder="bh1...."></div>
              <button class="btn btn-primary" id="jcGo" style="margin-top:12px">Join group</button></div>

            <div class="card"><div class="card-h">${icn('crown', 18)}<h2>I'm the owner - create the group</h2></div>
              <ol class="muted small" style="margin:0 0 6px 18px;padding:0;line-height:1.65">
                <li>Make a free account at <a href="https://dash.cloudflare.com/sign-up" target="_blank" rel="noopener">cloudflare.com</a>. The default setup uses only the free Workers plan (R2 is optional).</li>
                <li>Open a terminal in the <b>dashboard\\cloud</b> folder (needs <a href="https://nodejs.org" target="_blank" rel="noopener">Node.js</a>) and run these, in order:
                  ${cmd('npx wrangler login')}${cmd('npx wrangler deploy')}${cmd('npx wrangler secret put GROUP_SECRET')}
                  <div class="hint" style="margin-top:6px">When it asks for the secret, paste this one: <b class="mono" id="gsVal">${esc(secret)}</b> <button class="btn btn-ghost btn-sm" data-copy="${esc(secret)}">${icn('copy', 12)}</button></div></li>
                <li>Paste the address <code>deploy</code> printed (ends with <b>workers.dev</b>):</li></ol>
              <div class="field"><input class="input mono" id="cwUrl" placeholder="https://blockhost-baton.yourname.workers.dev"></div>
              <button class="btn btn-primary" id="cwGo" style="margin-top:12px">${icn('upload', 14)}Upload my world &amp; create group</button>
              <div class="muted small" style="margin-top:8px">The server must be stopped while the world uploads for the first time.</div></div>
          </div></div>`;
        const g = id => $('#' + id, view);
        $$('[data-copy]', view).forEach(el => el.onclick = () => copyText(el.dataset.copy));
        act('jcGo', async () => { await post('/api/baton/join', { code: g('jcCode').value }); toast('Joined the group', 'ok'); });
        act('cwGo', async () => {
          const url = g('cwUrl').value.trim();
          if (!/^(https:\/\/|http:\/\/(localhost|127\.0\.0\.1))\S+$/.test(url)) throw new Error('Paste the https address printed by "npx wrangler deploy".');
          await post('/api/baton/seed', { url, secret });
          toast('Uploading your world - progress is shown at the bottom', 'info');
        });
      };

      const draw = () => {
        if (!b) { view.innerHTML = '<div class="card"><div class="skeleton" style="width:40%"></div></div>'; return; }
        const focus = document.activeElement && document.activeElement.id, vals = {};
        $$('input', view).forEach(i => { if (i.id) vals[i.id] = i.value; });
        if (b.configured) drawJoined(); else drawSetup();
        for (const [id, v] of Object.entries(vals)) { const el = $('#' + id, view); if (el && el.tagName === 'INPUT' && el.type !== 'checkbox' && !el.readOnly) el.value = v; }
        if (focus) { const f = $('#' + focus, view); if (f && f.focus) { try { f.focus(); } catch { /* ignore */ } } }
      };

      draw(); load().then(refresh);
      return () => tick.forEach(clearInterval);
    },
  };
})();
