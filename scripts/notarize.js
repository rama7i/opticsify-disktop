const { execSync } = require('child_process');
const path = require('path');

exports.default = async function(context) {
  const { electronPlatformName, appOutDir } = context;
  
  if (electronPlatformName !== 'darwin') {
    return;
  }

  const appPath = path.join(appOutDir, `${context.packager.appInfo.productFilename}.app`);
  
  console.log(`🔐 Ad-hoc code signing: ${appPath}`);
  
  try {
    // Sign with ad-hoc signature (without --deep as it's deprecated)
    execSync(`codesign --force --sign - "${appPath}"`, {
      stdio: 'inherit'
    });
    
    console.log('✅ Successfully signed with ad-hoc signature');
    
    // Verify the signature (basic verification)
    try {
      execSync(`codesign --verify "${appPath}"`, {
        stdio: 'inherit'
      });
      console.log('✅ Signature verified');
    } catch (verifyError) {
      console.warn('⚠️  Signature verification had issues, but continuing...');
    }
  } catch (error) {
    console.warn('⚠️  Code signing failed, but continuing build:', error.message);
    // Don't throw error - allow build to continue without signing
    // The app will still work locally, just won't be signed
  }
};

