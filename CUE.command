#!/bin/zsh
# CUE — browser launcher. Double-click to start the server and open
# the library. (The native app in native/ is the richer way to run it.)
cd "$(dirname "$0")"
# Decks folder: from native/cue.conf (WORKSHOP_DIR), else this folder.
[ -f native/cue.conf ] && source ./native/cue.conf
ROOT="${WORKSHOP_DIR:-$PWD}"
# Find node even when Homebrew has it as an unlinked keg (e.g. node@24).
NODE="$(command -v node)"
if [ -z "$NODE" ]; then
  for p in /opt/homebrew/bin/node /usr/local/bin/node \
           /opt/homebrew/opt/node*/bin/node(N) /usr/local/opt/node*/bin/node(N); do
    [ -x "$p" ] && NODE="$p" && break
  done
fi
if [ -z "$NODE" ]; then
  osascript -e 'display alert "CUE" message "Node.js was not found. Install it from nodejs.org (or brew install node), then try again."'
  exit 1
fi
if ! lsof -ti tcp:4321 >/dev/null 2>&1; then
  CUE_ROOT="$ROOT" nohup "$NODE" server.mjs >/tmp/cue.log 2>&1 &
  sleep 0.6
fi
open "http://localhost:4321"
