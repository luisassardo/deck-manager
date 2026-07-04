#!/bin/zsh
# Deck Manager — browser launcher. Double-click to start the server and open
# the library. (The native app in native/ is the richer way to run it.)
cd "$(dirname "$0")"
# Decks folder: from native/deck-manager.conf (WORKSHOP_DIR), else this folder.
[ -f native/deck-manager.conf ] && source ./native/deck-manager.conf
ROOT="${WORKSHOP_DIR:-$PWD}"
if ! lsof -ti tcp:4321 >/dev/null 2>&1; then
  DECK_MANAGER_ROOT="$ROOT" nohup node server.mjs >/tmp/deck-manager.log 2>&1 &
  sleep 0.6
fi
open "http://localhost:4321"
