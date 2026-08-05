#!/bin/zsh
# CUE — double-click to start. macOS.
cd "$(dirname "$0")"

NODE="$(command -v node 2>/dev/null)"
if [ -z "$NODE" ]; then
  for p in /opt/homebrew/bin/node /usr/local/bin/node /opt/homebrew/opt/node*/bin/node(N) /usr/local/opt/node*/bin/node(N); do
    [ -x "$p" ] && NODE="$p" && break
  done
fi
if [ -z "$NODE" ]; then
  osascript -e 'display alert "CUE needs Node.js" message "Node.js is not installed on this Mac.

Install it once from nodejs.org (choose the LTS version), then double-click this file again." buttons {"Open nodejs.org", "Cancel"} default button 1' \
    -e 'if button returned of result is "Open nodejs.org" then open location "https://nodejs.org/en/download"'
  exit 1
fi

exec "$NODE" start.mjs "$@"
