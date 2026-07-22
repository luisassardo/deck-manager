/**
 * Deck Manager — local server for creating and managing HTML presentations
 * built on the <deck-stage> web component. Zero npm dependencies.
 *
 *   node deck-manager/server.mjs          → http://localhost:4321
 *
 * Routes:
 *   GET  /                      deck library
 *   GET  /__dm/<file>           deck-manager client assets (edit-mode.js, …)
 *   GET  /files/<path>          any file under the workshop folder; deck HTML
 *                               gets the editing/presenter scripts injected
 *                               on the fly (files on disk stay clean)
 *   GET  /api/decks             list decks (path, title, slides, mtime, bundled)
 *   GET  /api/slide-templates   slide layout snippets for "New slide…"
 *   GET  /api/notes?path=       speaker notes JSON for a deck
 *   POST /api/save              {path, stage, notes?} → rewrite <deck-stage>
 *                               region (+ #speaker-notes), with backup
 *   POST /api/new-deck          {name} → scaffold from templates/new-deck
 *   POST /api/duplicate-deck    {path, name}
 *   POST /api/rename-deck       {path, name}
 *   POST /api/move-deck         {path, folder} → move a deck into ROOT/<folder>
 *   POST /api/hide-deck         {path, hidden} → hide/show a deck in the library
 *                               (metadata only — the file is never touched)
 *   POST /api/delete-deck       {path} → move a deck to ROOT/.deck-manager-trash
 *   POST /api/unbundle          {path} → extract a bundled single-file deck
 *   POST /api/upload            {path, name, data} → save a base64 image into
 *                               the deck's assets/ and return its relative src
 *   GET  /api/sync?deck=        Server-Sent Events stream of {index} for a deck
 *   POST /api/sync              {deck, index, id} → fan out to sync subscribers
 *   GET  /api/pdf?path=         render deck to PDF (headless Chrome) and download
 *
 * Every write keeps a timestamped backup in deck-manager/.backups/<deck>/
 * (last 20 per deck).
 *
 * Slide-position sync (presenter ⇄ slideshow ⇄ editor) goes through the SSE
 * bus rather than the browser's BroadcastChannel so it also bridges separate
 * WKWebView windows in the native app and different browsers.
 */

import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { unbundle } from './unbundle.mjs';

// DM_DIR = where the tool's own files live (templates, client assets).
// ROOT   = the "workshop" folder that holds the decks. It's decoupled from the
//          tool location via DECK_MANAGER_ROOT so the tool can live anywhere
//          (e.g. a shared git repo) while the decks stay wherever the user
//          keeps them. Falls back to the parent dir for in-place/dev use.
const DM_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(process.env.DECK_MANAGER_ROOT || path.resolve(DM_DIR, '..'));
const PORT = Number(process.env.DECK_MANAGER_PORT || 4321);
// Backups live with the decks (in ROOT), never inside the tool folder, so the
// tool's git repo stays free of deck content.
const BACKUPS = path.join(ROOT, '.deck-manager-backups');
const MAX_BACKUPS = 20;
const SCAN_SKIP = new Set(['ref', 'deck-manager', 'node_modules', 'uploads', 'assets']);

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.webp': 'image/webp', '.ico': 'image/x-icon',
  '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf',
  '.mp4': 'video/mp4', '.mp3': 'audio/mpeg', '.pdf': 'application/pdf',
};

// ---------------------------------------------------------------- helpers

/** Resolve a client-supplied relative path, refusing anything outside ROOT. */
function safePath(rel) {
  const p = path.resolve(ROOT, rel);
  if (p !== ROOT && !p.startsWith(ROOT + path.sep)) throw new HttpError(400, 'Path outside workshop folder');
  return p;
}

function sanitizeName(name) {
  const n = String(name || '').replace(/[/\\:*?"<>|]/g, '-').replace(/\s+/g, ' ').trim();
  if (!n || n.startsWith('.')) throw new HttpError(400, 'Invalid name');
  return n;
}

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

function json(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(body);
}

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > 50 * 1024 * 1024) throw new HttpError(413, 'Body too large');
    chunks.push(c);
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  try { return raw ? JSON.parse(raw) : {}; } catch { throw new HttpError(400, 'Invalid JSON'); }
}

// ------------------------------------------------------------ hidden decks

// Hidden decks are pure library metadata in ROOT/.deck-manager.json — hiding
// never touches the deck's files, so the TRAINING folder stays exactly as the
// user organized it.
const META_FILE = () => path.join(ROOT, '.deck-manager.json');

function readMeta() {
  try { return JSON.parse(fs.readFileSync(META_FILE(), 'utf8')) || {}; } catch { return {}; }
}
function hiddenSet() { return new Set(readMeta().hidden || []); }
async function setHidden(rel, hidden) {
  safePath(rel); // validate only — nothing on disk is modified for the deck
  const meta = readMeta();
  const set = new Set(meta.hidden || []);
  if (hidden) set.add(rel); else set.delete(rel);
  meta.hidden = [...set].sort();
  await fsp.writeFile(META_FILE(), JSON.stringify(meta, null, 2) + '\n');
  return { hidden: !!hidden };
}

// ------------------------------------------------------------------ decks

function isDeckHtml(txt) {
  return txt.includes('<deck-stage') ||
    (isBundle(txt) && txt.includes('deck-stage')) ||
    txt.includes('component-from-global-scope="deck-stage"');
}
function isBundle(txt) { return txt.includes('__bundler/manifest'); }

/** A self-contained HTML slide deck that is NOT a deck-stage deck (its own
 *  slide engine). Listed in the library as "external": openable / presentable
 *  as a window / manageable, but not editable with the deck-stage tools. */
function isExternalDeck(txt) {
  if (isDeckHtml(txt) || isBundle(txt)) return false;
  if (!/<html[\s>]/i.test(txt) || !/<body[\s>]/i.test(txt)) return false; // full doc only
  const signals = [
    /class="[^"]*\bslides?\b/i,          // .slide / .slides
    /\bid="(deck|stage|slides?|viewport)"/i,
    /class="(deck|reveal|slides|impress)"/i,
    /<section[\s>][\s\S]*<section[\s>]/i, // multiple <section>s
    /<title>[^<]*(deck|slides?|presentation)/i,
    /(keydown|keyup)[\s\S]{0,400}(ArrowRight|ArrowLeft|PageDown|" ")/i, // slide nav
  ];
  return signals.some((re) => re.test(txt));
}

async function findDecks() {
  const out = [];
  const hid = hiddenSet();
  async function walk(dir, depth) {
    let entries;
    try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.name.startsWith('.')) continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (SCAN_SKIP.has(e.name) || depth >= 3) continue;
        await walk(p, depth + 1);
      } else if (e.name.toLowerCase().endsWith('.html')) {
        let txt;
        try { txt = await fsp.readFile(p, 'utf8'); } catch { continue; }
        const deckStage = isDeckHtml(txt);
        const external = !deckStage && isExternalDeck(txt);
        if (!deckStage && !external) continue;
        const bundled = deckStage && isBundle(txt);
        // A bundled file whose import folder already exists is redundant —
        // the editable folder version represents it in the library.
        if (bundled && fs.existsSync(p.replace(/\.html$/i, ''))) continue;
        const rel = path.relative(ROOT, p);
        const title = bundled
          ? e.name.replace(/\.html$/i, '')
          : ((txt.match(/<title>([^<]*)<\/title>/i) || [])[1] || e.name.replace(/\.html$/i, '')).trim();
        const st = await fsp.stat(p);
        // Group = the folder chain above the deck's movable unit ('' = top
        // level). A deck-with-assets folder is the unit, so it doesn't count
        // as a group of its own; a category folder holding several decks does.
        const unit = deckUnit(p);
        out.push({
          path: rel,
          title,
          slides: (bundled || external) ? null : countSlides(txt),
          bundled,
          external,
          group: path.relative(ROOT, path.dirname(unit.target)) || '',
          hidden: hid.has(rel),
          mtime: st.mtimeMs,
        });
      }
    }
  }
  await walk(ROOT, 0);
  return out.sort((a, b) => b.mtime - a.mtime);
}

/** Count direct <section> children of <deck-stage> without a DOM. */
function countSlides(txt) {
  const open = txt.match(/<deck-stage\b[^>]*>/i);
  const close = txt.lastIndexOf('</deck-stage>');
  if (!open || close < 0) return null;
  const inner = txt.slice(open.index + open[0].length, close);
  // Sections never nest in these decks; a plain open-tag count is exact enough.
  return (inner.match(/<section\b/gi) || []).length;
}

function extractNotes(txt) {
  const m = txt.match(/<script type="application\/json" id="speaker-notes">([\s\S]*?)<\/script>/);
  if (!m) return [];
  try { const v = JSON.parse(m[1]); return Array.isArray(v) ? v : []; } catch { return []; }
}

// ------------------------------------------------------------------ save

async function backup(file) {
  const rel = path.relative(ROOT, file).replace(/[/\\]/g, '__');
  const dir = path.join(BACKUPS, rel);
  await fsp.mkdir(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  await fsp.copyFile(file, path.join(dir, stamp + '.html'));
  const old = (await fsp.readdir(dir)).filter((f) => f.endsWith('.html')).sort();
  for (const f of old.slice(0, Math.max(0, old.length - MAX_BACKUPS))) {
    await fsp.unlink(path.join(dir, f));
  }
}

/** Replace the slide region (and optionally speaker notes) in a deck file. */
async function saveDeck(rel, stage, notes) {
  const file = safePath(rel);
  let txt = await fsp.readFile(file, 'utf8');
  if (isBundle(txt)) throw new HttpError(400, 'Bundled decks are read-only — import them first');
  const open = txt.match(/<deck-stage\b[^>]*>/i);
  const close = txt.lastIndexOf('</deck-stage>');
  if (!open || close < 0) throw new HttpError(400, 'No <deck-stage> element in file');
  await backup(file);
  if (typeof stage === 'string') {
    txt = txt.slice(0, open.index + open[0].length) + '\n' + stage + '\n' + txt.slice(close);
  }
  if (Array.isArray(notes)) {
    const tag = '<script type="application/json" id="speaker-notes">' +
      JSON.stringify(notes, null, 1).replace(/<\//g, '<\\/') + '</script>';
    if (/<script type="application\/json" id="speaker-notes">[\s\S]*?<\/script>/.test(txt)) {
      txt = txt.replace(/<script type="application\/json" id="speaker-notes">[\s\S]*?<\/script>/, tag);
    } else {
      const at = txt.lastIndexOf('</body>');
      txt = at >= 0 ? txt.slice(0, at) + tag + '\n' + txt.slice(at) : txt + '\n' + tag;
    }
  }
  await fsp.writeFile(file, txt);
  return { slides: countSlides(txt) };
}

// ------------------------------------------------------- deck management

async function copyDir(src, dst) {
  await fsp.cp(src, dst, { recursive: true, errorOnExist: true, force: false });
}

function retitle(txt, name) {
  return txt.replace(/<title>[^<]*<\/title>/i, '<title>' + name + '</title>');
}

async function newDeck(name) {
  name = sanitizeName(name);
  const dir = path.join(ROOT, name);
  if (fs.existsSync(dir)) throw new HttpError(409, 'A folder named "' + name + '" already exists');
  await copyDir(path.join(DM_DIR, 'templates', 'new-deck'), dir);
  const src = path.join(dir, 'deck.html');
  const dst = path.join(dir, name + '.html');
  const txt = retitle(await fsp.readFile(src, 'utf8'), name);
  await fsp.writeFile(dst, txt);
  await fsp.unlink(src);
  return { path: path.relative(ROOT, dst) };
}

/** The movable unit for a deck: its containing folder when the deck is the
 *  folder's ONLY .html (the folder holds the deck + its assets), else just the
 *  .html file itself. Several decks may share a category folder (e.g. OSINT/
 *  holding three day-slides) — file ops must never take siblings with them. */
// A deck "owns" its folder only when everything else in it is recognizably a
// web asset of the deck. Any real document (.key, .docx, .pdf, video, another
// tool's files) marks the folder as shared/topic material — then file ops touch
// ONLY the .html. Misclassification errs toward file-only, which is the safe
// direction: worst case assets stay behind, but user materials are never
// dragged around or trashed.
const ASSET_FILE_RE = /\.(m?js|css|json|map|png|jpe?g|gif|webp|svg|ico|avif|woff2?|ttf|otf|eot|txt)$/i;
const ASSET_DIR_NAMES = new Set(['assets', 'asset', 'images', 'img', 'fonts', 'media', 'files', 'static', 'lib', 'css', 'js', 'vendor', 'uploads']);

function deckUnit(file) {
  const dir = path.dirname(file);
  if (dir === ROOT) return { target: file, ownsDir: false };
  const entries = fs.readdirSync(dir, { withFileTypes: true }).filter((e) => !e.name.startsWith('.'));
  const htmlCount = entries.filter((e) => e.isFile() && e.name.toLowerCase().endsWith('.html')).length;
  const others = entries.filter((e) => !(e.isFile() && e.name.toLowerCase().endsWith('.html')));
  const allAssets = others.length > 0 && others.every((e) =>
    e.isDirectory() ? ASSET_DIR_NAMES.has(e.name.toLowerCase()) : ASSET_FILE_RE.test(e.name));
  const owns = htmlCount === 1 && allAssets;
  return { target: owns ? dir : file, ownsDir: owns };
}

async function duplicateDeck(rel, name) {
  name = sanitizeName(name);
  const file = safePath(rel);
  const { ownsDir } = deckUnit(file);
  const parent = ownsDir ? path.dirname(path.dirname(file)) : path.dirname(file);
  let dst;
  if (ownsDir) {
    // Copy the deck's folder (with assets) next to the original.
    const dstDir = path.join(parent, name);
    if (fs.existsSync(dstDir)) throw new HttpError(409, '"' + name + '" already exists');
    await copyDir(path.dirname(file), dstDir);
    dst = path.join(dstDir, name + '.html');
    await fsp.rename(path.join(dstDir, path.basename(file)), dst);
  } else {
    // Shared folder or loose root file → copy just the file, same folder.
    dst = path.join(parent, name + '.html');
    if (fs.existsSync(dst)) throw new HttpError(409, '"' + name + '" already exists');
    await fsp.copyFile(file, dst);
  }
  await fsp.writeFile(dst, retitle(await fsp.readFile(dst, 'utf8'), name));
  return { path: path.relative(ROOT, dst) };
}

async function renameDeck(rel, name) {
  name = sanitizeName(name);
  const file = safePath(rel);
  const { ownsDir } = deckUnit(file);
  let dst;
  if (ownsDir) {
    const dir = path.dirname(file);
    const newDir = path.join(path.dirname(dir), name);
    if (fs.existsSync(newDir)) throw new HttpError(409, 'Already exists');
    await fsp.rename(dir, newDir);
    dst = path.join(newDir, name + '.html');
    await fsp.rename(path.join(newDir, path.basename(file)), dst);
  } else {
    dst = path.join(path.dirname(file), name + '.html');
    if (fs.existsSync(dst)) throw new HttpError(409, 'Already exists');
    await fsp.rename(file, dst);
  }
  await fsp.writeFile(dst, retitle(await fsp.readFile(dst, 'utf8'), name));
  return { path: path.relative(ROOT, dst) };
}

/** Delete a deck by moving it to ROOT/.deck-manager-trash (reversible — the
 *  user can restore it from there or empty it). */
async function deleteDeck(rel) {
  const file = safePath(rel);
  if (file === ROOT) throw new HttpError(400, 'Invalid target');
  const { target } = deckUnit(file);
  if (target === ROOT) throw new HttpError(400, 'Invalid target');
  const trash = path.join(ROOT, '.deck-manager-trash');
  await fsp.mkdir(trash, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dest = path.join(trash, stamp + '__' + path.basename(target));
  await fsp.rename(target, dest);
  return { trashed: path.relative(ROOT, dest) };
}

/** Move a deck (its unit — folder-with-assets or single file) into a group
 *  folder under ROOT ("A" or "A/B"). Empty folder name = the top level. */
async function moveDeck(rel, folder) {
  folder = String(folder || '').split('/')
    .map((s) => s.replace(/[\\:*?"<>|]/g, '-').replace(/\s+/g, ' ').trim())
    .filter(Boolean).join('/');
  if (folder.split('/').some((s) => s.startsWith('.') || SCAN_SKIP.has(s))) {
    throw new HttpError(400, 'Invalid folder name');
  }
  const file = safePath(rel);
  const { target, ownsDir } = deckUnit(file);
  const destDir = folder ? safePath(folder) : ROOT;
  if (path.dirname(target) === destDir) return { path: rel };   // already there
  const dest = path.join(destDir, path.basename(target));
  if (fs.existsSync(dest)) throw new HttpError(409, '"' + path.basename(target) + '" already exists in ' + (folder || 'the top level'));
  await fsp.mkdir(destDir, { recursive: true });
  const srcDir = path.dirname(target);
  await fsp.rename(target, dest);
  // A wrapper/category folder left empty by the move is noise — drop it.
  if (srcDir !== ROOT) {
    try {
      const left = (await fsp.readdir(srcDir)).filter((f) => f !== '.DS_Store');
      if (!left.length) await fsp.rm(srcDir, { recursive: true });
    } catch {}
  }
  const newFile = ownsDir ? path.join(dest, path.basename(file)) : dest;
  return { path: path.relative(ROOT, newFile) };
}

/** Save an uploaded image (base64) into assets/ next to the deck file and
 *  return its src relative to the deck, ready for an <img>. */
const IMAGE_EXT_RE = /\.(png|jpe?g|gif|webp|svg|avif|heic)$/i;
async function uploadAsset(rel, name, data) {
  const file = safePath(rel);
  if (!fs.existsSync(file)) throw new HttpError(404, 'Deck not found');
  name = String(name || 'image.png').split('/').pop()
    .replace(/[\\:*?"<>|#]/g, '-').replace(/\s+/g, ' ').trim() || 'image.png';
  if (!IMAGE_EXT_RE.test(name)) name += '.png';
  const buf = Buffer.from(String(data || ''), 'base64');
  if (!buf.length) throw new HttpError(400, 'Empty image');
  if (buf.length > 25 * 1024 * 1024) throw new HttpError(413, 'Image too large (25 MB max)');
  const assetsDir = path.join(path.dirname(file), 'assets');
  await fsp.mkdir(assetsDir, { recursive: true });
  const base = name.replace(IMAGE_EXT_RE, '');
  const ext = name.match(IMAGE_EXT_RE)[0];
  let dest = path.join(assetsDir, name);
  let n = 1;
  while (fs.existsSync(dest)) dest = path.join(assetsDir, base + '-' + (n++) + ext);
  await fsp.writeFile(dest, buf);
  return { src: 'assets/' + path.basename(dest) };
}

async function slideTemplates() {
  const dir = path.join(DM_DIR, 'templates', 'slides');
  let files;
  try { files = (await fsp.readdir(dir)).filter((f) => f.endsWith('.html')).sort(); } catch { return []; }
  const out = [];
  for (const f of files) {
    const html = await fsp.readFile(path.join(dir, f), 'utf8');
    out.push({ name: f.replace(/^\d+-/, '').replace(/\.html$/, '').replace(/-/g, ' '), html });
  }
  return out;
}

// ------------------------------------------------------------- sync bus

// Per-deck Server-Sent-Events subscribers and last-known slide index. Any
// window (presenter, slideshow, editor) POSTs its position; the server fans
// it out to every other subscriber of the same deck.
const syncClients = new Map(); // deckPath → Set<res>
const syncState = new Map();   // deckPath → { index, id }

function syncSubscribe(res, deck) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-store',
    Connection: 'keep-alive',
  });
  res.write('retry: 2000\n\n');
  let set = syncClients.get(deck);
  if (!set) { set = new Set(); syncClients.set(deck, set); }
  set.add(res);
  const last = syncState.get(deck);
  if (last) res.write('data: ' + JSON.stringify(last) + '\n\n');
  // Heartbeat keeps proxies / WKWebView from closing an idle stream.
  const beat = setInterval(() => { try { res.write(': ping\n\n'); } catch {} }, 25000);
  res.on('close', () => { clearInterval(beat); set.delete(res); });
}

function syncPublish(deck, index, id) {
  const payload = { index, id };
  syncState.set(deck, payload);
  const set = syncClients.get(deck);
  if (!set) return;
  const line = 'data: ' + JSON.stringify(payload) + '\n\n';
  for (const res of set) { try { res.write(line); } catch {} }
}

// -------------------------------------------------------------- PDF export

const BROWSER_CANDIDATES = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
];
let _browser;
function findBrowser() {
  if (_browser !== undefined) return _browser;
  _browser = BROWSER_CANDIDATES.find((p) => { try { fs.accessSync(p, fs.constants.X_OK); return true; } catch { return false; } }) || null;
  return _browser;
}

/** Render a deck to a one-slide-per-page PDF via headless Chromium and stream
 *  it back as a download. The deck's own @media print / @page rules do the
 *  layout; ?raw=1 keeps the manager's editing chrome out of the capture. */
async function exportPdf(res, rel) {
  const file = safePath(rel);
  const txt = await fsp.readFile(file, 'utf8');
  if (isBundle(txt)) throw new HttpError(400, 'Import this deck before exporting');
  const browser = findBrowser();
  if (!browser) throw new HttpError(501, 'No Chrome/Brave/Edge found for PDF — use the browser Print dialog (Save as PDF)');

  const title = (txt.match(/<title>([^<]*)<\/title>/i) || [])[1] || path.basename(file, '.html');
  const url = 'http://127.0.0.1:' + PORT + '/files/' +
    rel.split(path.sep).map(encodeURIComponent).join('/') + '?raw=1&print=1';
  const tmp = path.join(os.tmpdir(), 'deck-' + Date.now() + '-' + Math.random().toString(36).slice(2) + '.pdf');
  const profile = path.join(os.tmpdir(), 'deck-pdf-profile');

  await new Promise((resolve, reject) => {
    const args = [
      '--headless=old', '--disable-gpu', '--hide-scrollbars', '--no-first-run',
      '--no-pdf-header-footer', '--virtual-time-budget=6000',
      '--user-data-dir=' + profile,
      '--print-to-pdf=' + tmp, url,
    ];
    const child = spawn(browser, args, { stdio: 'ignore' });
    let done = false;
    const finish = (err) => {
      if (done) return; done = true;
      clearInterval(poll); clearTimeout(killer);
      try { child.kill('SIGKILL'); } catch {}
      err ? reject(err) : resolve();
    };
    // Headless Chrome writes the finished PDF in one shot but then lingers
    // (the deck's animation loop keeps it "busy"), so instead of waiting for
    // exit we poll for the file to appear and its size to settle, then kill it.
    let last = -1;
    const poll = setInterval(() => {
      let sz;
      try { sz = fs.statSync(tmp).size; } catch { return; }
      if (sz > 1000 && sz === last) finish();       // two equal non-zero reads
      last = sz;
    }, 250);
    const killer = setTimeout(() => finish(fs.existsSync(tmp) ? null
      : new HttpError(500, 'PDF render timed out')), 30000);
    child.on('error', (e) => finish(e));
  });

  const buf = await fsp.readFile(tmp);
  fsp.unlink(tmp).catch(() => {});
  const safeTitle = title.trim().replace(/[/\\:*?"<>|]/g, '-') || 'deck';
  // HTTP headers only allow Latin-1: deck titles with em dashes/accents made
  // writeHead throw ("Invalid character in header content"). Send an ASCII
  // fallback plus the RFC 5987 filename* form so browsers keep the full name.
  const ascii = safeTitle.replace(/[^\x20-\x7E]/g, '-');
  res.writeHead(200, {
    'Content-Type': 'application/pdf',
    'Content-Length': buf.length,
    'Content-Disposition': 'attachment; filename="' + ascii + '.pdf"; ' +
      "filename*=UTF-8''" + encodeURIComponent(safeTitle + '.pdf'),
  });
  res.end(buf);
}

// ----------------------------------------------------------------- serve

/** Inject client script(s) before </body>. deck-stage decks get the full
 *  editor + presenter; external decks get only a minimal "back to library" bar. */
function injectScripts(txt, srcs) {
  const tags = srcs.map((s) => `<script src="${s}" defer></script>`).join('') + '\n';
  const at = txt.lastIndexOf('</body>');
  return at >= 0 ? txt.slice(0, at) + tags + txt.slice(at) : txt + tags;
}

// Some decks pin the component to the viewport (deck-stage{position:fixed;
// inset:0}). Document CSS on the host outranks the component's :host print
// rules, so every slide collapses onto one printed page. Injected only for
// PDF rendering (?print=1) and stronger than any author rule.
const PRINT_FIX = '<style>@media print{deck-stage{position:static!important;' +
  'inset:auto!important;width:auto!important;height:auto!important;' +
  'transform:none!important;overflow:visible!important}}</style>';

async function serveFile(res, file, { inject = false, printFix = false } = {}) {
  let st;
  try { st = await fsp.stat(file); } catch { return json(res, 404, { error: 'Not found' }); }
  if (st.isDirectory()) return json(res, 404, { error: 'Not found' });
  const ext = path.extname(file).toLowerCase();
  const mime = MIME[ext] || 'application/octet-stream';
  if (ext === '.html' && (inject || printFix)) {
    let txt = await fsp.readFile(file, 'utf8');
    if (inject) {
      if (isDeckHtml(txt) && !isBundle(txt)) {
        txt = injectScripts(txt, ['/__dm/edit-mode.js', '/__dm/presenter.js']);
      } else if (isExternalDeck(txt)) {
        txt = injectScripts(txt, ['/__dm/external-mode.js']);
      }
    }
    if (printFix && isDeckHtml(txt) && !isBundle(txt)) {
      const at = txt.lastIndexOf('</body>');
      txt = at >= 0 ? txt.slice(0, at) + PRINT_FIX + txt.slice(at) : txt + PRINT_FIX;
    }
    res.writeHead(200, { 'Content-Type': mime, 'Cache-Control': 'no-store' });
    return res.end(txt);
  }
  res.writeHead(200, { 'Content-Type': mime, 'Cache-Control': 'no-store', 'Content-Length': st.size });
  fs.createReadStream(file).pipe(res);
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://localhost');
  const p = decodeURIComponent(u.pathname);
  try {
    if (req.method === 'GET') {
      if (p === '/' || p === '/index.html') return await serveFile(res, path.join(DM_DIR, 'library.html'));
      if (p.startsWith('/__dm/')) {
        const rel = p.slice('/__dm/'.length);
        const f = path.resolve(DM_DIR, rel);
        if (!f.startsWith(DM_DIR + path.sep)) throw new HttpError(400, 'Bad path');
        return await serveFile(res, f);
      }
      if (p.startsWith('/files/')) {
        return await serveFile(res, safePath(p.slice('/files/'.length)),
          { inject: !u.searchParams.has('raw'), printFix: u.searchParams.has('print') });
      }
      if (p === '/api/decks') return json(res, 200, await findDecks());
      if (p === '/api/slide-templates') return json(res, 200, await slideTemplates());
      if (p === '/api/notes') {
        const txt = await fsp.readFile(safePath(u.searchParams.get('path') || ''), 'utf8');
        return json(res, 200, extractNotes(txt));
      }
      if (p === '/api/sync') return syncSubscribe(res, u.searchParams.get('deck') || '');
      if (p === '/api/pdf') return await exportPdf(res, u.searchParams.get('path') || '');
    }
    if (req.method === 'POST') {
      const body = await readBody(req);
      if (p === '/api/sync') { syncPublish(body.deck || '', body.index | 0, body.id || ''); return json(res, 200, { ok: true }); }
      if (p === '/api/save') return json(res, 200, await saveDeck(body.path, body.stage, body.notes));
      if (p === '/api/new-deck') return json(res, 200, await newDeck(body.name));
      if (p === '/api/duplicate-deck') return json(res, 200, await duplicateDeck(body.path, body.name));
      if (p === '/api/rename-deck') return json(res, 200, await renameDeck(body.path, body.name));
      if (p === '/api/move-deck') return json(res, 200, await moveDeck(body.path, body.folder));
      if (p === '/api/hide-deck') return json(res, 200, await setHidden(body.path, !!body.hidden));
      if (p === '/api/upload') return json(res, 200, await uploadAsset(body.path, body.name, body.data));
      if (p === '/api/delete-deck') return json(res, 200, await deleteDeck(body.path));
      if (p === '/api/unbundle') {
        const file = safePath(body.path);
        const outDir = path.join(path.dirname(file), path.basename(file, '.html'));
        if (fs.existsSync(outDir)) throw new HttpError(409, 'Folder "' + path.basename(outDir) + '" already exists');
        const r = unbundle(file, outDir);
        return json(res, 200, { path: path.relative(ROOT, r.outFile) });
      }
    }
    json(res, 404, { error: 'Not found' });
  } catch (err) {
    const status = err instanceof HttpError ? err.status : 500;
    if (status === 500) console.error(err);
    json(res, status, { error: err.message });
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log('Deck Manager running at http://localhost:' + PORT);
  console.log('Managing: ' + ROOT);
});
