#!/usr/bin/env bash
# CUE — start script. Linux / Debian (also works on macOS).
cd "$(dirname "$0")" || exit 1

NODE="$(command -v node 2>/dev/null || command -v nodejs 2>/dev/null)"
if [ -z "$NODE" ]; then
  cat <<'EOF'

  CUE needs Node.js, which is not installed yet.

  Debian / Ubuntu:   sudo apt install nodejs
  Fedora:            sudo dnf install nodejs
  Arch:              sudo pacman -S nodejs
  Or download from:  https://nodejs.org/en/download

  Then run this script again.

EOF
  exit 1
fi

exec "$NODE" start.mjs "$@"
