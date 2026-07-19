#!/usr/bin/env bash
# Package AgentsBar.app into a compressed DMG (ad-hoc / unsigned distribution).
#
# Usage:
#   ./scripts/build.sh
#   ./scripts/package-dmg.sh
#   VERSION=0.1.0 ./scripts/package-dmg.sh /path/to/AgentsBar.app
#
# Env:
#   VERSION          default: CFBundleShortVersionString from the app, else 0.0.0
#   APP_PATH         default: build/Build/Products/Release/AgentsBar.app
#   OUTPUT_DIR       default: dist/
#   DMG_NAME         default: AgentsBar-${VERSION}.dmg
#   VOLUME_NAME      default: AgentsBar
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

APP_PATH="${1:-${APP_PATH:-${ROOT}/build/Build/Products/Release/AgentsBar.app}}"
if [[ ! -d "$APP_PATH" ]]; then
  echo "App not found: $APP_PATH" >&2
  echo "Run ./scripts/build.sh first (or pass the .app path)." >&2
  exit 1
fi

if [[ -z "${VERSION:-}" ]]; then
  VERSION="$(
    /usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' \
      "${APP_PATH}/Contents/Info.plist" 2>/dev/null || true
  )"
fi
VERSION="${VERSION:-0.0.0}"
# Strip leading v if someone passed a tag.
VERSION="${VERSION#v}"

OUTPUT_DIR="${OUTPUT_DIR:-${ROOT}/dist}"
VOLUME_NAME="${VOLUME_NAME:-AgentsBar}"
DMG_NAME="${DMG_NAME:-AgentsBar-${VERSION}.dmg}"
DMG_PATH="${OUTPUT_DIR}/${DMG_NAME}"

STAGE="$(mktemp -d "${TMPDIR:-/tmp}/agentsbar-dmg.XXXXXX")"
cleanup() { rm -rf "$STAGE"; }
trap cleanup EXIT

mkdir -p "$STAGE" "$OUTPUT_DIR"
# Fresh copy so we never mutate the build product while mounting.
ditto "$APP_PATH" "${STAGE}/AgentsBar.app"
ln -s /Applications "${STAGE}/Applications"

# Optional: tiny README on the volume for Gatekeeper note.
cat > "${STAGE}/README.txt" <<EOF
AgentsBar ${VERSION}
====================

1. Drag AgentsBar.app to Applications.
2. Open AgentsBar from Applications (or Spotlight).
3. If macOS blocks the app (unsigned / ad-hoc build):
   System Settings → Privacy & Security → Open Anyway

This build is for open-source / personal use and is not Developer ID notarized.
EOF

# Remove any previous image with the same name.
rm -f "$DMG_PATH"

# UDZO = zlib-compressed read-only image. No create-dmg dependency.
hdiutil create \
  -volname "$VOLUME_NAME" \
  -srcfolder "$STAGE" \
  -ov \
  -format UDZO \
  -fs HFS+ \
  "$DMG_PATH"

# Detach anything that auto-mounted (rare with create -srcfolder).
hdiutil detach "/Volumes/${VOLUME_NAME}" >/dev/null 2>&1 || true

echo "DMG: $DMG_PATH"
ls -lh "$DMG_PATH"

# Emit GitHub Actions outputs when running in CI.
if [[ -n "${GITHUB_OUTPUT:-}" ]]; then
  {
    echo "dmg_path=${DMG_PATH}"
    echo "dmg_name=${DMG_NAME}"
    echo "version=${VERSION}"
  } >> "$GITHUB_OUTPUT"
fi
