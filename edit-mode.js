/**
 * edit-mode.js — Deck Manager editing layer, injected by server.mjs into
 * every deck page served under /files/. Files on disk never reference it,
 * so decks stay portable (double-click → plain presenting).
 *
 * Adds, on top of <deck-stage>:
 *   - autosave: any rail mutation (move/skip/delete/duplicate) rewrites the
 *     deck file through POST /api/save (the server keeps backups)
 *   - "Duplicate slide" in the rail context menu when the deck ships an
 *     older deck-stage.js without it, and "New slide…" (template picker)
 *   - double-click any text on the current slide to edit it in place
 *   - speaker-notes drawer editing per-slide data-speaker-notes attributes
 *     (they travel with the slide on reorder/duplicate)
 *   - a small toolbar: Library / + Slide / Notes / Present
 *
 * Works with both deck-stage generations:
 *   old — emits `deckchange`, no duplicate action
 *   new — emits `dc-op`, has duplicate built in
 */
(() => {
  'use strict';
  // Presenter-view thumbnails, follow iframes, and the clean slideshow window
  // must never show editing chrome or save.
  if (/[?&](_snthumb|_dmfollow|_dmshow)=/.test(location.search)) return;
  if (!location.pathname.startsWith('/files/')) return;
  if (document.querySelector('x-dc')) return; // non-normalized dc docs: view-only

  const DECK_PATH = decodeURIComponent(location.pathname.slice('/files/'.length));
  const RUNTIME_ATTRS = /^data-(deck-(?!skip)|screen-label$|om-validate$)/;

  const ready = () => customElements.whenDefined('deck-stage');
  ready().then(() => {
    const stage = document.querySelector('deck-stage');
    if (!stage) return;
    init(stage);
  });

  function init(stage) {
    // ------------------------------------------------------------- save
    const pill = el('div', { id: 'dm-pill' });
    document.body.appendChild(pill);
    let pillTimer;
    function status(kind, msg) {
      pill.dataset.kind = kind;
      pill.textContent = msg;
      pill.setAttribute('data-on', '');
      clearTimeout(pillTimer);
      if (kind !== 'saving') pillTimer = setTimeout(() => pill.removeAttribute('data-on'), 1800);
    }

    function slides() {
      return Array.from(stage.children).filter((c) =>
        !['TEMPLATE', 'SCRIPT', 'STYLE'].includes(c.tagName));
    }

    function serialize() {
      return slides().map((s) => {
        const c = s.cloneNode(true);
        for (const node of [c, ...c.querySelectorAll('[contenteditable]')]) {
          node.removeAttribute('contenteditable');
        }
        // data-screen-label is runtime-managed ("NN Label", renumbered on
        // every load) — keep the label part as authored data-label so slide
        // names survive the strip below.
        if (!c.getAttribute('data-label')) {
          const sl = (c.getAttribute('data-screen-label') || '').replace(/^\s*\d+\s*/, '').trim();
          if (sl) c.setAttribute('data-label', sl);
        }
        for (let i = c.attributes.length - 1; i >= 0; i--) {
          if (RUNTIME_ATTRS.test(c.attributes[i].name)) c.removeAttribute(c.attributes[i].name);
        }
        return c.outerHTML;
      }).join('\n\n');
    }

    let saveTimer;
    function save() {
      clearTimeout(saveTimer);
      saveTimer = setTimeout(async () => {
        status('saving', 'Saving…');
        try {
          const r = await fetch('/api/save', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ path: DECK_PATH, stage: serialize() }),
          });
          if (!r.ok) throw new Error((await r.json()).error || r.statusText);
          status('ok', 'Saved ✓');
        } catch (e) {
          console.error('[deck-manager] save failed:', e);
          status('err', 'Save failed — ' + e.message);
        }
      }, 350);
    }

    // Rail mutations: old component emits `deckchange`, new one `dc-op`.
    // Both fire before/around a synchronous DOM update; the debounce means
    // we serialize the settled DOM.
    stage.addEventListener('deckchange', save);
    stage.addEventListener('dc-op', save);

    // ------------------------------------------------- context-menu items
    const menu = stage.shadowRoot && stage.shadowRoot.querySelector('.ctxmenu');
    if (menu) {
      const hr = menu.querySelector('hr');
      if (!menu.querySelector('[data-act="duplicate"]')) {
        // Old component: provide duplicate ourselves.
        const b = el('button', { type: 'button', 'data-act': 'dm-duplicate' });
        b.textContent = 'Duplicate slide';
        menu.insertBefore(b, hr);
      }
      const nb = el('button', { type: 'button', 'data-act': 'dm-new' });
      nb.textContent = 'New slide…';
      menu.insertBefore(nb, hr);
      // Capture phase: read _menuIndex before the component's own bubble
      // handler closes the menu and resets it.
      menu.addEventListener('click', (e) => {
        const act = e.target && e.target.getAttribute && e.target.getAttribute('data-act');
        const i = stage._menuIndex;
        if (act === 'dm-duplicate') duplicateSlide(i);
        else if (act === 'dm-new') openPicker(i);
      }, true);
    }

    function duplicateSlide(i) {
      const s = slides()[i];
      if (!s) return;
      const c = s.cloneNode(true);
      if (!c.getAttribute('data-label')) {
        const sl = (c.getAttribute('data-screen-label') || '').replace(/^\s*\d+\s*/, '').trim();
        if (sl) c.setAttribute('data-label', sl);
      }
      for (let k = c.attributes.length - 1; k >= 0; k--) {
        if (RUNTIME_ATTRS.test(c.attributes[k].name)) c.removeAttribute(c.attributes[k].name);
      }
      s.after(c);
      requestAnimationFrame(() => stage.goTo(i + 1));
      save();
    }

    // ------------------------------------------------------ template picker
    let picker;
    async function openPicker(afterIndex) {
      if (afterIndex == null || afterIndex < 0) afterIndex = stage.index;
      if (!picker) {
        picker = el('div', { id: 'dm-picker' });
        picker.innerHTML = '<div class="dm-sheet"><div class="dm-head">Add slide' +
          '<button class="dm-x" type="button">✕</button></div><div class="dm-grid"></div></div>';
        picker.addEventListener('click', (e) => { if (e.target === picker) closePicker(); });
        picker.querySelector('.dm-x').addEventListener('click', closePicker);
        document.body.appendChild(picker);
        try {
          const templates = await (await fetch('/api/slide-templates')).json();
          const grid = picker.querySelector('.dm-grid');
          templates.forEach((t) => {
            const card = el('div', { class: 'dm-card' });
            const prev = el('div', { class: 'dm-prev' });
            const inner = el('div', { class: 'dm-prev-inner' });
            inner.innerHTML = t.html;
            prev.appendChild(inner);
            const label = el('div', { class: 'dm-label' });
            label.textContent = t.name;
            card.append(prev, label);
            new ResizeObserver(() => {
              inner.style.transform = 'scale(' + (prev.clientWidth / 1920) + ')';
            }).observe(prev);
            card.addEventListener('click', () => {
              insertTemplate(t.html);
              closePicker();
            });
            grid.appendChild(card);
          });
        } catch (e) { console.error('[deck-manager] templates:', e); }
      }
      picker._after = afterIndex;
      picker.setAttribute('data-open', '');
    }
    function closePicker() { picker && picker.removeAttribute('data-open'); }

    function insertTemplate(html) {
      const frag = document.createRange().createContextualFragment(html.trim());
      const section = frag.firstElementChild;
      if (!section) return;
      const after = slides()[picker._after];
      if (after) after.after(section); else stage.appendChild(section);
      requestAnimationFrame(() => stage.goTo(picker._after + 1));
      save();
    }

    // -------------------------------------------------- inline text editing
    let editing = null;
    stage.addEventListener('dblclick', (e) => {
      if (editing) return;
      let t = e.target;
      if (!(t instanceof Element) || !stage.contains(t)) return;
      // Find the nearest element that directly contains visible text.
      while (t && t !== stage && !hasOwnText(t)) t = t.parentElement;
      if (!t || t === stage || t.tagName === 'SECTION') return;
      startEdit(t);
    });

    function hasOwnText(elm) {
      return Array.from(elm.childNodes).some((n) => n.nodeType === 3 && n.textContent.trim());
    }

    function startEdit(elm) {
      editing = elm;
      try { elm.contentEditable = 'plaintext-only'; } catch { elm.contentEditable = 'true'; }
      elm.setAttribute('data-dm-editing', '');
      elm.focus();
      const end = () => {
        elm.removeEventListener('blur', end);
        elm.removeAttribute('contenteditable');
        elm.removeAttribute('data-dm-editing');
        editing = null;
        save();
      };
      elm.addEventListener('blur', end);
    }
    // Esc finishes editing; keep the deck's own nav out of it (both
    // component generations already ignore contenteditable targets).
    window.addEventListener('keydown', (e) => {
      if (editing && e.key === 'Escape') { e.stopPropagation(); editing.blur(); }
    }, true);

    // ----------------------------------------------------------- notes
    const drawer = el('div', { id: 'dm-notes' });
    drawer.innerHTML = '<div class="dm-notes-head">Presenter notes — slide <span class="dm-n">1</span></div>' +
      '<textarea placeholder="Notes for this slide…"></textarea>';
    document.body.appendChild(drawer);
    const ta = drawer.querySelector('textarea');
    const nEl = drawer.querySelector('.dm-n');

    function syncNotes() {
      const s = slides()[stage.index];
      nEl.textContent = String(stage.index + 1);
      ta.value = (s && s.getAttribute('data-speaker-notes')) || '';
    }
    let notesTimer;
    ta.addEventListener('input', () => {
      const s = slides()[stage.index];
      if (!s) return;
      if (ta.value.trim()) s.setAttribute('data-speaker-notes', ta.value);
      else s.removeAttribute('data-speaker-notes');
      clearTimeout(notesTimer);
      notesTimer = setTimeout(save, 800);
    });
    stage.addEventListener('slidechange', () => {
      if (drawer.hasAttribute('data-open')) syncNotes();
    });

    // ----------------------------------------------------------- toolbar
    const bar = el('div', { id: 'dm-bar' });
    const mkBtn = (label, title, fn) => {
      const b = el('button', { type: 'button', title });
      b.textContent = label;
      b.addEventListener('click', fn);
      bar.appendChild(b);
      return b;
    };
    mkBtn('⌂ Library', 'All presentations', () => { location.href = '/'; });
    mkBtn('＋ Slide', 'Add a slide after the current one', () => openPicker(stage.index));
    const notesBtn = mkBtn('Notes', 'Edit presenter notes (N)', toggleNotes);
    mkBtn('▶ Slideshow', 'Open the clean slideshow window to share (S)', openSlideshow);
    mkBtn('◧ Present', 'Open presenter view (P)', openPresenter);
    mkBtn('⤓ PDF', 'Download this deck as a PDF', downloadPdf);
    document.body.appendChild(bar);

    function toggleNotes() {
      const on = drawer.toggleAttribute('data-open');
      notesBtn.toggleAttribute('data-active', on);
      if (on) { syncNotes(); ta.focus(); }
    }
    function openPresenter() {
      window.open('/__dm/presenter.html?deck=' + encodeURIComponent(DECK_PATH), '_blank');
    }
    function openSlideshow() {
      window.open(location.pathname + '?_dmshow=1#' + (stage.index + 1), 'dm-slideshow');
    }
    async function downloadPdf() {
      status('saving', 'Rendering PDF…');
      const url = '/api/pdf?path=' + encodeURIComponent(DECK_PATH);
      try {
        const r = await fetch(url);
        if (r.status === 501) { status('ok', 'Opening print dialog…'); window.print(); return; }
        if (!r.ok) throw new Error((await r.json()).error || r.statusText);
        const blob = await r.blob();
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = (document.title || 'deck') + '.pdf';
        a.click();
        setTimeout(() => URL.revokeObjectURL(a.href), 4000);
        status('ok', 'PDF downloaded ✓');
      } catch (e) { status('err', 'PDF failed — ' + e.message); }
    }
    window.addEventListener('keydown', (e) => {
      const t = e.composedPath()[0];
      if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName || ''))) return;
      if (e.key === 'p' || e.key === 'P') openPresenter();
      if (e.key === 's' || e.key === 'S') openSlideshow();
      if (e.key === 'n' || e.key === 'N') toggleNotes();
    });
    document.addEventListener('fullscreenchange', () => {
      bar.style.display = document.fullscreenElement ? 'none' : '';
      pill.style.display = bar.style.display;
    });

    // ----------------------------------------------------------- styles
    const css = el('style');
    css.textContent = `
      @media print { #dm-bar, #dm-pill, #dm-notes, #dm-picker { display: none !important; } }
      #dm-bar { position: fixed; top: 14px; right: 16px; z-index: 9000; display: flex; gap: 8px; }
      #dm-bar button { font: 600 11.5px/1 'JetBrains Mono', ui-monospace, monospace; letter-spacing: .5px;
        color: rgba(255,255,255,.8); background: rgba(10,14,26,.85); border: 1px solid rgba(79,142,247,.35);
        border-radius: 6px; padding: 8px 12px; cursor: pointer; backdrop-filter: blur(6px); }
      #dm-bar button:hover { border-color: #4F8EF7; color: #fff; }
      #dm-bar button[data-active] { background: #4F8EF7; color: #06101f; }
      #dm-pill { position: fixed; bottom: 16px; right: 16px; z-index: 9000; font: 12px/1.2 'JetBrains Mono', ui-monospace, monospace;
        padding: 8px 14px; border-radius: 6px; background: rgba(10,14,26,.9); border: 1px solid rgba(79,142,247,.4);
        color: #9cc0ff; opacity: 0; transition: opacity .2s; pointer-events: none; }
      #dm-pill[data-on] { opacity: 1; }
      #dm-pill[data-kind="ok"] { color: #6ee7b7; border-color: rgba(16,185,129,.5); }
      #dm-pill[data-kind="err"] { color: #ffb3c0; border-color: rgba(244,63,94,.6); }
      [data-dm-editing] { outline: 2px dashed rgba(79,142,247,.8) !important; outline-offset: 4px; cursor: text; }
      #dm-notes { position: fixed; left: 50%; transform: translate(-50%, 110%); bottom: 0; width: min(860px, 92vw);
        z-index: 9000; background: rgba(10,14,26,.96); border: 1px solid rgba(79,142,247,.35); border-bottom: 0;
        border-radius: 10px 10px 0 0; padding: 14px 18px 16px; transition: transform .2s; }
      #dm-notes[data-open] { transform: translate(-50%, 0); }
      #dm-notes .dm-notes-head { font: 600 11px/1 'JetBrains Mono', ui-monospace, monospace; letter-spacing: 2px;
        text-transform: uppercase; color: rgba(79,142,247,.9); margin-bottom: 10px; }
      #dm-notes textarea { width: 100%; height: 110px; resize: vertical; background: rgba(255,255,255,.04);
        border: 1px solid rgba(255,255,255,.12); border-radius: 6px; color: #fff; padding: 10px 12px;
        font: 14px/1.5 'DM Sans', system-ui, sans-serif; }
      #dm-picker { position: fixed; inset: 0; z-index: 9500; background: rgba(0,0,0,.6); display: none;
        align-items: center; justify-content: center; }
      #dm-picker[data-open] { display: flex; }
      #dm-picker .dm-sheet { width: min(1060px, 94vw); max-height: 86vh; overflow: auto; background: #0c1322;
        border: 1px solid rgba(79,142,247,.35); border-radius: 14px; padding: 22px 26px; }
      #dm-picker .dm-head { display: flex; justify-content: space-between; align-items: center;
        font: 700 20px/1 'Syne', system-ui, sans-serif; color: #fff; margin-bottom: 18px; }
      #dm-picker .dm-x { background: none; border: 0; color: rgba(255,255,255,.6); font-size: 16px; cursor: pointer; }
      #dm-picker .dm-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(300px, 1fr)); gap: 18px; }
      #dm-picker .dm-card { border: 1px solid rgba(79,142,247,.25); border-radius: 10px; overflow: hidden; cursor: pointer; }
      #dm-picker .dm-card:hover { border-color: #4F8EF7; }
      #dm-picker .dm-prev { aspect-ratio: 16/9; overflow: hidden; background: #0A0E1A; position: relative; }
      #dm-picker .dm-prev-inner { width: 1920px; height: 1080px; transform-origin: 0 0; pointer-events: none; }
      #dm-picker .dm-prev-inner > section { width: 1920px; height: 1080px; display: block; position: relative; overflow: hidden; }
      #dm-picker .dm-label { font: 600 12px/1 'JetBrains Mono', ui-monospace, monospace; letter-spacing: 1px;
        text-transform: uppercase; color: rgba(255,255,255,.7); padding: 12px 14px; }
    `;
    document.head.appendChild(css);
  }

  function el(tag, attrs) {
    const n = document.createElement(tag);
    if (attrs) for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
    return n;
  }
})();
