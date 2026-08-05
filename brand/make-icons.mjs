#!/usr/bin/env node
/**
 * Build every platform icon from brand/icon-1024.png.
 *   node brand/make-icons.mjs
 *
 * Produces:
 *   brand/AppIcon.icns          macOS app bundle
 *   brand/cue.ico               Windows
 *   brand/icons/<n>x<n>.png     Linux (hicolor theme sizes) + web favicon
 *
 * PNG resizing uses macOS `sips` when available (no dependencies); the .ico is
 * written here directly since an ICO file is just a small header plus embedded
 * PNGs.
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(DIR, 'icon-1024.png');
if (!fs.existsSync(SRC)) {
  console.error('Missing ' + SRC + ' — render brand/icon-source.html first.');
  process.exit(1);
}

const outDir = path.join(DIR, 'icons');
fs.mkdirSync(outDir, { recursive: true });

const hasSips = (() => {
  try { execFileSync('sips', ['--version'], { stdio: 'ignore' }); return true; } catch { return false; }
})();
if (!hasSips) { console.error('sips not available (macOS only) — run this on a Mac.'); process.exit(1); }

const resize = (size, dest) =>
  execFileSync('sips', ['-z', String(size), String(size), SRC, '--out', dest], { stdio: 'ignore' });

// ---- Linux / web -----------------------------------------------------------
const PNG_SIZES = [16, 24, 32, 48, 64, 128, 256, 512, 1024];
for (const s of PNG_SIZES) resize(s, path.join(outDir, `${s}x${s}.png`));
console.log('✓ PNGs → brand/icons/');

// ---- macOS .icns -----------------------------------------------------------
const iconset = path.join(DIR, 'AppIcon.iconset');
fs.rmSync(iconset, { recursive: true, force: true });
fs.mkdirSync(iconset);
for (const s of [16, 32, 128, 256, 512]) {
  resize(s, path.join(iconset, `icon_${s}x${s}.png`));
  resize(s * 2, path.join(iconset, `icon_${s}x${s}@2x.png`));
}
execFileSync('iconutil', ['-c', 'icns', iconset, '-o', path.join(DIR, 'AppIcon.icns')]);
fs.rmSync(iconset, { recursive: true, force: true });
console.log('✓ AppIcon.icns');

// ---- Windows .ico ----------------------------------------------------------
// ICO = 6-byte header + 16-byte directory entry per image + the PNG payloads.
const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256];
const images = ICO_SIZES.map((s) => ({ s, buf: fs.readFileSync(path.join(outDir, `${s}x${s}.png`)) }));
const header = Buffer.alloc(6);
header.writeUInt16LE(0, 0);              // reserved
header.writeUInt16LE(1, 2);              // type: icon
header.writeUInt16LE(images.length, 4);
let offset = 6 + images.length * 16;
const dir = [];
for (const { s, buf } of images) {
  const e = Buffer.alloc(16);
  e.writeUInt8(s >= 256 ? 0 : s, 0);     // width  (0 means 256)
  e.writeUInt8(s >= 256 ? 0 : s, 1);     // height
  e.writeUInt8(0, 2);                    // palette
  e.writeUInt8(0, 3);                    // reserved
  e.writeUInt16LE(1, 4);                 // colour planes
  e.writeUInt16LE(32, 6);                // bits per pixel
  e.writeUInt32LE(buf.length, 8);
  e.writeUInt32LE(offset, 12);
  offset += buf.length;
  dir.push(e);
}
fs.writeFileSync(path.join(DIR, 'cue.ico'),
  Buffer.concat([header, ...dir, ...images.map((i) => i.buf)]));
console.log('✓ cue.ico');
