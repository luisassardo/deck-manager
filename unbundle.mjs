/**
 * unbundle.mjs — extract a claude.ai single-file bundled deck into an
 * editable folder.
 *
 * Bundle format (all inside one .html):
 *   <script type="__bundler/manifest">      {uuid: {mime, compressed, data}}
 *   <script type="__bundler/template">      JSON string of the original HTML,
 *                                           with asset URLs replaced by uuids
 *   <script type="__bundler/ext_resources"> optional [{id, uuid}] map exposed
 *                                           to the page as window.__resources
 *
 * Output: <outDir>/<Title>.html + <outDir>/assets/* with uuid references
 * rewritten to relative paths. The original bundled file is not touched.
 *
 * CLI: node unbundle.mjs "<bundled.html>" "<output folder>"
 */

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const MIME_EXT = {
  'text/javascript': 'js', 'application/javascript': 'js', 'module': 'js',
  'text/css': 'css', 'text/html': 'html', 'application/json': 'json',
  'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif',
  'image/svg+xml': 'svg', 'image/webp': 'webp', 'image/x-icon': 'ico',
  'font/woff2': 'woff2', 'font/woff': 'woff', 'font/ttf': 'ttf', 'font/otf': 'otf',
  'audio/mpeg': 'mp3', 'video/mp4': 'mp4', 'application/pdf': 'pdf',
};

function extractScript(html, type) {
  const re = new RegExp('<script type="' + type.replace(/[/\\]/g, '\\$&') + '"[^>]*>([\\s\\S]*?)</script>');
  const m = html.match(re);
  return m ? m[1] : null;
}

function sanitizeName(name) {
  return name.replace(/[/\\:*?"<>|]/g, '-').replace(/\s+/g, ' ').trim();
}

/** Guess a friendly filename for a decoded text asset. */
function guessName(bytes, mime, seq) {
  const ext = MIME_EXT[mime] || 'bin';
  if (ext === 'js' || ext === 'css' || ext === 'json') {
    const head = bytes.slice(0, 2000).toString('utf8');
    const m = head.match(/<deck-stage>|deck-stage\.js/);
    if (ext === 'js' && m) return 'deck-stage.js';
  }
  return 'asset-' + String(seq).padStart(2, '0') + '.' + ext;
}

export function unbundle(bundlePath, outDir) {
  const html = fs.readFileSync(bundlePath, 'utf8');
  const manifestSrc = extractScript(html, '__bundler/manifest');
  const templateSrc = extractScript(html, '__bundler/template');
  if (!manifestSrc || !templateSrc) {
    throw new Error('Not a bundled file: missing __bundler/manifest or __bundler/template');
  }
  const manifest = JSON.parse(manifestSrc);
  let template = JSON.parse(templateSrc);
  const extSrc = extractScript(html, '__bundler/ext_resources');
  const extResources = extSrc ? JSON.parse(extSrc) : [];

  fs.mkdirSync(outDir, { recursive: true });
  const assetsDir = path.join(outDir, 'assets');
  const written = [];

  // Some references carry the original filename as a fragment: `<uuid>#/name.js`.
  // Prefer those names; fall back to a mime-based guess.
  const preferred = {};
  for (const m of template.matchAll(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})#\/([^"')\s>]+)/g)) {
    preferred[m[1]] = sanitizeName(m[2].split('/').pop());
  }

  // Decode every asset and rewrite its uuid in the template to a relative path.
  const names = new Set();
  let seq = 0;
  const uuidToPath = {};
  for (const [uuid, entry] of Object.entries(manifest)) {
    let bytes = Buffer.from(entry.data, 'base64');
    if (entry.compressed) bytes = zlib.gunzipSync(bytes);
    seq += 1;
    let name = preferred[uuid] || guessName(bytes, entry.mime, seq);
    while (names.has(name)) name = seq + '-' + name;
    names.add(name);
    if (!fs.existsSync(assetsDir)) fs.mkdirSync(assetsDir);
    fs.writeFileSync(path.join(assetsDir, name), bytes);
    const rel = 'assets/' + name;
    uuidToPath[uuid] = rel;
    template = template.replace(new RegExp(uuid + '#/[^"\')\\s>]*', 'g'), rel);
    template = template.split(uuid).join(rel);
    written.push(rel);
  }

  // Mirror the loader's window.__resources injection for decks that use it.
  if (extResources.length) {
    const map = {};
    for (const e of extResources) {
      if (uuidToPath[e.uuid]) map[e.id] = uuidToPath[e.uuid];
    }
    const tag = '<script>window.__resources = ' + JSON.stringify(map) + ';</script>';
    const headOpen = template.match(/<head[^>]*>/i);
    if (headOpen) {
      const i = headOpen.index + headOpen[0].length;
      template = template.slice(0, i) + tag + template.slice(i);
    }
  }

  const title = (template.match(/<title>([^<]*)<\/title>/i) || [])[1];
  const name = sanitizeName(title && title.trim() ? title.trim() : path.basename(bundlePath, '.html'));

  // Static x-dc documents (the newer claude.ai deck format) get converted to
  // the plain <deck-stage> format so the manager can edit them.
  const normalized = normalizeXdc(template, name);
  if (normalized) template = normalized;

  const outName = name + '.html';
  const outFile = path.join(outDir, outName);
  fs.writeFileSync(outFile, template);
  written.unshift(outName);
  return { outFile, files: written, normalized: !!normalized };
}

/**
 * Convert a *static* x-dc wrapper document to a plain <deck-stage> page:
 *
 *   <head>…dc-runtime…</head>                 <head>…helmet content…
 *   <body><x-dc>                                <script src="deck-stage.js">
 *     <helmet>fonts/styles</helmet>     →     </head>
 *     <x-import component-from-global-scope   <body>
 *       ="deck-stage" from="…" w h>             <deck-stage width height>
 *       <section>…                                <section>…
 *
 * Returns the converted HTML, or null when the document isn't an x-dc
 * deck-stage doc or uses template features ({{ }}, x-for, …) that a plain
 * page can't express — those stay in their original form, view-only.
 */
export function normalizeXdc(html, title) {
  if (!/<x-dc[\s>]/.test(html)) return null;
  if (/\{\{|<x-for\b|<x-if\b|<x-var\b|x-state/.test(html)) return null;
  const imp = html.match(/<x-import\b([^>]*component-from-global-scope="deck-stage"[^>]*)>([\s\S]*?)<\/x-import>/i);
  if (!imp) return null;
  const attrs = imp[1];
  const from = (attrs.match(/\bfrom="([^"]+)"/) || [])[1] || 'assets/deck-stage.js';
  const w = (attrs.match(/\bwidth="(\d+)"/) || [])[1] || '1920';
  const h = (attrs.match(/\bheight="(\d+)"/) || [])[1] || '1080';
  const helmet = (html.match(/<helmet>([\s\S]*?)<\/helmet>/i) || [, ''])[1];
  return '<!DOCTYPE html>\n<html lang="en">\n<head>\n<meta charset="UTF-8">\n' +
    '<meta name="viewport" content="width=device-width, initial-scale=1">\n' +
    '<title>' + title + '</title>\n' +
    helmet.trim() + '\n' +
    '<style>deck-stage:not(:defined){visibility:hidden}</style>\n' +
    '<script src="' + from + '"></script>\n' +
    '</head>\n<body>\n' +
    '<deck-stage width="' + w + '" height="' + h + '">\n' +
    imp[2].trim() + '\n' +
    '</deck-stage>\n</body>\n</html>\n';
}

// CLI
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [src, out] = process.argv.slice(2);
  if (!src || !out) {
    console.error('Usage: node unbundle.mjs "<bundled.html>" "<output folder>"');
    process.exit(1);
  }
  const res = unbundle(src, out);
  console.log('Unbundled to ' + res.outFile);
  res.files.forEach((f) => console.log('  ' + f));
}
