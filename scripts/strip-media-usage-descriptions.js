/**
 * afterPack hook: Remove NSMicrophoneUsageDescription from the built macOS
 * app's Info.plist so the app never triggers a system microphone prompt.
 * NSCameraUsageDescription is intentionally kept so the camera works.
 */
const fs = require('fs');
const path = require('path');

exports.default = async function(context) {
  const { electronPlatformName, appOutDir, packager } = context;

  if (electronPlatformName !== 'darwin') {
    return;
  }

  const appPath = path.join(appOutDir, `${packager.appInfo.productFilename}.app`);
  const plistPath = path.join(appPath, 'Contents', 'Info.plist');

  if (!fs.existsSync(plistPath)) {
    console.warn('⚠️ [strip-media-usage] Info.plist not found:', plistPath);
    return;
  }

  let plist = fs.readFileSync(plistPath, 'utf8');
  const keysToRemove = ['NSMicrophoneUsageDescription'];

  for (const key of keysToRemove) {
    // Remove <key>KeyName</key> followed by <string>...</string> (with flexible whitespace)
    const regex = new RegExp(
      `\\s*<key>${key}<\\/key>\\s*<string>[^<]*<\\/string>\\s*`,
      'g'
    );
    const before = plist;
    plist = plist.replace(regex, '\n');
    if (plist !== before) {
      console.log(`✅ [strip-media-usage] Removed ${key} from Info.plist`);
    }
  }

  fs.writeFileSync(plistPath, plist, 'utf8');
};
