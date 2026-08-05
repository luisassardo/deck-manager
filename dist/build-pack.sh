#!/bin/zsh
# Build the cross-platform portable pack: dist/CUE-portable.zip
#
#   ./dist/build-pack.sh [version]
#
# The zip runs as-is on macOS, Windows and Linux — the only prerequisite on the
# trainer's machine is Node.js.

set -e
cd "$(dirname "$0")/.."          # repo root
ROOT="$(pwd)"
VERSION="${1:-$(date +%Y.%m.%d)}"
STAGE="$(mktemp -d)/CUE"
OUT="$ROOT/dist/CUE-portable.zip"

mkdir -p "$STAGE"

# --- the tool itself -------------------------------------------------------
cp server.mjs start.mjs library.html edit-mode.js external-mode.js \
   presenter.js presenter.html annotate.js translate.html \
   unbundle.mjs cue-doctor.mjs AUTHORING.md LICENSE "$STAGE/"
cp -R templates "$STAGE/templates"
mkdir -p "$STAGE/brand" && cp -R brand/icons "$STAGE/brand/icons"

# --- launchers + docs ------------------------------------------------------
cp "dist/Start CUE (macOS).command" "dist/Start CUE (Windows).bat" \
   dist/start-cue.sh dist/README.txt "$STAGE/"
chmod +x "$STAGE/Start CUE (macOS).command" "$STAGE/start-cue.sh"

echo "$VERSION" > "$STAGE/VERSION"

# Keep macOS metadata out of the archive so it looks clean on Windows/Linux.
( cd "$(dirname "$STAGE")" && \
  zip -qr "$OUT" CUE -x '*.DS_Store' -x '__MACOSX/*' )
rm -rf "$(dirname "$STAGE")"

echo "✓ $OUT  ($VERSION, $(du -h "$OUT" | cut -f1))"
echo "  Publish:  gh release create v$VERSION \"$OUT\" --title \"CUE $VERSION\" --notes-file dist/RELEASE_NOTES.md"
