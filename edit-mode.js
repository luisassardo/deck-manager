/**
 * edit-mode.js — CUE editing layer, injected by server.mjs into
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
        for (const node of c.querySelectorAll('[data-dm-sel]')) node.removeAttribute('data-dm-sel');
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
          console.error('[cue] save failed:', e);
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
        } catch (e) { console.error('[cue] templates:', e); }
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

    // ------------------------------------------------------ object editing
    // Click any element on the current slide to select it (outline + style
    // bar). Floating objects (data-dm-float / position:absolute) drag freely
    // and resize; flow-layout elements move via a visual transform offset so
    // the slide's responsive layout is never broken. Everything persists
    // through the normal save path since edits are plain inline styles.
    let sel = null;
    let dragged = false;

    const box = el('div', { id: 'dm-selbox' });
    box.innerHTML = '<div class="dm-h se" title="Drag to resize"></div>';
    const seHandle = box.querySelector('.se');
    document.body.appendChild(box);

    const sbar = el('div', { id: 'dm-style' });
    document.body.appendChild(sbar);
    const sb = (label, title, fn) => {
      const b = el('button', { type: 'button', title });
      b.innerHTML = label;
      b.addEventListener('mousedown', (e) => e.stopPropagation());
      b.addEventListener('click', (e) => { e.stopPropagation(); fn(); });
      sbar.appendChild(b);
      return b;
    };
    sb('A−', 'Smaller text', () => bumpFont(1 / 1.12));
    sb('A＋', 'Bigger text', () => bumpFont(1.12));
    ['#ffffff', 'rgba(255,255,255,.55)', '#4F8EF7', '#10B981', '#F59E0B', '#F43F5E'].forEach((c) => {
      const b = sb('', 'Text color', () => { if (sel) { sel.style.color = c; save(); } });
      b.className = 'dm-swatch';
      b.style.background = c;
    });
    sb('⇤', 'Align left', () => setAlign('left'));
    sb('⇔', 'Align center', () => setAlign('center'));
    sb('⇥', 'Align right', () => setAlign('right'));
    const frontBtn = sb('▲', 'Bring forward', () => bumpZ(1));
    const backBtn = sb('▼', 'Send backward', () => bumpZ(-1));
    sb('⧉', 'Duplicate (⌘D)', () => duplicateSel());
    sb('🗑', 'Delete (⌫)', () => deleteSel());

    function bumpFont(f) {
      if (!sel) return;
      sel.style.fontSize = Math.max(8, parseFloat(getComputedStyle(sel).fontSize) * f).toFixed(1) + 'px';
      syncBox(); save();
    }
    function setAlign(a) { if (sel) { sel.style.textAlign = a; save(); } }
    function bumpZ(d) {
      if (!sel) return;
      sel.style.zIndex = String((parseInt(getComputedStyle(sel).zIndex, 10) || 0) + d);
      save();
    }
    function duplicateSel() {
      if (!sel) return;
      const c = sel.cloneNode(true);
      c.removeAttribute('data-dm-sel');
      if (isFloat(sel)) {
        c.style.left = (parseFloat(sel.style.left || sel.offsetLeft) + 24) + 'px';
        c.style.top = (parseFloat(sel.style.top || sel.offsetTop) + 24) + 'px';
      }
      sel.after(c);
      select(c); save();
    }
    function deleteSel() {
      if (!sel) return;
      const s = sel; deselect(); s.remove(); save();
    }

    function curSection() { return slides()[stage.index]; }
    function scaleOf(section) {
      return section.getBoundingClientRect().width / section.offsetWidth || 1;
    }
    function isFloat(elm) {
      return elm.hasAttribute('data-dm-float') || getComputedStyle(elm).position === 'absolute';
    }

    function select(elm) {
      if (sel === elm) { syncBox(); return; }
      deselect();
      sel = elm;
      sel.setAttribute('data-dm-sel', '');
      const float = isFloat(sel);
      frontBtn.style.display = backBtn.style.display = float ? '' : 'none';
      seHandle.style.display = float ? '' : 'none';
      syncBox();
    }
    function deselect() {
      if (!sel) return;
      sel.removeAttribute('data-dm-sel');
      sel = null;
      box.removeAttribute('data-on');
      sbar.removeAttribute('data-on');
    }
    function syncBox() {
      if (!sel) return;
      const r = sel.getBoundingClientRect();
      box.style.left = r.left + 'px';
      box.style.top = r.top + 'px';
      box.style.width = r.width + 'px';
      box.style.height = r.height + 'px';
      box.setAttribute('data-on', '');
      sbar.setAttribute('data-on', '');
      const sw = sbar.offsetWidth;
      sbar.style.left = Math.max(8, Math.min(r.left, window.innerWidth - sw - 8)) + 'px';
      sbar.style.top = Math.max(8, (r.top > 60 ? r.top - 50 : r.bottom + 12)) + 'px';
    }
    window.addEventListener('resize', () => sel && syncBox());
    stage.addEventListener('slidechange', deselect);

    // Select on mousedown; drag moves the element (mouseup without movement
    // is just a select). Double-click still enters text editing.
    stage.addEventListener('mousedown', (e) => {
      if (editing || e.button !== 0) return;
      const t = e.target;
      if (!(t instanceof Element) || !stage.contains(t)) return;
      const section = curSection();
      if (!section || !section.contains(t) || t === section) { deselect(); return; }
      select(t);
      beginDrag(e);
    });
    document.addEventListener('mousedown', (e) => {
      // Click outside the stage (and outside our chrome) clears the selection.
      if (!sel) return;
      const path = e.composedPath();
      if (!path.includes(stage) && !path.includes(sbar) && !path.includes(box)) deselect();
    });

    function beginDrag(e) {
      const elm = sel;
      const section = curSection();
      const scale = scaleOf(section);
      const startX = e.clientX, startY = e.clientY;
      const float = isFloat(elm);
      let base;
      if (float) {
        base = { l: elm.offsetLeft, t: elm.offsetTop };
      } else {
        const m = new DOMMatrix(getComputedStyle(elm).transform === 'none' ? '' : getComputedStyle(elm).transform);
        base = { m };
      }
      dragged = false;
      const move = (ev) => {
        const dx = (ev.clientX - startX) / scale;
        const dy = (ev.clientY - startY) / scale;
        if (!dragged && Math.hypot(dx, dy) < 3) return;
        dragged = true;
        document.body.classList.add('dm-moving');
        if (float) {
          elm.style.left = (base.l + dx) + 'px';
          elm.style.top = (base.t + dy) + 'px';
          elm.style.right = 'auto';
          elm.style.bottom = 'auto';
        } else {
          const m = base.m;
          elm.style.transform = `matrix(${m.a}, ${m.b}, ${m.c}, ${m.d}, ${m.e + dx}, ${m.f + dy})`;
        }
        syncBox();
        ev.preventDefault();
      };
      const up = () => {
        window.removeEventListener('mousemove', move);
        window.removeEventListener('mouseup', up);
        document.body.classList.remove('dm-moving');
        if (dragged) save();
      };
      window.addEventListener('mousemove', move);
      window.addEventListener('mouseup', up);
    }

    // Corner handle: resize floating objects (width; height follows content).
    seHandle.addEventListener('mousedown', (e) => {
      if (!sel) return;
      e.stopPropagation(); e.preventDefault();
      const elm = sel;
      const scale = scaleOf(curSection());
      const startX = e.clientX;
      const baseW = elm.offsetWidth;
      const move = (ev) => {
        elm.style.width = Math.max(40, baseW + (ev.clientX - startX) / scale) + 'px';
        elm.style.height = 'auto';
        syncBox();
      };
      const up = () => {
        window.removeEventListener('mousemove', move);
        window.removeEventListener('mouseup', up);
        save();
      };
      window.addEventListener('mousemove', move);
      window.addEventListener('mouseup', up);
    });

    // Keyboard: arrows nudge (shift = ×5), ⌫ deletes, ⌘D duplicates, Esc
    // deselects. Capture phase so slide navigation doesn't also fire.
    window.addEventListener('keydown', (e) => {
      if (!sel || editing) return;
      const step = (e.shiftKey ? 10 : 2);
      const dir = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[e.key];
      if (dir) {
        nudge(dir[0], dir[1]);
        e.preventDefault(); e.stopPropagation();
      } else if (e.key === 'Backspace' || e.key === 'Delete') {
        deleteSel();
        e.preventDefault(); e.stopPropagation();
      } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'd') {
        duplicateSel();
        e.preventDefault(); e.stopPropagation();
      } else if (e.key === 'Escape') {
        deselect();
        e.stopPropagation();
      }
    }, true);

    function nudge(dx, dy) {
      if (!sel) return;
      if (isFloat(sel)) {
        sel.style.left = (sel.offsetLeft + dx) + 'px';
        sel.style.top = (sel.offsetTop + dy) + 'px';
        sel.style.right = 'auto'; sel.style.bottom = 'auto';
      } else {
        const cs = getComputedStyle(sel).transform;
        const m = new DOMMatrix(cs === 'none' ? '' : cs);
        sel.style.transform = `matrix(${m.a}, ${m.b}, ${m.c}, ${m.d}, ${m.e + dx}, ${m.f + dy})`;
      }
      syncBox(); save();
    }

    // ------------------------------------------- insert text box / images
    function ensureRelative(section) {
      if (getComputedStyle(section).position === 'static') section.style.position = 'relative';
    }

    function insertTextBox() {
      const section = curSection();
      if (!section) return;
      ensureRelative(section);
      const t = el('div', { 'data-dm-float': '' });
      t.textContent = 'Text';
      t.style.cssText = 'position:absolute;left:' + Math.round(section.offsetWidth / 2 - 200) +
        'px;top:' + Math.round(section.offsetHeight / 2 - 30) +
        'px;min-width:60px;max-width:1600px;font-size:40px;line-height:1.3;color:#fff;z-index:5';
      section.appendChild(t);
      select(t);
      startEdit(t);
      // Pre-select the placeholder so typing replaces it.
      const range = document.createRange();
      range.selectNodeContents(t);
      const s = getSelection();
      s.removeAllRanges(); s.addRange(range);
    }

    const imgInput = el('input', { type: 'file', accept: 'image/*', style: 'display:none' });
    document.body.appendChild(imgInput);
    imgInput.addEventListener('change', () => {
      if (imgInput.files[0]) uploadImage(imgInput.files[0]);
      imgInput.value = '';
    });

    function uploadImage(file, x, y) {
      status('saving', 'Uploading image…');
      const fr = new FileReader();
      fr.onload = async () => {
        try {
          const r = await fetch('/api/upload', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ path: DECK_PATH, name: file.name || 'pasted.png', data: String(fr.result).split(',')[1] }),
          });
          const out = await r.json();
          if (!r.ok) throw new Error(out.error || r.statusText);
          insertImage(out.src, x, y);
          status('ok', 'Image added ✓');
        } catch (e) { status('err', 'Upload failed — ' + e.message); }
      };
      fr.readAsDataURL(file);
    }

    function insertImage(src, x, y) {
      const section = curSection();
      if (!section) return;
      ensureRelative(section);
      const img = el('img', { src, 'data-dm-float': '', draggable: 'false' });
      const w = 560;
      img.style.cssText = 'position:absolute;width:' + w + 'px;height:auto;z-index:5;' +
        'left:' + Math.round((x != null ? x : section.offsetWidth / 2) - w / 2) + 'px;' +
        'top:' + Math.round((y != null ? y : section.offsetHeight / 2) - 160) + 'px';
      img.addEventListener('load', () => { syncBox(); });
      section.appendChild(img);
      select(img);
      save();
    }

    // Drag & drop an image file onto the slide, or paste one from the clipboard.
    stage.addEventListener('dragover', (e) => {
      if (e.dataTransfer && [...e.dataTransfer.types].includes('Files')) e.preventDefault();
    });
    stage.addEventListener('drop', (e) => {
      const f = e.dataTransfer && [...e.dataTransfer.files].find((f) => f.type.startsWith('image/'));
      if (!f) return;
      e.preventDefault();
      const section = curSection();
      const r = section.getBoundingClientRect();
      const scale = scaleOf(section);
      uploadImage(f, (e.clientX - r.left) / scale, (e.clientY - r.top) / scale);
    });
    window.addEventListener('paste', (e) => {
      if (editing) return;
      const f = e.clipboardData && [...e.clipboardData.files].find((f) => f.type.startsWith('image/'));
      if (f) { e.preventDefault(); uploadImage(f); }
    });
    // Native image dragging inside a slide would fight our move-drag.
    stage.addEventListener('dragstart', (e) => {
      if (e.target instanceof HTMLImageElement) e.preventDefault();
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
    mkBtn('Library', 'All presentations', () => { location.href = '/'; });
    mkBtn('Add slide', 'Add a slide after the current one', () => openPicker(stage.index));
    mkBtn('Add text', 'Add a text box to this slide', () => insertTextBox());
    mkBtn('Add image', 'Add an image to this slide (or just drag & drop / paste one)', () => imgInput.click());
    const notesBtn = mkBtn('Notes', 'Edit presenter notes (N)', toggleNotes);
    mkBtn('Slideshow', 'Open the clean slideshow window to share (S)', openSlideshow);
    mkBtn('Present', 'Open presenter view (P)', openPresenter);
    mkBtn('PDF', 'Download this deck as a PDF', downloadPdf);
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
      /* Chrome injected on top of someone else's deck: quiet by design.
         Tokens mirror cue.css; they are --cue-* prefixed so they can never
         collide with a deck's own custom properties. */
      :root {
        --cue-canvas:#0B0B0C; --cue-raised:#131315; --cue-raised-2:#17171A;
        --cue-raised-3:#232327; --cue-line:#26262A; --cue-line-strong:#34343A;
        --cue-ink:#F4F4F5; --cue-ink-2:#A1A1A6; --cue-ink-3:#6E6E76;
        --cue-focus:#F4F4F5; --cue-danger:#F2646B; --cue-ok:#5BD6A0;
        --cue-r-md:8px; --cue-ease:cubic-bezier(.32,.72,0,1);
        --cue-sans:-apple-system,BlinkMacSystemFont,"SF Pro Display","Segoe UI",system-ui,sans-serif;
        --cue-mono:ui-monospace,"SF Mono","JetBrains Mono",Menlo,monospace;
      }
      @media print { #dm-bar, #dm-pill, #dm-notes, #dm-picker, #dm-selbox, #dm-style { display:none !important; } }

      #dm-bar { position:fixed; top:14px; right:16px; z-index:9000; display:flex; gap:5px;
        padding:5px; border-radius:10px; background:rgba(11,11,12,.86);
        border:1px solid var(--cue-line);
        -webkit-backdrop-filter:blur(10px); backdrop-filter:blur(10px); }
      #dm-bar button { font:450 12px/1 var(--cue-sans); color:var(--cue-ink-2);
        background:transparent; border:1px solid transparent; border-radius:6px;
        padding:7px 10px; cursor:pointer;
        transition:color .3s var(--cue-ease), background .3s var(--cue-ease); }
      #dm-bar button:hover { color:var(--cue-ink); background:var(--cue-raised-3); }
      #dm-bar button[data-active] { color:var(--cue-canvas); background:var(--cue-ink); }
      #dm-bar button:focus-visible { outline:2px solid var(--cue-focus); outline-offset:2px; }

      #dm-pill { position:fixed; bottom:16px; right:18px; z-index:9000;
        font:12px/1.2 var(--cue-mono); padding:8px 14px; border-radius:var(--cue-r-md);
        background:rgba(19,19,21,.95); border:1px solid var(--cue-line);
        color:var(--cue-ink-2); opacity:0; transition:opacity .25s var(--cue-ease);
        pointer-events:none; -webkit-backdrop-filter:blur(8px); backdrop-filter:blur(8px); }
      #dm-pill[data-on] { opacity:1; }
      #dm-pill[data-kind="ok"] { color:var(--cue-ok); border-color:#1E3A2E; }
      #dm-pill[data-kind="err"] { color:var(--cue-danger); border-color:#3A1E22; }

      [data-dm-editing] { outline:2px dashed var(--cue-ink-3) !important; outline-offset:4px; cursor:text; }
      [data-dm-sel] { outline:2px solid var(--cue-ink) !important; outline-offset:2px; }
      body.dm-moving, body.dm-moving * { cursor:grabbing !important; user-select:none !important; }

      #dm-selbox { position:fixed; z-index:8900; pointer-events:none; display:none; }
      #dm-selbox[data-on] { display:block; }
      #dm-selbox .dm-h { position:absolute; width:12px; height:12px; border-radius:3px;
        background:var(--cue-ink); border:2px solid var(--cue-canvas); pointer-events:auto; }
      #dm-selbox .dm-h.se { right:-6px; bottom:-6px; cursor:nwse-resize; }

      #dm-style { position:fixed; z-index:9100; display:none; align-items:center; gap:4px;
        padding:5px 6px; border-radius:10px; background:rgba(11,11,12,.92);
        border:1px solid var(--cue-line);
        -webkit-backdrop-filter:blur(10px); backdrop-filter:blur(10px); }
      #dm-style[data-on] { display:flex; }
      #dm-style button { font:500 12px/1 var(--cue-sans); color:var(--cue-ink-2);
        background:transparent; border:1px solid transparent; border-radius:6px;
        min-width:28px; height:26px; padding:0 7px; cursor:pointer;
        transition:color .3s var(--cue-ease), background .3s var(--cue-ease); }
      #dm-style button:hover { color:var(--cue-ink); background:var(--cue-raised-3); }
      #dm-style .dm-swatch { min-width:18px; width:18px; height:18px; border-radius:50%;
        padding:0; border:1px solid var(--cue-line-strong); }
      #dm-style .dm-swatch:hover { border-color:var(--cue-ink); }

      #dm-notes { position:fixed; left:50%; transform:translate(-50%,110%); bottom:0;
        width:min(880px,92vw); z-index:9000; background:rgba(11,11,12,.97);
        border:1px solid var(--cue-line); border-bottom:0; border-radius:12px 12px 0 0;
        padding:14px 18px 16px; transition:transform .35s var(--cue-ease);
        -webkit-backdrop-filter:blur(12px); backdrop-filter:blur(12px); }
      #dm-notes[data-open] { transform:translate(-50%,0); }
      #dm-notes .dm-notes-head { font:13px/1 var(--cue-sans); font-weight:550;
        color:var(--cue-ink-2); margin-bottom:10px; }
      #dm-notes textarea { width:100%; height:112px; resize:vertical;
        background:#0F0F11; border:1px solid var(--cue-line); border-radius:var(--cue-r-md);
        color:var(--cue-ink); padding:10px 12px; font:15px/1.55 var(--cue-sans); }
      #dm-notes textarea:focus { outline:none; border-color:var(--cue-line-strong); }

      #dm-picker { position:fixed; inset:0; z-index:9500; background:rgba(0,0,0,.62);
        display:none; align-items:center; justify-content:center;
        -webkit-backdrop-filter:blur(3px); backdrop-filter:blur(3px); }
      #dm-picker[data-open] { display:flex; }
      #dm-picker .dm-sheet { width:min(1060px,94vw); max-height:86vh; overflow:auto;
        background:var(--cue-raised); border:1px solid var(--cue-line);
        border-radius:14px; padding:22px 26px; }
      #dm-picker .dm-head { display:flex; justify-content:space-between; align-items:center;
        font:600 18px/1 var(--cue-sans); letter-spacing:-.02em; color:var(--cue-ink);
        margin-bottom:18px; }
      #dm-picker .dm-x { background:none; border:0; color:var(--cue-ink-3);
        font-size:15px; cursor:pointer; padding:4px 8px; border-radius:6px; }
      #dm-picker .dm-x:hover { color:var(--cue-ink); background:var(--cue-raised-3); }
      #dm-picker .dm-grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(290px,1fr)); gap:16px; }
      #dm-picker .dm-card { border:1px solid var(--cue-line); border-radius:12px;
        overflow:hidden; cursor:pointer; background:var(--cue-raised-2);
        transition:border-color .3s var(--cue-ease); }
      #dm-picker .dm-card:hover { border-color:var(--cue-line-strong); }
      #dm-picker .dm-prev { aspect-ratio:16/9; overflow:hidden; background:#000; position:relative; }
      #dm-picker .dm-prev-inner { width:1920px; height:1080px; transform-origin:0 0; pointer-events:none; }
      #dm-picker .dm-prev-inner > section { width:1920px; height:1080px; display:block;
        position:relative; overflow:hidden; }
      #dm-picker .dm-label { font:13px/1 var(--cue-sans); color:var(--cue-ink-2); padding:12px 14px; }

      @media (prefers-reduced-motion:reduce) {
        #dm-bar button, #dm-pill, #dm-style button, #dm-notes, #dm-picker .dm-card { transition:none; }
      }
    `;
    document.head.appendChild(css);
  }

  function el(tag, attrs) {
    const n = document.createElement(tag);
    if (attrs) for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
    return n;
  }
})();
