/**
 * presenter.js — slide-position sync bridge, injected by server.mjs into every
 * deck page served under /files/. Keeps the presenter window, the shared
 * slideshow window and the editor pointed at the same slide, through the
 * server's SSE bus (works across separate browsers and native WKWebView
 * windows — a plain BroadcastChannel would not).
 *
 * Roles, by URL:
 *   normal deck window        two-way sync: publishes its slide changes and
 *                             follows remote ones.
 *   ?_dmshow=1                same two-way sync, PLUS clean "slideshow" chrome
 *                             (no rail/overlay, cursor auto-hides, F = fullscreen)
 *                             — this is the window you share in Zoom.
 *   ?_dmfollow=cur / next     presenter-view preview iframe; mirrors the shared
 *                             index (or index+1); never publishes.
 *   ?_snthumb without follow  library thumbnail — no sync at all.
 */
(() => {
  'use strict';
  if (!location.pathname.startsWith('/files/')) return;
  const q = location.search;
  const follow = (q.match(/[?&]_dmfollow=(\w+)/) || [])[1] || null;
  const show = /[?&]_dmshow=/.test(q);
  if (/[?&]_snthumb=/.test(q) && !follow) return; // plain thumbnail

  const DECK = decodeURIComponent(location.pathname.slice('/files/'.length));
  const clientId = Math.random().toString(36).slice(2);

  function publish(index) {
    fetch('/api/sync', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ deck: DECK, index, id: clientId }),
      keepalive: true,
    }).catch(() => {});
  }

  customElements.whenDefined('deck-stage').then(() => {
    const stage = document.querySelector('deck-stage');
    if (!stage) return;

    let applyingRemote = false;
    const es = new EventSource('/api/sync?deck=' + encodeURIComponent(DECK));
    es.onmessage = (ev) => {
      let m; try { m = JSON.parse(ev.data); } catch { return; }
      if (m.id === clientId) return;               // ignore our own echo
      const want = follow === 'next' ? m.index + 1 : m.index;
      const target = Math.max(0, Math.min(want, stage.length - 1));
      if (target === stage.index) return;
      applyingRemote = true;
      stage.goTo(target);
      applyingRemote = false;
    };

    if (!follow) {
      // Publish local navigation (but not the initial deep-link 'init', and
      // not the echo of a remote goTo we just applied).
      stage.addEventListener('slidechange', (e) => {
        if (e.detail.reason === 'init' || applyingRemote) return;
        publish(e.detail.index);
      });
    }

    if (show) enableSlideshow(stage);
  });

  // ------------------------------------------------- clean slideshow chrome
  function enableSlideshow(stage) {
    stage.setAttribute('no-rail', '');
    // deck-stage hides its bottom overlay + rail while "presenting".
    try { window.postMessage({ __omelette_presenting: true }, '*'); } catch {}

    const style = document.createElement('style');
    style.textContent =
      'html,body{background:#000;cursor:auto}' +
      'body.dm-hide-cursor,body.dm-hide-cursor *{cursor:none !important}';
    document.head.appendChild(style);

    // Auto-hide the cursor after 2s of stillness.
    let idle;
    const wake = () => {
      document.body.classList.remove('dm-hide-cursor');
      clearTimeout(idle);
      idle = setTimeout(() => document.body.classList.add('dm-hide-cursor'), 2000);
    };
    window.addEventListener('mousemove', wake, { passive: true });
    wake();

    // F toggles fullscreen (deck-stage keeps ←/→/Space/PageDn for nav).
    window.addEventListener('keydown', (e) => {
      const t = e.composedPath && e.composedPath()[0];
      if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName || ''))) return;
      if (e.key === 'f' || e.key === 'F') {
        if (document.fullscreenElement) document.exitFullscreen();
        else document.documentElement.requestFullscreen().catch(() => {});
      }
    });
  }
})();
