#!/bin/bash
set -e

APP_NAME="Opticsify Desktop.app"

echo "Building macOS app..."
npm run build:mac

echo "Signing app with ad-hoc signature..."
if [ -d "dist/mac/$APP_NAME" ]; then
    codesign --force --deep -s - "dist/mac/$APP_NAME"
    echo "Intel x64 app signed (ad-hoc)"
fi

if [ -d "dist/mac-arm64/$APP_NAME" ]; then
    codesign --force --deep -s - "dist/mac-arm64/$APP_NAME"
    echo "Apple Silicon app signed (ad-hoc)"
fi

echo "Verifying signatures..."
codesign -dv --verbose=4 "dist/mac/$APP_NAME" 2>&1 | grep -E "(Identifier|Authority|TeamIdentifier)" || true
codesign -dv --verbose=4 "dist/mac-arm64/$APP_NAME" 2>&1 | grep -E "(Identifier|Authority|TeamIdentifier)" || true

echo "✅ Build + ad-hoc signing complete."
echo "⚠️ Note: Apps signed ad-hoc cannot be notarized and users will see 'Unidentified developer'."
