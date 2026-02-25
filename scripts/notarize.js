const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');

// Load .env credentials into process.env (values already in env take priority)
function loadEnv() {
  const envFile = path.join(__dirname, '..', '.env');
  if (!fs.existsSync(envFile)) return;
  fs.readFileSync(envFile, 'utf8')
    .split('\n')
    .forEach(line => {
      line = line.trim();
      if (!line || line.startsWith('#')) return;
      const eq = line.indexOf('=');
      if (eq === -1) return;
      const key = line.slice(0, eq).trim();
      const val = line.slice(eq + 1).trim();
      if (key && !process.env[key]) process.env[key] = val;
    });
}

exports.default = async function notarize(context) {
  const { electronPlatformName, appOutDir } = context;

  // Only notarize macOS builds
  if (electronPlatformName !== 'darwin') return;

  // Skip in dev/unsigned builds (CSC_IDENTITY_AUTO_DISCOVERY=false means no cert)
  if (process.env.CSC_IDENTITY_AUTO_DISCOVERY === 'false') {
    console.log('⏭  Notarization skipped (dev build / no signing)');
    return;
  }

  loadEnv();

  const { APPLE_ID, APPLE_APP_SPECIFIC_PASSWORD, APPLE_TEAM_ID } = process.env;

  if (!APPLE_ID || !APPLE_APP_SPECIFIC_PASSWORD || !APPLE_TEAM_ID) {
    console.warn('⚠️  Notarization skipped — missing credentials in .env:');
    if (!APPLE_ID)                     console.warn('   APPLE_ID');
    if (!APPLE_APP_SPECIFIC_PASSWORD)  console.warn('   APPLE_APP_SPECIFIC_PASSWORD');
    if (!APPLE_TEAM_ID)                console.warn('   APPLE_TEAM_ID');
    return;
  }

  const appName = context.packager.appInfo.productFilename;
  const appPath = path.join(appOutDir, `${appName}.app`);

  if (!fs.existsSync(appPath)) {
    console.warn(`⚠️  App not found, skipping notarization: ${appPath}`);
    return;
  }

  console.log(`\n🔏 Notarizing: ${appPath}`);
  console.log(`   Apple ID:  ${APPLE_ID}`);
  console.log(`   Team ID:   ${APPLE_TEAM_ID}`);

  const tmpZip = `/tmp/notarize-opticsify-${Date.now()}.zip`;

  try {
    // Create a zip archive for submission (notarytool requires a zip or dmg)
    console.log('📦 Creating archive for submission...');
    execSync(`/usr/bin/ditto -c -k --keepParent "${appPath}" "${tmpZip}"`, {
      stdio: 'inherit'
    });

    // Submit to Apple and wait for the result
    console.log('📤 Submitting to Apple notarization service (this may take a few minutes)...');
    const output = execSync(
      `xcrun notarytool submit "${tmpZip}" \
        --apple-id "${APPLE_ID}" \
        --password "${APPLE_APP_SPECIFIC_PASSWORD}" \
        --team-id "${APPLE_TEAM_ID}" \
        --wait`,
      { encoding: 'utf8', stdio: 'pipe' }
    );

    console.log(output);

    if (output.includes('status: Accepted')) {
      console.log('✅ Notarization accepted!');

      // Staple the ticket so the app works offline (no network check needed)
      console.log('📌 Stapling notarization ticket...');
      execSync(`xcrun stapler staple "${appPath}"`, { stdio: 'inherit' });
      console.log('✅ Ticket stapled — app is ready for distribution');

    } else if (output.includes('status: Invalid')) {
      // Fetch the detailed rejection log from Apple
      const idMatch = output.match(/\bid:\s*([a-f0-9-]{36})/);
      if (idMatch) {
        console.error('\n❌ Notarization rejected. Fetching Apple log...');
        try {
          const log = execSync(
            `xcrun notarytool log "${idMatch[1]}" \
              --apple-id "${APPLE_ID}" \
              --password "${APPLE_APP_SPECIFIC_PASSWORD}" \
              --team-id "${APPLE_TEAM_ID}"`,
            { encoding: 'utf8' }
          );
          console.error(log);
        } catch {}
      }
      throw new Error('Apple rejected the notarization submission');

    } else {
      console.warn('⚠️  Notarization status unclear — check output above');
    }

  } catch (err) {
    console.error('❌ Notarization failed:', err.message);
    throw err;
  } finally {
    try { fs.unlinkSync(tmpZip); } catch {}
  }
};
