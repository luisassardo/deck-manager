#!/usr/bin/env node
/**
 * CUE launcher — cross-platform entry point.
 *
 *   node start.mjs                 use the saved decks folder (asks on first run)
 *   node start.mjs "/path/decks"   use (and remember) that folder
 *   node start.mjs --pick          re-ask for the folder
 *
 * Picks a free port, starts the server, opens the browser. The decks folder is
 * remembered in cue.conf next to this file. On first run it asks with the
 * platform's native folder picker (macOS osascript, Windows PowerShell, Linux
 * zenity/kdialog) and falls back to a terminal prompt.
 */
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import readline from 'node:readline';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CONF = path.join(HERE, 'cue.conf');
const argv = process.argv.slice(2);
const repick = argv.includes('--pick');
const argPath = argv.find((a) => !a.startsWith('-'));

const isDir = (p) => { try { return !!p && fs.statSync(p).isDirectory(); } catch { return false; } };

function readConf() {
  try {
    const m = fs.readFileSync(CONF, 'utf8').match(/^\s*DECKS_FOLDER\s*=\s*"?(.*?)"?\s*$/m);
    return m ? m[1] : null;
  } catch { return null; }
}
function writeConf(dir) {
  fs.writeFileSync(CONF,
    '# CUE — the folder that holds your decks. Edit this path or run with --pick.\n' +
    'DECKS_FOLDER="' + dir + '"\n');
}

/** Native folder picker, per platform. Returns a path or null. */
function pickFolder() {
  const title = 'Choose the folder that holds your presentations';
  try {
    if (process.platform === 'darwin') {
      const out = execFileSync('osascript', ['-e',
        `POSIX path of (choose folder with prompt "${title}")`], { encoding: 'utf8' });
      return out.trim() || null;
    }
    if (process.platform === 'win32') {
      const ps = `Add-Type -AssemblyName System.Windows.Forms
$d = New-Object System.Windows.Forms.FolderBrowserDialog
$d.Description = "${title}"
if ($d.ShowDialog() -eq "OK") { Write-Output $d.SelectedPath }`;
      const out = execFileSync('powershell', ['-NoProfile', '-STA', '-Command', ps], { encoding: 'utf8' });
      return out.trim() || null;
    }
    for (const [bin, args] of [
      ['zenity', ['--file-selection', '--directory', '--title=' + title]],
      ['kdialog', ['--getexistingdirectory', process.env.HOME || '.']],
    ]) {
      try { return execFileSync(bin, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() || null; }
      catch { /* try the next one */ }
    }
  } catch { /* cancelled or unavailable → fall through */ }
  return null;
}

async function askPath() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise((r) =>
    rl.question('\nPath to the folder holding your presentations:\n> ', r));
  rl.close();
  return answer.trim().replace(/^['"]|['"]$/g, '');
}

async function resolveDecksFolder() {
  if (argPath && isDir(path.resolve(argPath))) return path.resolve(argPath);
  if (!repick) {
    const saved = readConf();
    if (isDir(saved)) return saved;
    if (isDir(process.env.CUE_ROOT)) return path.resolve(process.env.CUE_ROOT);
  }
  console.log('\n  CUE — The HTML Presentation Studio\n');
  console.log('  Choose the folder that holds your presentations…');
  let picked = pickFolder();
  if (!isDir(picked) && process.stdin.isTTY) picked = await askPath();
  if (!isDir(picked)) {
    // Last resort so CUE always starts: a "Presentations" folder beside the app.
    picked = path.join(HERE, 'Presentations');
    fs.mkdirSync(picked, { recursive: true });
    console.log('  No folder chosen — using ' + picked);
  }
  return path.resolve(picked);
}

const freePort = (start) => new Promise((resolve) => {
  const probe = (p) => {
    const s = net.createServer();
    s.once('error', () => (p < start + 40 ? probe(p + 1) : resolve(start)));
    s.once('listening', () => s.close(() => resolve(p)));
    s.listen(p, '127.0.0.1');
  };
  probe(start);
});

function openBrowser(url) {
  const [bin, args] = process.platform === 'darwin' ? ['open', [url]]
    : process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]]
    : ['xdg-open', [url]];
  try { spawn(bin, args, { stdio: 'ignore', detached: true }).unref(); }
  catch { console.log('Open this in your browser: ' + url); }
}

const decks = await resolveDecksFolder();
writeConf(decks);
const port = await freePort(Number(process.env.CUE_PORT) || 4321);
process.env.CUE_ROOT = decks;
process.env.CUE_PORT = String(port);

await import('./server.mjs');            // starts listening; logs its own banner
const url = 'http://localhost:' + port;
setTimeout(() => openBrowser(url), 600);
console.log('\n  Decks folder: ' + decks);
console.log('  Change it any time:  node start.mjs --pick');
console.log('  Close this window to stop CUE.\n');
