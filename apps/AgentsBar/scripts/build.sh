#!/usr/bin/env bash
# Build AgentsBar.app (ad-hoc signed) for local use or CI.
# Optional:
#   VERSION=0.1.0           → MARKETING_VERSION + CFBundleShortVersionString
#   BUILD_NUMBER=42         → CURRENT_PROJECT_VERSION (defaults to VERSION or 1)
#   ./scripts/build.sh --install   → copy to ~/Applications
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

if ! xcodebuild -version >/dev/null 2>&1; then
  if [[ -d /Applications/Xcode.app ]]; then
    echo "Switching developer directory to Xcode (may prompt for password)..."
    sudo xcode-select -s /Applications/Xcode.app/Contents/Developer
  else
    echo "Xcode is required. Install Xcode, then: sudo xcode-select -s /Applications/Xcode.app/Contents/Developer" >&2
    exit 1
  fi
fi

CONFIGURATION="${CONFIGURATION:-Release}"
DERIVED="${DERIVED_DATA_PATH:-${ROOT}/build}"
VERSION="${VERSION:-}"
BUILD_NUMBER="${BUILD_NUMBER:-${VERSION:-1}}"

EXTRA_SETTINGS=()
if [[ -n "$VERSION" ]]; then
  EXTRA_SETTINGS+=(
    MARKETING_VERSION="$VERSION"
    CURRENT_PROJECT_VERSION="$BUILD_NUMBER"
  )
fi

xcodebuild \
  -project AgentsBar.xcodeproj \
  -scheme AgentsBar \
  -configuration "$CONFIGURATION" \
  -derivedDataPath "$DERIVED" \
  CODE_SIGN_IDENTITY="-" \
  CODE_SIGNING_ALLOWED=YES \
  ${EXTRA_SETTINGS[@]+"${EXTRA_SETTINGS[@]}"} \
  build

APP="${DERIVED}/Build/Products/${CONFIGURATION}/AgentsBar.app"
if [[ ! -d "$APP" ]]; then
  echo "Build finished but app missing: $APP" >&2
  exit 1
fi

echo "Built: $APP"
if [[ -n "$VERSION" ]]; then
  echo "Version: $VERSION ($BUILD_NUMBER)"
fi

if [[ "${1:-}" == "--install" ]]; then
  mkdir -p "${HOME}/Applications"
  rm -rf "${HOME}/Applications/AgentsBar.app"
  cp -R "$APP" "${HOME}/Applications/AgentsBar.app"
  echo "Installed: ${HOME}/Applications/AgentsBar.app"
  open "${HOME}/Applications/AgentsBar.app" || true
fi
