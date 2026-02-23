# Windows 7 Support Guide

## Overview
Windows 7 support has been added to the build system. However, there are important limitations due to Electron version compatibility.

---

## ⚠️ Important Limitations

### **Current Status:**
- **Current Electron Version:** 38.2.0
- **Windows 7 Support:** ❌ **NOT SUPPORTED** by Electron 38.x
- **Minimum Windows Version:** Windows 10 (for Electron 38.x)

### **Windows 7 Compatible Versions:**
- **Last Electron with Windows 7:** Electron 22.3.27 (released May 2023)
- **Chromium Version:** 108
- **Node.js Version:** 16.x

---

## 🔧 Building for Windows 7

### Option 1: Use Current Setup (Windows 10/11 Only)

**Build Command:**
```bash
./deploy.sh -p win
```

**Output:**
- `Opticsify Desktop Setup 1.0.2-ia32.exe` (Windows 10/11 32-bit)
- `Opticsify Desktop Setup 1.0.2-x64.exe` (Windows 10/11 64-bit)

**Compatibility:** Windows 10+, Windows Server 2016+

---

### Option 2: Downgrade Electron for Windows 7 Support

To support Windows 7, you need to downgrade Electron to version 22.x or earlier.

#### Step 1: Update `package.json`
```json
{
  "devDependencies": {
    "electron": "^22.3.27",  // ← Change from 38.2.0
    "electron-builder": "^25.1.8"
  }
}
```

#### Step 2: Install Dependencies
```bash
npm install
```

#### Step 3: Build for Windows 7
```bash
./deploy.sh -p win7
```

**Output:**
- `Opticsify Desktop Setup 1.0.2-win7-ia32.exe`

**Compatibility:** Windows 7+, Windows 10, Windows 11

---

## 📊 Electron Version Compatibility

| Electron Version | Windows 7 | Windows 8.1 | Windows 10 | Windows 11 | End of Support |
|------------------|-----------|-------------|------------|------------|----------------|
| 38.x (current) | ❌ | ❌ | ✅ | ✅ | Active |
| 30.x | ❌ | ❌ | ✅ | ✅ | May 2025 |
| 28.x | ❌ | ❌ | ✅ | ✅ | Jan 2025 |
| 22.x | ✅ | ✅ | ✅ | ✅ | **May 2023** (EOL) |
| 19.x | ✅ | ✅ | ✅ | ❌ | **Jan 2023** (EOL) |

---

## 🎯 Recommended Approach

### For Production (Best Practice):

**Build TWO versions:**

1. **Modern Version** (Electron 38.x)
   - Target: Windows 10/11
   - Features: Latest Chromium, better performance, security
   - Build: `./deploy.sh -p win`

2. **Legacy Version** (Electron 22.x)
   - Target: Windows 7/8.1
   - Features: Older Chromium, stable, compatible
   - Build: `./deploy.sh -p win7` (after downgrading)

---

## 🚀 Usage Instructions

### Current Setup (Windows 10/11):

```bash
# Build Windows 10/11 version
./deploy.sh -p win

# Upload to S3
./create-release.sh
```

**Files generated:**
- `Opticsify Desktop Setup 1.0.2-ia32.exe` (32-bit)
- `Opticsify Desktop Setup 1.0.2-x64.exe` (64-bit)

---

### Windows 7 Setup (Requires Electron Downgrade):

#### 1. Create Windows 7 Branch
```bash
git checkout -b windows7-support
```

#### 2. Modify `package.json`
```json
{
  "version": "1.0.2-win7",  // Mark as Win7 version
  "devDependencies": {
    "electron": "^22.3.27",
    "electron-builder": "^25.1.8"
  }
}
```

#### 3. Install and Build
```bash
npm install
./deploy.sh -p win7
```

#### 4. Upload to S3
```bash
./create-release.sh
```

**Files generated:**
- `Opticsify Desktop Setup 1.0.2-win7-ia32.exe` (32-bit)
- `Opticsify Desktop Setup 1.0.2-win7-x64.exe` (64-bit)

---

## 📦 S3 File Naming

### Standard Windows Builds:
```
opticsify-Desktop-Setup-1.0.2-ia32.exe    (32-bit, Win10+)
opticsify-Desktop-Setup-1.0.2-x64.exe     (64-bit, Win10+)
```

### Windows 7 Builds:
```
opticsify-Desktop-Setup-1.0.2-win7-ia32.exe  (32-bit, Win7+)
opticsify-Desktop-Setup-1.0.2-win7-x64.exe   (64-bit, Win7+)
```

---

## 🔍 Detection & Auto-Update

### Detecting Windows Version:

```javascript
// In main.js
const os = require('os');
const release = os.release();

// Windows version detection
if (parseFloat(release) < 10) {
  // Windows 7/8 - Use win7 installer
  fileName = `opticsify-Desktop-Setup-${version}-win7-ia32.exe`;
} else {
  // Windows 10/11 - Use modern installer
  if (arch === 'x64') {
    fileName = `opticsify-Desktop-Setup-${version}-x64.exe`;
  } else {
    fileName = `opticsify-Desktop-Setup-${version}-ia32.exe`;
  }
}
```

---

## ⚙️ Configuration Changes

### `package.json` Windows Settings:

```json
"win": {
  "icon": "assets/icon.png",
  "artifactName": "${productName} ${version}-${arch}.${ext}",
  "requestedExecutionLevel": "asInvoker",  // ← Added for Win7
  "target": [
    {
      "target": "nsis",
      "arch": ["x64", "ia32"]
    }
  ]
}
```

### `nsis` Settings:

```json
"nsis": {
  "oneClick": false,                          // User can choose install location
  "allowToChangeInstallationDirectory": true,
  "createDesktopShortcut": true,
  "createStartMenuShortcut": true,
  "artifactName": "${productName} Setup ${version}-${arch}.${ext}",
  "installerIcon": "assets/icon.png",
  "uninstallerIcon": "assets/icon.png",
  "deleteAppDataOnUninstall": false,
  "perMachine": false,                        // Per-user install (no admin needed)
  "allowElevation": true                      // Allow elevation if needed
}
```

---

## 🧪 Testing

### Test Windows 7 Installer:

1. **Virtual Machine:**
   - Download Windows 7 ISO (if available)
   - Use VirtualBox or VMware
   - Install your app

2. **Check Compatibility:**
   ```powershell
   # On Windows 7 machine
   systeminfo | findstr /B /C:"OS Name"
   ```

3. **Test Features:**
   - App launches
   - UI renders correctly
   - Auto-updater works
   - All features functional

---

## 📝 Trade-offs

### Using Electron 38.x (Current):

**Pros:**
- ✅ Latest Chromium (security, performance)
- ✅ Modern web features
- ✅ Active support
- ✅ Better performance

**Cons:**
- ❌ No Windows 7 support
- ❌ No Windows 8.1 support

### Using Electron 22.x (for Win7):

**Pros:**
- ✅ Windows 7 support
- ✅ Windows 8.1 support
- ✅ Stable, well-tested

**Cons:**
- ❌ End of life (May 2023)
- ❌ No security updates
- ❌ Older Chromium (security risks)
- ❌ Missing modern features

---

## 💡 Recommendations

### 1. **Two-Version Strategy** (Recommended)
```
Main App (Electron 38.x)  → Windows 10/11 (95% of users)
Legacy App (Electron 22.x) → Windows 7/8 (5% of users)
```

### 2. **Windows 10+ Only** (Simpler)
```
Single App (Electron 38.x) → Windows 10/11 only
Notify Win7 users to upgrade OS
```

### 3. **Gradual Migration**
```
Year 1: Support both (Electron 22.x)
Year 2: Notify Win7 users to upgrade
Year 3: Drop Win7, upgrade to Electron 38.x
```

---

## 📊 Windows Market Share (2024)

| Version | Market Share | Support Status |
|---------|--------------|----------------|
| Windows 11 | ~35% | Active |
| Windows 10 | ~60% | Until Oct 2025 |
| Windows 8.1 | ~1% | Ended Jan 2023 |
| Windows 7 | ~3% | Ended Jan 2020 |

**Conclusion:** Windows 7 represents <3% of users but requires significant compatibility work.

---

## 🚀 Quick Start Commands

### Current Setup (No Windows 7):
```bash
# Build Windows 10/11 versions
./deploy.sh -p win

# Upload to S3
./create-release.sh
```

### Windows 7 Support:
```bash
# 1. Downgrade Electron in package.json
# 2. Install dependencies
npm install

# 3. Build Windows 7 version
./deploy.sh -p win7

# 4. Upload to S3 
./create-release.sh
```

---

## 📞 Support

**Need Windows 7 support?**
1. Evaluate user base (how many users on Win7?)
2. Consider two-version strategy
3. Test thoroughly in VM
4. Document limitations

**Questions?**
- Check Electron compatibility: https://www.electronjs.org/docs/latest/tutorial/windows-7-support
- Test in Windows 7 VM
- Monitor user feedback

---

## ✅ Summary

- ✅ Windows 7 build command added: `./deploy.sh -p win7`
- ⚠️ Requires Electron downgrade to 22.x
- 📦 Generates both 32-bit and 64-bit versions:
  - `opticsify-Desktop-Setup-X.X.X-win7-ia32.exe` (32-bit)
  - `opticsify-Desktop-Setup-X.X.X-win7-x64.exe` (64-bit)
- 🎯 Recommended: Two-version strategy (modern + legacy)
- 📊 Windows 7 = ~3% market share (declining)

**Decision:** Evaluate if Windows 7 support is worth the maintenance overhead.

