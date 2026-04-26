#!/usr/bin/env bash
# Builds, installs, and launches the iOS app on the connected iPhone.
# Run after `npm run sync` when you want to push to the device without opening Xcode.
set -euo pipefail

DEVICE_UDID="00008120-001155543E98201E"
WORKSPACE="ios/App/App.xcworkspace"
SCHEME="App"
DERIVED_DATA_BASE="$HOME/Library/Developer/Xcode/DerivedData"

echo "▶ Building for device…"
xcodebuild \
  -workspace "$WORKSPACE" \
  -scheme "$SCHEME" \
  -configuration Debug \
  -destination "id=$DEVICE_UDID" \
  build | grep -E "error:|BUILD (SUCCEEDED|FAILED)" | grep -v "warning:"

APP_PATH=$(find "$DERIVED_DATA_BASE"/App-*/Build/Products/Debug-iphoneos -name "App.app" -maxdepth 1 2>/dev/null | head -1)
if [[ -z "$APP_PATH" ]]; then
  echo "❌ App.app not found in DerivedData" >&2
  exit 1
fi

echo "▶ Installing to device…"
xcrun devicectl device install app --device "$DEVICE_UDID" "$APP_PATH"

echo "▶ Launching…"
xcrun devicectl device process launch --device "$DEVICE_UDID" ourmahjong.club.app

echo "✅ Done — app is running on device"
