#!/bin/zsh
# Build DeckManager.app from DeckManagerApp.swift with swiftc, sign it with
# your Developer ID (no Xcode project). Output: deck-manager/native/DeckManager.app
#
#   cd deck-manager/native && ./build.sh
#   open DeckManager.app
#
# Signed with a Developer ID Application cert + hardened runtime, so it launches
# with no Gatekeeper "unsigned" prompt on this Mac. To hand it to OTHER Macs
# warning-free, notarize it too — see the commented block at the end.

set -e
cd "$(dirname "$0")"                        # deck-manager/native
NATIVE_DIR="$(pwd)"
APP="DeckManager.app"
BUNDLE="$APP/Contents"

# ── Local, un-committed config (native/deck-manager.conf, gitignored) ─────────
# Keeps your personal path + cert out of the public repo. Example file:
#   WORKSHOP_DIR="/Users/you/Decks"
#   SIGN_IDENTITY="Developer ID Application: Your Name (TEAMID)"
[ -f deck-manager.conf ] && source ./deck-manager.conf

# The folder that holds your decks (baked into the app as its default; you can
# still change it at runtime via File ▸ Open Workshop Folder…). Override with
# env or deck-manager.conf. Empty ⇒ the app defaults to ~/Desktop on first run.
: ${WORKSHOP_DIR:=""}

# Signing identity. Empty ⇒ ad-hoc sign (runs locally; other Macs need it signed
# with a real Developer ID). Override with env or deck-manager.conf.
: ${SIGN_IDENTITY:="-"}

echo "▸ Compiling DeckManagerApp.swift …"
rm -rf "$APP"
mkdir -p "$BUNDLE/MacOS" "$BUNDLE/Resources"

swiftc -parse-as-library -O \
    -o "$BUNDLE/MacOS/DeckManager" \
    DeckManagerApp.swift

cp Info.plist "$BUNDLE/Info.plist"

# Bake the decks folder into the bundle's Info.plist so the signed app opens it
# by default — WITHOUT an external symlink (a symlink to an absolute path outside
# the bundle breaks codesign/notarization). Skipped when WORKSHOP_DIR is empty.
/usr/libexec/PlistBuddy -c "Delete :WorkshopFolder" "$BUNDLE/Info.plist" 2>/dev/null || true
if [ -n "$WORKSHOP_DIR" ]; then
    /usr/libexec/PlistBuddy -c "Add :WorkshopFolder string $WORKSHOP_DIR" "$BUNDLE/Info.plist"
    echo "▸ Decks folder: $WORKSHOP_DIR"
else
    echo "▸ No WORKSHOP_DIR set — app will default to ~/Desktop (change via File ▸ Open Workshop Folder…)"
fi

# Optional icon.
if [ -f AppIcon.icns ]; then
    cp AppIcon.icns "$BUNDLE/Resources/AppIcon.icns"
    /usr/libexec/PlistBuddy -c "Add :CFBundleIconFile string AppIcon" "$BUNDLE/Info.plist" 2>/dev/null || true
fi

# Real Developer ID identities get a hardened runtime + secure timestamp;
# ad-hoc ("-") signing skips the timestamp (no timestamp service for ad-hoc).
if [ "$SIGN_IDENTITY" = "-" ]; then
    echo "▸ Ad-hoc signing (set SIGN_IDENTITY in deck-manager.conf for a Developer ID)"
    SIGN_ARGS=(--force --sign -)
else
    echo "▸ Signing with: $SIGN_IDENTITY"
    SIGN_ARGS=(--force --options runtime --timestamp --sign "$SIGN_IDENTITY")
fi
codesign "${SIGN_ARGS[@]}" "$BUNDLE/MacOS/DeckManager"
codesign "${SIGN_ARGS[@]}" "$APP"

echo "▸ Verifying signature …"
codesign --verify --strict --verbose=2 "$APP"
spctl -a -vv "$APP" 2>&1 || true   # unnotarized Developer ID / ad-hoc is expected & fine locally

echo "✓ Built + signed $NATIVE_DIR/$APP"
echo "  Launch it:  open \"$NATIVE_DIR/$APP\""

# ── Notarization (optional — for warning-free use on OTHER Macs) ──────────────
# Requires a real Developer ID identity (above) plus a one-time notarytool
# credential (app-specific password from appleid.apple.com):
#   xcrun notarytool store-credentials deckmanager \
#     --apple-id "you@example.com" --team-id "YOURTEAMID" --password "xxxx-xxxx-xxxx-xxxx"
# Then, after signing above:
#   ditto -c -k --keepParent "$APP" "DeckManager.zip"
#   xcrun notarytool submit "DeckManager.zip" --keychain-profile deckmanager --wait
#   xcrun stapler staple "$APP"
