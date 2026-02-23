# Code Signing Setup for Production

## macOS Code Signing

To enable code signing for macOS distribution:

1. **Get Apple Developer Certificate:**
   - Join Apple Developer Program
   - Create Developer ID Application certificate
   - Download and install in Keychain

2. **Update package.json:**
   ```json
   "mac": {
     "identity": "Developer ID Application: Your Name (TEAM_ID)"
   }
   ```

3. **Environment Variables:**
   ```bash
   export CSC_NAME="Developer ID Application: Your Name (TEAM_ID)"
   export CSC_LINK="path/to/certificate.p12"
   export CSC_KEY_PASSWORD="certificate_password"
   ```

4. **Notarization (Optional but Recommended):**
   ```json
   "afterSign": "scripts/notarize.js"
   ```

## Windows Code Signing

For Windows distribution:

1. **Get Code Signing Certificate:**
   - Purchase from trusted CA (DigiCert, Sectigo, etc.)

2. **Environment Variables:**
   ```bash
   export CSC_LINK="path/to/certificate.p12"
   export CSC_KEY_PASSWORD="certificate_password"
   ```

## Building Signed Applications

```bash
# macOS
npm run build:mac

# Windows
npm run build:win

# All platforms
npm run build:all
```

## Notes

- Code signing is currently disabled (`identity: null`)
- Enable by setting proper identity in package.json
- Certificates are required for distribution outside development