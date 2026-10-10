/* Blockhost dashboard — core (helpers, live connection, router, modals). Pages live in pages.js */
(() => {
  'use strict';

  // ---------------------------------------------------------------- helpers
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  const ICONS = {
    sync: '<path d="M21 12a9 9 0 0 1-15.5 6.2L3 16"/><path d="M3 12a9 9 0 0 1 15.5-6.2L21 8"/><path d="M21 3v5h-5"/><path d="M3 21v-5h5"/>',
    home: '<path d="M3 10.5 12 3l9 7.5V20a1 1 0 0 1-1 1h-5v-7H9v7H4a1 1 0 0 1-1-1z"/>',
    terminal: '<path d="m4 17 6-6-6-6"/><path d="M12 19h8"/>',
    users: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>',
    sliders: '<path d="M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M1 14h6M9 8h6M17 16h6"/>',
    rules: '<path d="m3 6 2 2 3-3"/><path d="m3 13 2 2 3-3"/><path d="m3 20 2 2 3-3" transform="translate(0 -2)"/><path d="M12 6h9M12 13h9M12 19h9"/>',
    box: '<path d="M21 8 12 3 3 8v8l9 5 9-5z"/><path d="m3 8 9 5 9-5"/><path d="M12 13v8"/>',
    archive: '<rect x="3" y="4" width="18" height="4" rx="1"/><path d="M5 8v11a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8"/><path d="M10 12h4"/>',
    globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18"/><path d="M12 3a14 14 0 0 1 0 18a14 14 0 0 1 0-18"/>',
    folder: '<path d="M3 6.5A1.5 1.5 0 0 1 4.5 5H9l2 2h8.5A1.5 1.5 0 0 1 21 8.5v9a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 17.5z"/>',
    file: '<path d="M14 3H6.5A1.5 1.5 0 0 0 5 4.5v15A1.5 1.5 0 0 0 6.5 21h11a1.5 1.5 0 0 0 1.5-1.5V8z"/><path d="M14 3v5h5"/>',
    logs: '<path d="M14 3H6.5A1.5 1.5 0 0 0 5 4.5v15A1.5 1.5 0 0 0 6.5 21h11a1.5 1.5 0 0 0 1.5-1.5V8z"/><path d="M14 3v5h5M9 13h6M9 17h4"/>',
    gear: '<circle cx="12" cy="12" r="3.2"/><path d="M12 2.5v3M12 18.5v3M4.6 4.6l2.1 2.1M17.3 17.3l2.1 2.1M2.5 12h3M18.5 12h3M4.6 19.4l2.1-2.1M17.3 6.7l2.1-2.1"/>',
    power: '<path d="M12 3v9"/><path d="M18.4 6.6a9 9 0 1 1-12.8 0"/>',
    play: '<path d="M7 4.5v15l12.5-7.5z"/>',
    stop: '<rect x="6" y="6" width="12" height="12" rx="1.5"/>',
    restart: '<path d="M3 12a9 9 0 1 0 2.7-6.4L3 8"/><path d="M3 3v5h5"/>',
    skull: '<path d="M12 3a8 8 0 0 0-5 14.2V20h10v-2.8A8 8 0 0 0 12 3z"/><circle cx="9" cy="11" r="1.4"/><circle cx="15" cy="11" r="1.4"/><path d="M10 20v-2M14 20v-2"/>',
    copy: '<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15H4.5A1.5 1.5 0 0 1 3 13.5v-9A1.5 1.5 0 0 1 4.5 3h9A1.5 1.5 0 0 1 15 4.5V5"/>',
    sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
    moon: '<path d="M20.5 13.5A8.5 8.5 0 1 1 10.5 3.5a6.5 6.5 0 0 0 10 10z"/>',
    cloud: '<path d="M7 18a4.5 4.5 0 0 1-.6-9A6 6 0 0 1 18 8.5a4.8 4.8 0 0 1-.5 9.5z"/>',
    rain: '<path d="M7 15a4.5 4.5 0 0 1-.6-9A6 6 0 0 1 18 5.5a4.8 4.8 0 0 1-.5 9.5z"/><path d="M8 18v3M12 18v3M16 18v3"/>',
    bolt: '<path d="M13 2 4 14h7l-1 8 9-12h-7z"/>',
    save: '<path d="M5 3h11l5 5v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z"/><path d="M7 3v5h8M7 21v-7h10v7"/>',
    megaphone: '<path d="M3 11v2a1 1 0 0 0 1 1h3l7 5V5L7 10H4a1 1 0 0 0-1 1z"/><path d="M18 8.5a5 5 0 0 1 0 7"/>',
    download: '<path d="M12 3v12M7 10l5 5 5-5M4 21h16"/>',
    upload: '<path d="M12 21V9M7 14l5-5 5 5M4 3h16"/>',
    trash: '<path d="M3 6h18M8 6V4h8v2M6 6l1 15h10l1-15"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    x: '<path d="M6 6l12 12M18 6 6 18"/>',
    check: '<path d="m5 12.5 4.5 4.5L19 7.5"/>',
    search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
    crown: '<path d="M3 7l4.5 5L12 5l4.5 7L21 7l-2 12H5z"/>',
    shield: '<path d="M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z"/>',
    ban: '<circle cx="12" cy="12" r="9"/><path d="m5.6 5.6 12.8 12.8"/>',
    link: '<path d="M10 14a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-1 1"/><path d="M14 10a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l1-1"/>',
    cpu: '<rect x="6" y="6" width="12" height="12" rx="2"/><rect x="9.5" y="9.5" width="5" height="5"/><path d="M9 2v3M15 2v3M9 19v3M15 19v3M2 9h3M2 15h3M19 9h3M19 15h3"/>',
    memory: '<rect x="2.5" y="7" width="19" height="10" rx="1.5"/><path d="M7 7v10M11 7v10M15 7v10M19 17v2M5 17v2"/>',
    heart: '<path d="M12 20.5s-7.5-4.6-9.3-9.3A5 5 0 0 1 12 6.4a5 5 0 0 1 9.3 4.8C19.5 15.9 12 20.5 12 20.5z"/>',
    food: '<path d="M16.5 3.5a4.5 4.5 0 0 1 2 8.5L13 17.5 7 11.5l5.5-5.5a4.5 4.5 0 0 1 4-2.5z"/><path d="M7 11.5 3.5 15a2 2 0 0 0 2.8 2.8M9.5 17 6 20.5"/>',
    kick: '<path d="M14 3h5a1 1 0 0 1 1 1v16a1 1 0 0 1-1 1h-5"/><path d="m10 17 5-5-5-5M15 12H3"/>',
    gamepad: '<rect x="2" y="7" width="20" height="11" rx="4"/><path d="M6.5 12.5h4M8.5 10.5v4M15.5 12h.01M18 11h.01"/>',
    pin: '<path d="M12 21.5s7-6.2 7-11.5a7 7 0 1 0-14 0c0 5.3 7 11.5 7 11.5z"/><circle cx="12" cy="10" r="2.5"/>',
    gift: '<rect x="3" y="8" width="18" height="4" rx="1"/><path d="M5 12v9h14v-9M12 8v13M12 8S9.5 3 7.5 4.5 9 8 12 8zM12 8s2.5-5 4.5-3.5S15 8 12 8z"/>',
    eraser: '<path d="m7 21-4.3-4.3a1.5 1.5 0 0 1 0-2.1L13.4 4a1.5 1.5 0 0 1 2.1 0l4.4 4.4a1.5 1.5 0 0 1 0 2.1L10 21z"/><path d="M22 21H7M5.5 11.5l7 7"/>',
    msg: '<path d="M20.5 15a2 2 0 0 1-2 2H7.5l-4 4V5a2 2 0 0 1 2-2h13a2 2 0 0 1 2 2z"/>',
    alert: '<path d="M12 9v4M12 17h.01"/><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/>',
    info: '<circle cx="12" cy="12" r="9"/><path d="M12 16v-5M12 8h.01"/>',
    sparkle: '<path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z"/><path d="M19 17l.7 1.8 1.8.7-1.8.7-.7 1.8-.7-1.8-1.8-.7 1.8-.7z"/>',
    menu: '<path d="M4 6h16M4 12h16M4 18h16"/>',
    tunnel: '<path d="M4 20V10a8 8 0 0 1 16 0v10"/><path d="M8 20v-9a4 4 0 0 1 8 0v9M2 20h20"/>',
    coffee: '<path d="M17 8h1a4 4 0 0 1 0 8h-1"/><path d="M3 8h14v9a4 4 0 0 1-4 4H7a4 4 0 0 1-4-4z"/><path d="M6 2v2M10 2v2M14 2v2"/>',
    broom: '<path d="M19.5 3.5 12 11"/><path d="M8.5 10.5 4 15l5 5 4.5-4.5z"/><path d="m6.5 17.5 2-2M9 20l1.5-1.5"/>',
    gauge: '<path d="M12 14l4-6"/><path d="M3.5 18a9 9 0 1 1 17 0z"/>',
    java: '<path d="M8 17c-2 1-2 2 4 2s6-1 4-2M9 14c-1.5 1 0 2 3 2s4.5-1 3-2M13 3c3 3-3 4 0 8M10 6c2 2-2 3 0 5"/>',
    key: '<circle cx="7.5" cy="15.5" r="4.5"/><path d="m10.7 12.3 9.8-9.8M17 6l3 3M14.5 8.5l2 2"/>',
    external: '<path d="M14 4h6v6M20 4l-9 9"/><path d="M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/>',
    folderPlus: '<path d="M3 6.5A1.5 1.5 0 0 1 4.5 5H9l2 2h8.5A1.5 1.5 0 0 1 21 8.5v9a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 17.5z"/><path d="M12 10v6M9 13h6"/>',
    image: '<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-5-5L5 21"/>',
    edit: '<path d="M4 20h4L19 9l-4-4L4 16z"/><path d="m13.5 6.5 4 4"/>',
    clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  };
  const ic = (n, cls = '') => `<svg class="${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[n] || ''}</svg>`;

  const fmtBytes = b => { if (!b) return '0 B'; const u = ['B', 'KB', 'MB', 'GB', 'TB']; const i = Math.min(4, Math.floor(Math.log(b) / Math.log(1024))); return (b / 1024 ** i).toFixed(i > 1 ? 1 : 0) + ' ' + u[i]; };
  const fmtDur = ms => { if (!ms || ms < 0) return '0s'; const s = Math.floor(ms / 1000), d = Math.floor(s / 86400), h = Math.floor(s % 86400 / 3600), m = Math.floor(s % 3600 / 60); if (d) return `${d}d ${h}h`; if (h) return `${h}h ${m}m`; if (m) return `${m}m ${s % 60}s`; return `${s}s`; };
  const fmtDate = t => new Date(t).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  const ago = t => { const s = (Date.now() - t) / 1000; if (s < 60) return 'just now'; if (s < 3600) return Math.floor(s / 60) + ' min ago'; if (s < 86400) return Math.floor(s / 3600) + ' h ago'; return Math.floor(s / 86400) + ' d ago'; };
  const titleCase = s => String(s).replace(/^minecraft:/, '').replace(/[_\-.]+/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2').replace(/\b\w/g, c => c.toUpperCase());
  const store = {
    get(k, d) { try { const v = localStorage.getItem('bh.' + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
    set(k, v) { try { localStorage.setItem('bh.' + k, JSON.stringify(v)); } catch { /* ignore */ } },
  };

  function avatar(name, cls = '') {
    const n = String(name || '?');
    return `<div class="avatar ${cls}">${esc(n.replace(/[^a-z0-9]/gi, '').charAt(0).toUpperCase() || '?')}<img alt="" loading="lazy" src="https://mc-heads.net/avatar/${encodeURIComponent(n.replace(/[^\w]/g, ''))}/64" onerror="this.remove()"></div>`;
  }

  // Minecraft § formatting -> HTML
  const MC_COLORS = { 0: '#000000', 1: '#0000AA', 2: '#00AA00', 3: '#00AAAA', 4: '#AA0000', 5: '#AA00AA', 6: '#FFAA00', 7: '#AAAAAA', 8: '#555555', 9: '#5555FF', a: '#55FF55', b: '#55FFFF', c: '#FF5555', d: '#FF55FF', e: '#FFFF55', f: '#FFFFFF' };
  function mcFormat(text) {
    let out = '', color = '#AAAAAA', bold = false, italic = false, under = false, strike = false;
    const parts = String(text).replace(/\\u00a7/gi, '§').replace(/\\n/g, '\n').split(/(§[0-9a-fk-or])/i);
    for (const p of parts) {
      const m = p.match(/^§([0-9a-fk-or])$/i);
      if (m) {
        const c = m[1].toLowerCase();
        if (MC_COLORS[c]) { color = MC_COLORS[c]; bold = italic = under = strike = false; }
        else if (c === 'l') bold = true; else if (c === 'o') italic = true; else if (c === 'n') under = true; else if (c === 'm') strike = true;
        else if (c === 'r') { color = '#AAAAAA'; bold = italic = under = strike = false; }
        continue;
      }
      if (!p) continue;
      const deco = [under && 'underline', strike && 'line-through'].filter(Boolean).join(' ');
      out += `<span style="color:${color};${bold ? 'font-weight:700;' : ''}${italic ? 'font-style:italic;' : ''}${deco ? 'text-decoration:' + deco : ''}">${esc(p)}</span>`;
    }
    return out;
  }
  const stripMc = t => String(t || '').replace(/\\u00a7./gi, '').replace(/§./g, '');

  // ---------------------------------------------------------------- API
  async function api(path, opts = {}) {
    const init = { method: opts.method || 'GET', headers: { 'X-Blockhost': '1' } };
    if (opts.raw) { init.body = opts.raw; init.headers['Content-Type'] = 'application/octet-stream'; }
    else if (opts.body !== undefined) { init.body = JSON.stringify(opts.body); init.headers['Content-Type'] = 'application/json'; }
    let res;
    for (let attempt = 0; ; attempt++) {
      try { res = await fetch(path, init); break; }
      catch (err) {
        // connection dropped before a reply: retry reads once; never auto-repeat actions
        if (attempt === 0 && init.method === 'GET') { await new Promise(r => setTimeout(r, 700)); continue; }
        const e = new Error('Can\'t reach the Blockhost program. Check the black "Blockhost" window is still open (if you clicked inside it, press Esc), then try again.');
        e.network = true; throw e;
      }
    }
    let data = null;
    try { data = await res.json(); } catch { /* not json */ }
    if (!res.ok) { const e = new Error((data && data.error) || `Request failed (${res.status})`); e.code = data && data.code; throw e; }
    return data;
  }
  const post = (p, body) => api(p, { method: 'POST', body: body || {} });

  async function cmd(c, quiet) {
    try { await post('/api/command', { command: c }); if (!quiet) toast(`Sent: /${c}`, 'ok'); return true; }
    catch (e) { toast(e.message, 'err'); return false; }
  }

  // ---------------------------------------------------------------- toasts, modals, taskbar
  const recentToasts = new Map();
  function toast(msg, type = 'ok', ms = 3200) {
    // collapse repeats of the same message into one toast with a counter
    const key = type + '|' + msg, prev = recentToasts.get(key);
    if (prev && prev.isConnected) { prev.dataset.n = (+prev.dataset.n || 1) + 1; prev.querySelector('div').textContent = `${msg} (×${prev.dataset.n})`; return; }
    const el = document.createElement('div');
    recentToasts.set(key, el);
    el.className = `toast ${type}`;
    el.innerHTML = `${ic(type === 'err' ? 'alert' : type === 'info' ? 'info' : 'check')}<div>${esc(msg)}</div>`;
    $('#toasts').appendChild(el);
    setTimeout(() => { el.style.opacity = '0'; el.style.transition = 'opacity .3s'; setTimeout(() => el.remove(), 300); }, ms);
  }

  /** Open a modal. html = inner HTML. bind(root, close) wires events. Returns close(). */
  function modal(html, bind, wide) {
    const root = $('#modalRoot');
    root.innerHTML = `<div class="modal ${wide ? 'wide' : ''}" role="dialog" aria-modal="true">${html}</div>`;
    root.classList.add('open');
    const close = () => { root.classList.remove('open'); root.innerHTML = ''; document.removeEventListener('keydown', onKey); };
    const onKey = e => { if (e.key === 'Escape') close(); };
    document.addEventListener('keydown', onKey);
    root.onclick = e => { if (e.target === root) close(); };
    $$('[data-close]', root).forEach(b => b.onclick = close);
    if (bind) bind(root.firstElementChild, close);
    const f = $('input,textarea,select', root); if (f) setTimeout(() => f.focus(), 30);
    return close;
  }

  /** confirm({title, text, ok, danger, input:{label, placeholder, value, required, mustEqual}}) -> Promise<false|true|string> */
  function confirmBox(o) {
    return new Promise(resolve => {
      let done = false;
      const inp = o.input ? `<div class="field" style="margin-bottom:4px">${o.input.label ? `<label>${esc(o.input.label)}</label>` : ''}<input class="input" id="cfIn" placeholder="${esc(o.input.placeholder || '')}" value="${esc(o.input.value || '')}"></div>` : '';
      const close = modal(`<h3>${esc(o.title)}</h3>${o.text ? `<p>${o.text}</p>` : ''}${inp}
        <div class="modal-actions"><button class="btn btn-ghost" data-close>Cancel</button><button class="btn ${o.danger ? 'btn-danger' : 'btn-primary'}" id="cfOk">${esc(o.ok || 'Confirm')}</button></div>`, (m) => {
        const ok = $('#cfOk', m), input = $('#cfIn', m);
        const valid = () => !input || ((!o.input.required || input.value.trim()) && (!o.input.mustEqual || input.value.trim() === o.input.mustEqual));
        if (input) { ok.disabled = !valid(); input.oninput = () => ok.disabled = !valid(); input.onkeydown = e => { if (e.key === 'Enter' && valid()) ok.click(); }; }
        ok.onclick = () => { done = true; const v = input ? input.value.trim() : true; close(); resolve(v); };
      });
      const obs = new MutationObserver(() => { if (!$('#modalRoot').classList.contains('open')) { obs.disconnect(); if (!done) resolve(false); } });
      obs.observe($('#modalRoot'), { attributes: true, attributeFilter: ['class'] });
      void close;
    });
  }

  let taskHideTimer = null;
  function renderTask(t) {
    const bar = $('#taskbar');
    if (!t) { bar.hidden = true; return; }
    clearTimeout(taskHideTimer);
    bar.hidden = false;
    bar.classList.toggle('err', !!t.error);
    bar.innerHTML = `<div class="t-head"><span>${t.done ? (t.error ? ic('alert') : '') : ''} ${esc(t.title)}</span><span class="muted small">${t.done ? (t.error ? 'Failed' : 'Done') : (t.pct ? t.pct + '%' : '<span class="spinner" style="display:inline-block;vertical-align:middle"></span>')}</span></div>
      <div class="t-msg">${esc(t.error || t.msg)}</div><div class="meter"><i style="width:${t.done ? 100 : Math.max(4, t.pct || 0)}%"></i></div>`;
    if (t.done) taskHideTimer = setTimeout(() => { bar.hidden = true; }, t.error ? 9000 : 3500);
  }

  // ---------------------------------------------------------------- live state
  const S = { snap: null, lines: [], history: [], stats: null, connected: false, lastTaskId: null };
  const listeners = new Set();
  const emit = (kind, data) => listeners.forEach(fn => { try { fn(kind, data); } catch (e) { console.error(e); } });

  function applySnap(snap) {
    S.snap = snap;
    document.body.className = document.body.className.replace(/\bstate-\w+/g, '').trim() + ' state-' + snap.state;
    const labels = { offline: 'Offline', starting: 'Starting', online: 'Online', stopping: 'Stopping', crashed: 'Crashed' };
    $('#topState span').textContent = (labels[snap.state] || snap.state) + (snap.remoteHost ? ' · remote' : '');
    renderRemoteBar(snap);
    const addr = snap.address;
    $('#topAddress').innerHTML = addr ? `${ic('copy')}${esc(addr)}` : `${ic('link')}Set address`;
    $('#footVersion').textContent = snap.installedVersion || 'none';
    $('#footRpc').textContent = snap.rpc ? 'connected' : (snap.state === 'online' ? 'log mode' : '-');
    $('#brandSub').textContent = snap.state === 'online' ? `${snap.onlineCount ?? snap.players.length}/${snap.maxPlayers} online` : snap.external ? 'running outside' : 'local server';
    renderNav();
  }

  // A friend's PC hosts the server: say so on every page, and keep the owner in control
  function renderRemoteBar(snap) {
    const bar = $('#remoteBar'); if (!bar) return;
    const r = snap && snap.remoteHost;
    document.body.classList.toggle('has-remote', !!r);
    if (!r) { bar.hidden = true; bar.innerHTML = ''; return; }
    const n = snap.onlineCount ?? snap.players.length;
    const sub = r.needsUpdate ? 'You can see who is online, but to run commands from here press "Update cloud" once in Cloud Host.'
      : `${n} online · console, kick, op, ban and Stop all work from here. Commands reach their PC within a few seconds.`;
    const html = `<div class="rb-ico">${ic('cloud')}</div><div class="rb-text"><b>${esc(r.name)} is hosting from their PC</b><span>${esc(sub)}</span></div>` +
      (r.needsUpdate ? `<a class="btn btn-primary btn-sm" href="#/cloud">Open Cloud Host</a>` : `<button class="btn btn-ghost btn-sm" id="rbStop">${ic('stop')}Stop &amp; hand back</button>`);
    if (bar.dataset.h !== html) { bar.dataset.h = html; bar.innerHTML = html; }
    bar.hidden = false;
    const b = $('#rbStop', bar); if (b) b.onclick = () => stopServer();
  }

  // Save resources: disconnect from the live feed when the tab is hidden for a while (the server then
  // stops its stats polling), reconnect instantly when you come back.
  let es = null, hideTimer = null;
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) hideTimer = setTimeout(() => { if (es) { es.close(); es = null; S.connected = false; } }, 30000);
    else { clearTimeout(hideTimer); if (!es) connect(); }
  });

  function connect() {
    es = new EventSource('/api/events');
    es.addEventListener('hello', e => {
      showGone(false);
      const d = JSON.parse(e.data);
      S.connected = true; S.lines = d.lines; S.history = d.history || [];
      applySnap(d.snapshot); S.stats = d.snapshot.stats;
      if (d.snapshot.task && !d.snapshot.task.done) renderTask(d.snapshot.task);
      emit('hello');
      router();
    });
    es.addEventListener('state', e => { const prev = S.snap && S.snap.state; applySnap(JSON.parse(e.data)); emit('state', prev); });
    es.addEventListener('line', e => { const l = JSON.parse(e.data); S.lines.push(l); if (S.lines.length > 3000) S.lines.shift(); emit('line', l); });
    es.addEventListener('players', e => { if (S.snap) { const d = JSON.parse(e.data); S.snap.players = Array.isArray(d) ? d : d.players; S.snap.onlineCount = Array.isArray(d) ? S.snap.players.length : d.count; $('#brandSub').textContent = S.snap.state === 'online' ? `${S.snap.onlineCount}/${S.snap.maxPlayers} online` : 'local server'; renderNav(); } emit('players'); });
    es.addEventListener('baton', e => { S.baton = JSON.parse(e.data); emit('baton'); });
    es.addEventListener('sync', e => { S.sync = JSON.parse(e.data); emit('sync'); });
    es.addEventListener('stats', e => {
      const s = JSON.parse(e.data); S.stats = s;
      S.history.push({ t: s.t, cpu: s.cpu, mem: s.serverMem, players: S.snap ? S.snap.players.length : 0 });
      if (S.history.length > 120) S.history.shift();
      emit('stats');
    });
    es.addEventListener('task', e => {
      const t = JSON.parse(e.data); renderTask(t);
      if (t.done && S.lastTaskId !== t.id) {
        S.lastTaskId = t.id;
        if (t.error) toast(`${t.title} failed: ${t.error}`, 'err', 7000); else toast(`${t.title} finished`, 'ok');
        emit('taskdone', t);
      }
    });
    es.onerror = () => {
      if (document.hidden) return;
      clearTimeout(S.goneTimer);
      S.goneTimer = setTimeout(async () => {
        try { await fetch('/api/state', { cache: 'no-store' }); } catch { showGone(true); }
      }, 2500);
      if (S.connected) { S.connected = false; toast('Lost connection to the dashboard - is the black window still open?', 'err', 6000); }
      $('#topState span').textContent = 'Reconnecting…';
    };
  }

  function showGone(on) {
    let el = document.getElementById('goneOverlay');
    if (!on) { if (el) el.remove(); return; }
    if (el) return;
    el = document.createElement('div'); el.id = 'goneOverlay'; el.className = 'gone';
    el.innerHTML = `<div class="gone-card"><div class="inst-ico" style="margin:0 auto 14px">${ic('power')}</div><h2>Blockhost isn't running</h2>
      <p>The black <b>Blockhost</b> window was closed (or crashed), so this page can't control the server.</p>
      <p>Double-click <b>Start Dashboard.bat</b> (or the <b>Minecraft Server</b> shortcut on your desktop). This page reconnects by itself.</p>
      <div class="row" style="justify-content:center;margin-top:14px"><span class="spinner"></span><span class="muted small">Waiting for Blockhost…</span></div></div>`;
    document.body.appendChild(el);
  }

  // ---------------------------------------------------------------- router + shell
  const pages = {};
  const NAV = [
    { group: 'Server' },
    { id: 'overview', label: 'Overview', icon: 'home' },
    { id: 'console', label: 'Console', icon: 'terminal' },
    { id: 'players', label: 'Players', icon: 'users' },
    { id: 'cloud', label: 'Cloud Host', icon: 'cloud' },
    { group: 'Configure' },
    { id: 'options', label: 'Options', icon: 'sliders' },
    { id: 'gamerules', label: 'Game rules', icon: 'rules' },
    { id: 'packs', label: 'Packs & shaders', icon: 'image' },
    { id: 'sync', label: 'Live Sync', icon: 'sync' },
    { id: 'software', label: 'Software', icon: 'box' },
    { group: 'Data' },
    { id: 'backups', label: 'Backups', icon: 'archive' },
    { id: 'world', label: 'World', icon: 'globe' },
    { id: 'files', label: 'Files', icon: 'folder' },
    { id: 'logs', label: 'Logs', icon: 'logs' },
    { group: 'Dashboard' },
    { id: 'setup', label: 'Setup wizard', icon: 'sparkle' },
    { id: 'settings', label: 'Settings', icon: 'gear' },
  ];
  let current = null, cleanup = null;

  function renderNav() {
    const s = S.snap || {};
    const upd = s.latestRelease && s.installedVersion && s.latestRelease !== s.installedVersion;
    $('#nav').innerHTML = NAV.map(n => n.group ? `<div class="nav-label">${n.group}</div>` :
      `<a href="#/${n.id}" class="${current === n.id ? 'active' : ''}">${ic(n.icon)}<span>${n.label}</span>${
        n.id === 'players' && (s.onlineCount || (s.players && s.players.length)) ? `<span class="badge">${s.onlineCount || s.players.length}</span>` :
        n.id === 'software' && upd ? `<span class="badge warn">update</span>` : ''}</a>`).join('');
  }

  function router() {
    let id = (location.hash.replace(/^#\/?/, '') || 'overview').split('?')[0];
    if (S.snap && S.snap.needsSetup && (id === 'overview' || !location.hash) && !S.skipSetup) { S.skipSetup = true; id = 'setup'; history.replaceState(null, '', '#/setup'); }
    const page = pages[id] || pages.overview;
    const pid = pages[id] ? id : 'overview';
    if (cleanup) { try { cleanup(); } catch { /* ignore */ } cleanup = null; }
    current = pid;
    listeners.clear();
    renderNav();
    $('#pageTitle').textContent = page.title;
    $('#pageSub').textContent = page.sub || '';
    const view = $('#view');
    view.innerHTML = '';
    view.scrollTop = 0;
    document.body.classList.remove('nav-open');
    if (!S.snap) { view.innerHTML = '<div class="card"><div class="skeleton" style="width:40%"></div></div>'; return; }
    const on = fn => listeners.add(fn);
    cleanup = page.render(view, on) || null;
  }

  function copyText(t) {
    const done = () => toast('Copied ' + t, 'ok');
    if (navigator.clipboard && window.isSecureContext) navigator.clipboard.writeText(t).then(done, () => fallback());
    else fallback();
    function fallback() { const a = document.createElement('textarea'); a.value = t; document.body.appendChild(a); a.select(); try { document.execCommand('copy'); done(); } catch { toast('Copy failed', 'err'); } a.remove(); }
  }

  // ---------------------------------------------------------------- shared flows
  async function startServer() {
    try {
      const r = await post('/api/start');
      if (r && r.ok === false) {
        if (r.code === 'EULA') return eulaModal();
        if (r.code === 'JAVA') return javaModal(r.need);
        if (r.code === 'PORT_BUSY') return portBusyModal(r);
        if (r.code === 'CLOUD') { toast(r.error, 'info', 6500); location.hash = '#/cloud'; return; }
        toast(r.error, 'err');
      }
    } catch (e) { toast(e.message, 'err'); }
  }
  async function stopServer() {
    const n = S.snap.players.length;
    const rh = S.snap.remoteHost;
    if (rh && !(await confirmBox({ title: `Stop ${rh.name}'s server?`, text: `It saves the world to the cloud and hands the server back${n ? `. ${n} player${n > 1 ? 's are' : ' is'} online and will be disconnected` : ''}.`, ok: 'Stop & hand back', danger: true }))) return;
    if (!rh && n && !(await confirmBox({ title: 'Stop the server?', text: `${n} player${n > 1 ? 's are' : ' is'} online and will be disconnected.`, ok: 'Stop server', danger: true }))) return;
    post('/api/stop').catch(e => toast(e.message, 'err'));
  }
  function eulaModal() {
    modal(`<h3>Accept the Minecraft EULA</h3><p>Mojang requires every server owner to agree to the <a href="https://aka.ms/MinecraftEULA" target="_blank" rel="noopener">Minecraft End User License Agreement</a> before the server can run.</p>
      <div class="modal-actions"><button class="btn btn-ghost" data-close>Not now</button><button class="btn btn-success" id="eulaOk">${ic('check')}I agree - start server</button></div>`, (m, close) => {
      $('#eulaOk', m).onclick = async () => { await post('/api/eula'); close(); startServer(); };
    });
  }
  function portBusyModal(r) {
    modal(`<h3>Another server is already running</h3><p>${esc(r.error)}${r.minecraft ? ` It has <b>${r.players}</b> player${r.players === 1 ? '' : 's'} online.` : ''} Two servers can't use the same world and port at once.</p>
      <div class="banner" style="margin-bottom:6px"><div class="b-ico">${ic('info')}</div><div class="b-text"><b>Recommended: let Blockhost stop it</b><span>It asks the other server to save and shut down properly, then starts it here with full control.</span></div></div>
      <div class="modal-actions"><button class="btn btn-ghost" data-close>Cancel</button><button class="btn btn-primary" id="pbGo">${ic('restart')}Stop the other server & start here</button></div>`, (m, close) => {
      $('#pbGo', m).onclick = async () => {
        const b = $('#pbGo', m); b.disabled = true; b.innerHTML = '<span class="spinner"></span> Stopping the other server…';
        try { const x = await post('/api/external/stop'); toast(x.how === 'api' ? 'Other server saved and stopped' : 'Other server stopped'); close(); startServer(); }
        catch (e) { toast(e.message, 'err', 8000); b.disabled = false; b.innerHTML = 'Try again'; }
      };
    });
  }
  function javaModal(need) {
    modal(`<h3>Java ${need} is needed</h3><p>This Minecraft version needs Java ${need} or newer, and it isn't installed. Blockhost can install Eclipse Temurin ${need} for you with winget (Windows will ask for permission).</p>
      <div class="modal-actions"><button class="btn btn-ghost" data-close>Cancel</button><a class="btn btn-ghost" href="https://adoptium.net/temurin/releases/?version=${need}" target="_blank" rel="noopener">${ic('external')}Download manually</a><button class="btn btn-primary" id="javaOk">${ic('download')}Install Java ${need}</button></div>`, (m, close) => {
      $('#javaOk', m).onclick = async () => { try { await post('/api/java/install', { need }); close(); } catch (e) { toast(e.message, 'err'); } };
    });
  }

  function sparkline(values, color, max) {
    const w = 240, h = 40;
    if (!values.length) return `<svg class="spark" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none"></svg>`;
    const m = max || Math.max(1, ...values);
    const pts = values.map((v, i) => [values.length === 1 ? w : (i / (values.length - 1)) * w, h - 3 - (v / m) * (h - 6)]);
    const d = pts.map((p, i) => (i ? 'L' : 'M') + p[0].toFixed(1) + ' ' + p[1].toFixed(1)).join(' ');
    const id = 'g' + Math.random().toString(36).slice(2, 7);
    return `<svg class="spark" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none"><defs><linearGradient id="${id}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${color}" stop-opacity=".35"/><stop offset="1" stop-color="${color}" stop-opacity="0"/></linearGradient></defs><path d="${d} L${w} ${h} L0 ${h}Z" fill="url(#${id})"/><path d="${d}" fill="none" stroke="${color}" stroke-width="2" vector-effect="non-scaling-stroke" stroke-linejoin="round"/></svg>`;
  }

  // ---------------------------------------------------------------- init
  function init() {
    $('#menuBtn').innerHTML = ic('menu');
    $('#menuBtn').onclick = () => document.body.classList.toggle('nav-open');
    $('#topAddress').onclick = () => { if (S.snap && S.snap.address) copyText(S.snap.address); else location.hash = '#/settings'; };
    window.addEventListener('hashchange', router);
    renderNav();
    router();
    connect();
  }

  window.BH = { $, $$, esc, ic, api, post, cmd, toast, modal, confirmBox, fmtBytes, fmtDur, fmtDate, ago, titleCase, avatar, mcFormat, stripMc, store, S, pages, startServer, stopServer, eulaModal, javaModal, sparkline, copyText, router, init };
})();
