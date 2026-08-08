/**
 * external-mode.js — injected by server.mjs into *non*-deck-stage HTML decks
 * (self-contained presentations with their own slide engine). It only adds an
 * unobtrusive floating bar so you can get back to the library, pop the deck
 * into its own window for screen-sharing, or export a PDF. It deliberately does
 * NOT touch the deck's markup or keyboard handling — those stay 100% the deck's.
 */
(() => {
  'use strict';
  // No bar inside library thumbnails or preview iframes.
  if (/[?&](_snthumb|_dmfollow|_dmshow)=/.test(location.search)) return;
  if (!location.pathname.startsWith('/files/')) return;

  const deckRel = decodeURIComponent(location.pathname.slice('/files/'.length));
  const bar = document.createElement('div');
  bar.id = 'dm-ext-bar';
  const mk = (label, title, fn) => {
    const b = document.createElement('button');
    b.type = 'button'; b.title = title; b.textContent = label;
    b.addEventListener('click', fn);
    bar.appendChild(b);
  };
  mk('Library', 'Back to all presentations', () => { location.href = '/'; });
  mk('Window', 'Open in a separate window to screen-share in Zoom/Meet',
     () => window.open(location.pathname, 'dm-ext-' + location.pathname));
  mk('PDF', 'Download as PDF (best effort — depends on the deck’s print styles)',
     () => window.open('/api/pdf?path=' + encodeURIComponent(deckRel), '_blank'));

  const css = document.createElement('style');
  css.textContent =
    '@media print{#dm-ext-bar{display:none!important}}' +
    '#dm-ext-bar{position:fixed;top:12px;right:12px;z-index:2147483000;display:flex;gap:5px;' +
    'padding:5px;border-radius:10px;background:rgba(11,11,12,.86);' +
    'border:1px solid #26262A;-webkit-backdrop-filter:blur(10px);backdrop-filter:blur(10px);' +
    'opacity:.25;transition:opacity .2s cubic-bezier(.32,.72,0,1)}' +
    '#dm-ext-bar:hover{opacity:1}' +
    '#dm-ext-bar button{font:450 12px/1 -apple-system,BlinkMacSystemFont,system-ui,sans-serif;' +
    'color:#A1A1A6;background:transparent;border:1px solid transparent;border-radius:6px;' +
    'padding:7px 10px;cursor:pointer;transition:color .3s,background .3s}' +
    '#dm-ext-bar button:hover{color:#F4F4F5;background:#232327}' +
    '#dm-ext-bar button:focus-visible{outline:2px solid #F4F4F5;outline-offset:2px}';


  const attach = () => { (document.head || document.documentElement).appendChild(css); document.body.appendChild(bar); };
  if (document.body) attach(); else document.addEventListener('DOMContentLoaded', attach);
})();
