#!/usr/bin/env node
/**
 * cue-doctor — check that a deck follows the CUE authoring contract
 * (see AUTHORING.md). Zero dependencies.
 *
 *   node cue-doctor.mjs "path/to/My Deck/My Deck.html"
 *   node cue-doctor.mjs --all "path/to/decks/root"
 *
 * Exit 0 = CUE can display, edit, present and export this deck.
 * Exit 1 = at least one ✗ (a real breakage). Warnings alone still exit 0.
 */

import fs from 'node:fs';
import path from 'node:path';

const C = process.stdout.isTTY
  ? { r: '\x1b[31m', y: '\x1b[33m', g: '\x1b[32m', d: '\x1b[2m', b: '\x1b[1m', x: '\x1b[0m' }
  : { r: '', y: '', g: '', d: '', b: '', x: '' };

/** Slice the markup between <deck-stage …> and its closing tag. */
function stageInner(txt) {
  const open = txt.match(/<deck-stage\b[^>]*>/i);
  const close = txt.lastIndexOf('</deck-stage>');
  if (!open || close < 0) return null;
  return txt.slice(open.index + open[0].length, close);
}

/** Strip comments + script/style bodies so scans don't trip on prose or code. */
function stripInert(txt) {
  return txt
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '<script></script>')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '<style></style>');
}

function checkDeck(file) {
  const out = [];
  const fail = (m, fix) => out.push({ lvl: 'fail', m, fix });
  const warn = (m, fix) => out.push({ lvl: 'warn', m, fix });
  const pass = (m) => out.push({ lvl: 'pass', m });

  let txt;
  try { txt = fs.readFileSync(file, 'utf8'); }
  catch { return [{ lvl: 'fail', m: 'Cannot read ' + file }]; }

  const dir = path.dirname(file);
  const base = path.basename(file, '.html');

  // ---- format: bundled / x-dc are not editable ------------------------------
  if (txt.includes('__bundler/manifest')) {
    fail('Single-file bundled export — read-only in CUE',
      'Import it: node unbundle.mjs "' + file + '" "' + path.join(dir, base) + '"');
    return out;
  }
  if (/<x-dc[\s>]|<x-import\b/i.test(txt)) {
    fail('Uses <x-dc>/<x-import> wrapper — display-only in CUE',
      'Convert with unbundle.mjs, or rewrite to the plain <deck-stage> skeleton (AUTHORING.md §2)');
    return out;
  }

  // ---- the engine -----------------------------------------------------------
  const inner = stageInner(txt);
  if (!txt.includes('<deck-stage')) {
    fail('No <deck-stage> element — CUE lists this as a read-only "external" deck',
      'Wrap the slides in <deck-stage width="1920" height="1080"> … </deck-stage>');
    return out;
  }
  if (inner === null) {
    fail('<deck-stage> is never closed', 'Add the </deck-stage> closing tag');
    return out;
  }
  pass('<deck-stage> element present');

  const openTag = txt.match(/<deck-stage\b[^>]*>/i)[0];
  const w = (openTag.match(/\bwidth="(\d+)"/) || [])[1];
  const h = (openTag.match(/\bheight="(\d+)"/) || [])[1];
  if (!w || !h) warn('No width/height on <deck-stage> (defaults to 1920×1080)',
    'Set width="1920" height="1080" explicitly');
  else if (w !== '1920' || h !== '1080') warn(`Design size is ${w}×${h}, not 1920×1080`,
    'Non-standard sizes are supported but every slide must be authored to it');
  else pass('Design size 1920×1080');

  // Engine script must be a local file that exists.
  const scripts = [...txt.matchAll(/<script\b[^>]*\bsrc="([^"]+)"/gi)].map((m) => m[1]);
  const engine = scripts.find((s) => /deck-stage\.js(\?|#|$)/i.test(s));
  if (!engine) {
    fail('deck-stage.js is not loaded',
      'Copy templates/new-deck/deck-stage.js into the deck folder and add <script src="deck-stage.js"></script>');
  } else if (/^https?:/i.test(engine)) {
    fail('deck-stage.js is loaded over the network: ' + engine,
      'Copy it into the deck folder and use a relative src — decks must work offline');
  } else {
    const p = path.resolve(dir, engine.split(/[?#]/)[0]);
    if (fs.existsSync(p)) pass('deck-stage.js present (' + engine + ')');
    else fail('deck-stage.js referenced but missing on disk: ' + engine,
      'Copy templates/new-deck/deck-stage.js to ' + p);
  }

  // ---- slides ---------------------------------------------------------------
  const clean = stripInert(inner);
  const slides = [...clean.matchAll(/<section\b[^>]*>/gi)].map((m) => m[0]);
  if (!slides.length) {
    fail('No slides found — <deck-stage> has no <section> children',
      'Each slide must be a direct <section> child of <deck-stage> (no wrapper div)');
  } else {
    pass(slides.length + ' slide' + (slides.length === 1 ? '' : 's'));
    const noLabel = slides.filter((s) => !/\bdata-label="/.test(s)).length;
    if (noLabel) warn(noLabel + ' slide(s) without data-label',
      'Add data-label="Short name" so the rail and presenter view show a real name');
    const noNotes = slides.filter((s) => !/\bdata-speaker-notes="/.test(s)).length;
    if (noNotes) warn(noNotes + ' slide(s) without speaker notes',
      'Add data-speaker-notes="…" — it shows in presenter view and travels with the slide');
    const authored = slides.filter((s) => /\bdata-(deck-|screen-label)/.test(s)).length;
    if (authored) warn(authored + ' slide(s) carry runtime attributes (data-deck-* / data-screen-label)',
      'Remove them — the engine manages these and strips them on save');
  }
  // A wrapper element around the sections is the classic "zero slides" cause.
  const firstEl = clean.match(/<([a-z][\w-]*)\b/i);
  if (firstEl && !/^section$/i.test(firstEl[1]) && !/^(template|script|style)$/i.test(firstEl[1])) {
    warn('First child of <deck-stage> is <' + firstEl[1] + '>, not <section>',
      'Slides must be direct <section> children — remove the wrapper');
  }

  // ---- CSS traps ------------------------------------------------------------
  const css = [...txt.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)].map((m) => m[1]).join('\n');
  const hostRule = css.match(/(^|[}\s])deck-stage\s*\{[^}]*\}/i);
  if (hostRule && /position\s*:\s*fixed/i.test(hostRule[0])) {
    fail('deck-stage is pinned with position:fixed — collapses PDF export to one page',
      'Style "deck-stage > section" instead. CUE injects a print-time override so export ' +
      'still works, but do not rely on it — the host must stay in normal flow');
  } else pass('Host element not pinned to the viewport');

  if (!/deck-stage:not\(:defined\)/.test(css)) {
    warn('No :not(:defined) guard',
      'Add  deck-stage:not(:defined){visibility:hidden}  to avoid a flash of unstyled slides');
  }
  if (!/deck-stage\s*>\s*section[^{]*\{[^}]*position\s*:\s*relative/i.test(css)) {
    warn('deck-stage > section has no position:relative',
      'Required so images/text boxes placed by the editor land where you drop them');
  }

  // ---- offline / assets -----------------------------------------------------
  const refs = [...txt.matchAll(/\b(?:src|href)="([^"]+)"/gi)].map((m) => m[1])
    .filter((u) => !u.startsWith('data:') && !u.startsWith('#'));
  const remote = [...new Set(refs.filter((u) => /^(https?:)?\/\//i.test(u)))];
  if (remote.length) {
    warn(remote.length + ' network asset(s) — deck breaks offline and in PDF export',
      'Download into assets/ and reference locally: ' + remote.slice(0, 3).join(', ') +
      (remote.length > 3 ? ' …' : ''));
  } else pass('Fully self-contained (no network assets)');

  const missing = refs.filter((u) => !/^(https?:)?\/\//i.test(u))
    .filter((u) => !fs.existsSync(path.resolve(dir, decodeURIComponent(u.split(/[?#]/)[0]))));
  if (missing.length) {
    fail(missing.length + ' referenced file(s) missing on disk',
      'Fix or remove: ' + missing.slice(0, 3).join(', ') + (missing.length > 3 ? ' …' : ''));
  }

  // ---- JS-generated content -------------------------------------------------
  const inlineJs = [...txt.matchAll(/<script\b(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)]
    .map((m) => m[1]).join('\n');
  if (/\b(ReactDOM|createRoot|\.innerHTML\s*=|document\.createElement\s*\(\s*['"]section)/.test(inlineJs)) {
    fail('Slide content looks JavaScript-generated',
      'CUE saves by serializing the DOM — write slide markup literally in the HTML (AUTHORING.md §3.1)');
  }

  // ---- title & folder layout ------------------------------------------------
  const title = (txt.match(/<title>([^<]*)<\/title>/i) || [])[1];
  if (!title || !title.trim()) fail('No <title>', 'Set <title> — it is the library name and PDF filename');
  else if (/^(new presentation|document|untitled)$/i.test(title.trim())) {
    warn('Placeholder <title>: "' + title.trim() + '"', 'Set the real deck name');
  } else pass('Title: ' + title.trim());

  if (path.resolve(dir) !== path.resolve(process.cwd())) {
    const siblings = fs.existsSync(dir)
      ? fs.readdirSync(dir).filter((f) => f.toLowerCase().endsWith('.html')) : [];
    if (siblings.length > 1) {
      warn(siblings.length + ' decks share this folder',
        'Give each deck its own folder so assets and file operations stay separate');
    } else if (path.basename(dir) !== base) {
      warn('File name and folder name differ ("' + base + '" in "' + path.basename(dir) + '")',
        'Name them the same so the library, moves and renames stay predictable');
    }
  }
  return out;
}

function report(file, results) {
  const bad = results.filter((r) => r.lvl === 'fail');
  const warns = results.filter((r) => r.lvl === 'warn');
  const head = bad.length ? C.r + '✗ FAIL' : warns.length ? C.y + '△ OK, with warnings' : C.g + '✓ PASS';
  console.log(`\n${head}${C.x}  ${C.b}${path.basename(file)}${C.x}`);
  console.log(C.d + '  ' + file + C.x);
  for (const r of results) {
    if (r.lvl === 'pass') console.log(`  ${C.g}✓${C.x} ${C.d}${r.m}${C.x}`);
    else if (r.lvl === 'warn') console.log(`  ${C.y}△${C.x} ${r.m}\n      ${C.d}→ ${r.fix}${C.x}`);
    else console.log(`  ${C.r}✗${C.x} ${r.m}\n      ${C.d}→ ${r.fix}${C.x}`);
  }
  return bad.length;
}

// ------------------------------------------------------------------- CLI
const args = process.argv.slice(2);
const all = args.includes('--all');
const target = args.filter((a) => a !== '--all')[0];

if (!target) {
  console.log('Usage:\n  node cue-doctor.mjs "deck.html"\n  node cue-doctor.mjs --all "decks/root"');
  process.exit(2);
}

const SKIP = new Set(['node_modules', 'assets', 'templates', '.git']);
function findDecks(root, depth = 0) {
  const out = [];
  let entries;
  try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    if (e.name.startsWith('.') || SKIP.has(e.name)) continue;
    const p = path.join(root, e.name);
    if (e.isDirectory()) { if (depth < 4) out.push(...findDecks(p, depth + 1)); }
    else if (e.name.toLowerCase().endsWith('.html')) {
      try {
        const t = fs.readFileSync(p, 'utf8');
        if (t.includes('<deck-stage') || t.includes('__bundler/manifest')) out.push(p);
      } catch {}
    }
  }
  return out;
}

let failed = 0, checked = 0;
if (all) {
  const decks = findDecks(path.resolve(target));
  if (!decks.length) { console.log('No decks found under ' + target); process.exit(0); }
  for (const d of decks) { failed += report(d, checkDeck(d)) ? 1 : 0; checked++; }
  console.log(`\n${C.b}${checked} deck(s) checked — ${failed ? C.r + failed + ' failing' : C.g + 'all good'}${C.x}\n`);
} else {
  failed = report(path.resolve(target), checkDeck(path.resolve(target))) ? 1 : 0;
  console.log('');
}
process.exit(failed ? 1 : 0);
