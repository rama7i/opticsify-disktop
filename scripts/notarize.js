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
    // Sign with ad-hoc signature (-)
    execSync(`codesign --force --deep --sign - "${appPath}"`, {
      stdio: 'inherit'
    });
    
    console.log('✅ Successfully signed with ad-hoc signature');
    
    // Verify the signature
    execSync(`codesign --verify --deep --strict "${appPath}"`, {
      stdio: 'inherit'
    });
    
    console.log('✅ Signature verified');
  } catch (error) {
    console.error('❌ Code signing failed:', error.message);
    throw error;
  }
};

