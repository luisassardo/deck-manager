/**
 * annotate.js — live annotation for the shared slideshow window.
 *
 * Injected by server.mjs into every deck page; active only in the clean
 * slideshow window (?_dmshow=1) — the one you screen-share.
 *
 *   L / P      laser pointer / pen
 *   B          blackout (and W for a white screen)
 *   E          erase this slide's ink   ·  ⇧E erase every slide
 *   C          cycle ink colour
 *   Esc        put the tools away
 *
 * The presenter window can drive all of this remotely over the CUE bus
 * (POST /api/cue → SSE): moving the mouse across the presenter's current-slide
 * preview moves the laser here, and dragging draws. Ink is kept per slide in
 * normalized coordinates, so it survives window resizes and comes back when you
 * navigate away and return. Nothing is written to the deck file — annotation is
 * ephemeral by design.
 */
(() => {
  'use strict';
  if (!/[?&]_dmshow=/.test(location.search)) return;
  if (!location.pathname.startsWith('/files/')) return;

  const DECK = decodeURIComponent(location.pathname.slice('/files/'.length));
  const COLORS = ['#FFC24B', '#F43F5E', '#4F8EF7', '#10B981', '#ffffff'];
  const LASER = '#FF3B30';

  let stage = null;
  /** Always a valid slide index — the component reports null/NaN briefly
   *  while it is upgrading, and that must never become an ink key. */
  const curIndex = () => {
    const i = stage && stage.index;
    return (typeof i === 'number' && Number.isFinite(i)) ? i : 0;
  };
  let tool = 'off';                 // 'off' | 'laser' | 'pen'
  let color = COLORS[0];
  let blackout = null;              // null | 'black' | 'white'
  const ink = new Map();            // slide index → [{color,w,pts:[{x,y}]}]
  let stroke = null;                // stroke being drawn
  let laser = null;                 // {x,y} normalized, or null
  let laserFade = 0;
  let raf = 0;

  // ---------------------------------------------------------------- canvas
  const cv = document.createElement('canvas');
  cv.id = 'cue-ink';
  const ctx = cv.getContext('2d');
  const shade = document.createElement('div');
  shade.id = 'cue-blackout';

  const css = document.createElement('style');
  css.textContent = `
    #cue-ink { position: fixed; inset: 0; z-index: 2147482000; pointer-events: none; }
    #cue-ink[data-draw] { pointer-events: auto; cursor: crosshair; }
    #cue-blackout { position: fixed; inset: 0; z-index: 2147482500; display: none; background: #000; }
    #cue-blackout[data-on="white"] { display: block; background: #fff; }
    #cue-blackout[data-on="black"] { display: block; }
    #cue-bar { position: fixed; bottom: 18px; left: 50%; transform: translateX(-50%);
      z-index: 2147483000; display: flex; gap: 6px; padding: 7px 9px; border-radius: 10px;
      background: rgba(10,14,26,.9); border: 1px solid rgba(255,255,255,.16);
      -webkit-backdrop-filter: blur(8px); backdrop-filter: blur(8px);
      opacity: 0; transition: opacity .18s; pointer-events: none; }
    #cue-bar[data-show] { opacity: 1; pointer-events: auto; }
    #cue-bar button { font: 600 11px/1 ui-monospace, 'JetBrains Mono', monospace;
      letter-spacing: .5px; color: rgba(255,255,255,.8); background: rgba(255,255,255,.06);
      border: 1px solid rgba(255,255,255,.14); border-radius: 6px; height: 26px;
      min-width: 30px; padding: 0 9px; cursor: pointer; }
    #cue-bar button:hover { color: #fff; border-color: rgba(255,255,255,.4); }
    #cue-bar button[data-active] { background: #4F8EF7; border-color: #4F8EF7; color: #06101f; }
    #cue-bar .sw { min-width: 20px; width: 20px; height: 20px; padding: 0; border-radius: 50%; }
    @media print { #cue-ink, #cue-bar, #cue-blackout { display: none !important; } }
  `;

  // ------------------------------------------------------------- geometry
  /** Rect of the visible slide, in viewport px — ink maps to this. */
  function slideRect() {
    const s = stage && stage.children
      ? [...stage.children].filter((c) => c.tagName === 'SECTION')[curIndex()] : null;
    if (s) { const r = s.getBoundingClientRect(); if (r.width > 4) return r; }
    return { left: 0, top: 0, width: innerWidth, height: innerHeight };
  }
  const toNorm = (cx, cy) => {
    const r = slideRect();
    return { x: (cx - r.left) / r.width, y: (cy - r.top) / r.height };
  };
  const toPx = (p) => {
    const r = slideRect();
    return { x: r.left + p.x * r.width, y: r.top + p.y * r.height };
  };

  function resize() {
    const d = window.devicePixelRatio || 1;
    cv.width = Math.round(innerWidth * d);
    cv.height = Math.round(innerHeight * d);
    cv.style.width = innerWidth + 'px';
    cv.style.height = innerHeight + 'px';
    ctx.setTransform(d, 0, 0, d, 0, 0);
    draw();
  }

  // ---------------------------------------------------------------- render
  function strokePath(s) {
    const pts = s.pts;
    if (!pts.length) return;
    const r = slideRect();
    const w = Math.max(1.5, s.w * r.width);      // width scales with the slide
    ctx.strokeStyle = s.color;
    ctx.lineWidth = w;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.beginPath();
    const p0 = toPx(pts[0]);
    if (pts.length === 1) { ctx.arc(p0.x, p0.y, w / 2, 0, Math.PI * 2); ctx.fillStyle = s.color; ctx.fill(); return; }
    ctx.moveTo(p0.x, p0.y);
    // Smooth through midpoints — cheap and much nicer than raw polylines.
    for (let i = 1; i < pts.length - 1; i++) {
      const a = toPx(pts[i]), b = toPx(pts[i + 1]);
      ctx.quadraticCurveTo(a.x, a.y, (a.x + b.x) / 2, (a.y + b.y) / 2);
    }
    const last = toPx(pts[pts.length - 1]);
    ctx.lineTo(last.x, last.y);
    ctx.stroke();
  }

  function draw() {
    ctx.clearRect(0, 0, innerWidth, innerHeight);
    const idx = curIndex();
    for (const s of ink.get(idx) || []) strokePath(s);
    if (stroke) strokePath(stroke);
    if (laser && laserFade > 0) {
      const p = toPx(laser);
      const r = slideRect();
      const rad = Math.max(7, r.width * 0.011);
      const g = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, rad * 2.6);
      g.addColorStop(0, 'rgba(255,255,255,' + (0.95 * laserFade) + ')');
      g.addColorStop(0.35, LASER);
      g.addColorStop(1, 'rgba(255,59,48,0)');
      ctx.fillStyle = g;
      ctx.globalAlpha = laserFade;
      ctx.beginPath(); ctx.arc(p.x, p.y, rad * 2.6, 0, Math.PI * 2); ctx.fill();
      ctx.globalAlpha = 1;
    }
  }

  function tick() {
    raf = 0;
    if (laser && laserFade > 0) {
      laserFade = Math.max(0, laserFade - 0.012);          // fades when idle
      if (laserFade === 0) laser = null;
      schedule();
    }
    draw();
  }
  function schedule() { if (!raf) raf = requestAnimationFrame(tick); }
  function ping() { laserFade = 1; schedule(); }

  // ----------------------------------------------------------------- tools
  /** Absolute set — used for anything arriving from the presenter. */
  function applyTool(t) {
    tool = t;
    cv.toggleAttribute('data-draw', tool === 'pen');
    if (tool !== 'laser') { laser = null; laserFade = 0; }
    syncBar();
    draw();
  }
  /** Local click/key — toggles off when you pick the tool you already hold. */
  function setTool(t) {
    applyTool(tool === t && t !== 'off' ? 'off' : t);
    send({ t: 'tool', tool });
  }
  function applyBlackout(mode) {
    blackout = mode || null;
    if (blackout) shade.setAttribute('data-on', blackout);
    else shade.removeAttribute('data-on');
    syncBar();
  }
  function setBlackout(mode) {
    applyBlackout(blackout === mode ? null : mode);
    send({ t: 'blackout', mode: blackout });
  }
  function clearSlide(all, quiet) {
    if (all) ink.clear(); else ink.delete(curIndex());
    stroke = null; draw();
    if (!quiet) send({ t: 'clear', all: !!all });
  }
  function cycleColor(quiet) {
    color = COLORS[(COLORS.indexOf(color) + 1) % COLORS.length];
    syncBar();
    if (!quiet) send({ t: 'color', color });
  }

  function addPoint(n, start) {
    const idx = curIndex();
    if (start || !stroke) {
      stroke = { color, w: 0.0035, pts: [n] };
      if (!ink.has(idx)) ink.set(idx, []);
      ink.get(idx).push(stroke);
    } else stroke.pts.push(n);
    draw();
  }
  const endStroke = () => { stroke = null; };

  // ------------------------------------------------------------------- bus
  const clientId = Math.random().toString(36).slice(2);
  let sendTimer = 0, pending = null;
  function send(ev, throttle) {
    if (throttle) {                    // pointer stream — coalesce to ~25/s
      pending = ev;
      if (sendTimer) return;
      sendTimer = setTimeout(() => { sendTimer = 0; const e = pending; pending = null; if (e) post(e); }, 40);
      return;
    }
    post(ev);
  }
  function post(ev) {
    fetch('/api/cue', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ deck: DECK, ev, id: clientId }), keepalive: true,
    }).catch(() => {});
  }

  function onRemote(ev) {
    if (!ev || !ev.t) return;
    if (ev.t === 'ptr') {
      const n = { x: ev.x, y: ev.y };
      if (ev.tool === 'pen') { addPoint(n, ev.start); if (ev.end) endStroke(); }
      else { laser = n; ping(); }
    } else if (ev.t === 'tool') applyTool(ev.tool || 'off');
    else if (ev.t === 'blackout') applyBlackout(ev.mode);
    else if (ev.t === 'clear') clearSlide(ev.all, true);
    else if (ev.t === 'color') { color = ev.color; syncBar(); }
  }

  // --------------------------------------------------------------- toolbar
  const bar = document.createElement('div');
  bar.id = 'cue-bar';
  const mk = (label, title, fn) => {
    const b = document.createElement('button');
    b.type = 'button'; b.title = title; b.textContent = label;
    b.addEventListener('click', (e) => { e.stopPropagation(); fn(); });
    b.addEventListener('mousedown', (e) => e.stopPropagation());
    bar.appendChild(b);
    return b;
  };
  const bLaser = mk('◉ Laser', 'Laser pointer (L)', () => setTool('laser'));
  const bPen = mk('✎ Pen', 'Draw on the slide (P)', () => setTool('pen'));
  const swatch = mk('', 'Ink colour (C)', () => cycleColor());
  swatch.className = 'sw';
  const bClear = mk('Erase', 'Erase this slide (E) — ⇧ for all slides', () => clearSlide(false));
  const bBlack = mk('■', 'Black screen (B)', () => setBlackout('black'));

  function syncBar() {
    bLaser.toggleAttribute('data-active', tool === 'laser');
    bPen.toggleAttribute('data-active', tool === 'pen');
    bBlack.toggleAttribute('data-active', !!blackout);
    swatch.style.background = color;
  }

  let idle;
  function wake() {
    bar.setAttribute('data-show', '');
    clearTimeout(idle);
    idle = setTimeout(() => { if (tool === 'off') bar.removeAttribute('data-show'); }, 2400);
  }

  // ---------------------------------------------------------------- events
  customElements.whenDefined('deck-stage').then(() => {
    stage = document.querySelector('deck-stage');
    if (!stage) return;
    document.head.appendChild(css);
    document.body.append(cv, shade, bar);
    resize();
    syncBar();

    addEventListener('resize', resize, { passive: true });
    stage.addEventListener('slidechange', () => { stroke = null; laser = null; laserFade = 0; draw(); });
    addEventListener('mousemove', (e) => {
      wake();
      if (tool === 'laser') { laser = toNorm(e.clientX, e.clientY); ping(); send({ t: 'ptr', x: laser.x, y: laser.y, tool: 'laser' }, true); }
    }, { passive: true });

    // Pen drawing (canvas only takes pointer events while the pen is active,
    // so clicking to advance keeps working with the laser or tools off).
    cv.addEventListener('pointerdown', (e) => {
      if (tool !== 'pen') return;
      cv.setPointerCapture(e.pointerId);
      const n = toNorm(e.clientX, e.clientY);
      addPoint(n, true);
      send({ t: 'ptr', x: n.x, y: n.y, tool: 'pen', start: true });
      e.preventDefault();
    });
    cv.addEventListener('pointermove', (e) => {
      if (tool !== 'pen' || !stroke) return;
      const n = toNorm(e.clientX, e.clientY);
      addPoint(n);
      send({ t: 'ptr', x: n.x, y: n.y, tool: 'pen' }, true);
    });
    const up = (e) => {
      if (tool !== 'pen' || !stroke) return;
      const n = toNorm(e.clientX, e.clientY);
      endStroke();
      send({ t: 'ptr', x: n.x, y: n.y, tool: 'pen', end: true });
    };
    cv.addEventListener('pointerup', up);
    cv.addEventListener('pointercancel', up);

    addEventListener('keydown', (e) => {
      const t = e.composedPath()[0];
      if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName || ''))) return;
      const k = e.key;
      if (k === 'l' || k === 'L') { setTool('laser'); wake(); }
      else if (k === 'p' || k === 'P') { setTool('pen'); wake(); }
      else if (k === 'b' || k === 'B') setBlackout('black');
      else if (k === 'w' || k === 'W') setBlackout('white');
      else if (k === 'e' || k === 'E') clearSlide(e.shiftKey);
      else if (k === 'c' || k === 'C') { cycleColor(); wake(); }
      else if (k === 'Escape') {
        if (blackout) setBlackout(blackout);
        else if (tool !== 'off') setTool('off');
        return;                                   // don't block the deck's Esc
      } else return;
      e.preventDefault();
      e.stopPropagation();                        // keep P/B/E off the deck's nav
    }, true);

    // Remote control from the presenter window.
    try {
      const es = new EventSource('/api/sync?deck=' + encodeURIComponent(DECK));
      es.onmessage = (m) => { try { const d = JSON.parse(m.data); if (d.ev && d.id !== clientId) onRemote(d.ev); } catch {} };
    } catch {}
    wake();
  });
})();
