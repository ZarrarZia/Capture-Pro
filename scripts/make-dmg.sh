#!/bin/bash
# Creates CapturePro-<version>-mac-<arch>.dmg from the .app electron-builder produced, using macOS's
# hdiutil directly (a window with CapturePro and an Applications shortcut to drag it onto).
# Usage: scripts/make-dmg.sh arm64|x64
set -euo pipefail
ARCH="$1"
cd "$(dirname "$0")/.."
VERSION=$(node -p "require('./package.json').version")
APP_DIR=$([ "$ARCH" = arm64 ] && echo dist/mac-arm64 || echo dist/mac)
APP="$APP_DIR/CapturePro.app"
OUT="dist/CapturePro-$VERSION-mac-$ARCH.dmg"
[ -d "$APP" ] || { echo "missing $APP"; exit 1; }

STAGE=$(mktemp -d)
ditto "$APP" "$STAGE/CapturePro.app"   # ditto keeps the code signature intact
ln -s /Applications "$STAGE/Applications"
rm -f "$OUT"
for attempt in 1 2 3 4 5; do
  if hdiutil create -volname "CapturePro" -srcfolder "$STAGE" -ov -format UDZO "$OUT"; then break; fi
  echo "hdiutil busy, retrying ($attempt)…"; sleep 5
done
rm -rf "$STAGE"
[ -f "$OUT" ] || { echo "DMG was not created"; exit 1; }
hdiutil verify "$OUT"
echo "created $OUT"
