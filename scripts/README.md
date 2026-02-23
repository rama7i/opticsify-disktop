# Build Scripts

## notarize.js

This is an `afterSign` hook that runs during the electron-builder build process.

### Purpose
- Signs the macOS app with an ad-hoc signature (`codesign --sign -`)
- Runs **before** electron-builder creates DMG and ZIP files
- Ensures apps inside packaged files are properly signed

### How It Works
1. electron-builder builds the `.app` bundle
2. **This script runs** and signs the app
3. electron-builder packages the signed app into DMG and ZIP
4. Result: All distributed files contain signed apps

### Ad-hoc Signing
Ad-hoc signing (with `-` identity) allows macOS to:
- Show "Open Anyway" option in System Preferences
- Run the app without notarization
- Verify the app's integrity

For production, replace this with proper Apple Developer certificate signing.

