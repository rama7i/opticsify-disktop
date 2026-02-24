// Add environment check for production
const isDevelopment = process.env.NODE_ENV === 'development' || process.argv.includes('--dev');

// Production debug flag - keep false in production to avoid attaching the V8 inspector,
// which triggers a crash in Electron 38's GC profiler (EXC_BREAKPOINT in CpuProfileNode).
const enableProductionDebug = false;

const { app, BrowserWindow, Menu, shell, dialog, ipcMain, Tray, nativeImage, globalShortcut } = require('electron');
const { autoUpdater } = require('electron-updater');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const Store = require('electron-store');

// Camera/media access is allowed - permission requests are handled per-session below.

// Initialize store for persistent settings
const store = new Store();

// Register custom protocol scheme before app is ready
const { protocol } = require('electron');
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'fonts',
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
      bypassCSP: true
    }
  }
]);

// Keep a global reference of the window object
let mainWindow;
let tray = null;


// URL-based navigation tracking (simpler approach to avoid cache miss)
let urlNavigationStack = [];
let currentUrlIndex = -1;
let lastBackClickTime = 0;
const BACK_CLICK_DEBOUNCE = 500; // 500ms debounce

// Track session clearing to prevent infinite loops
let lastSessionClearUrl = null;
let lastSessionClearTime = 0;
const SESSION_CLEAR_COOLDOWN = 5000; // Don't clear again within 5 seconds for same URL

// Cookies that should be preserved during session clearing (user preferences)
// Lang/user_lang are managed by the webapp - not preserved here to avoid conflicts
const PRESERVED_COOKIES = [
  'dont_show_all_videos'
];

// Helper function to preserve and restore specific cookies during session clear
async function preserveAndClearCookies(sessionObj, shouldPreserve = true) {
  const preservedCookies = [];
  
  try {
    // Get all cookies
    const allCookies = await sessionObj.cookies.get({});
    
    if (shouldPreserve) {
      // Save cookies that should be preserved
      for (const cookie of allCookies) {
        if (PRESERVED_COOKIES.includes(cookie.name)) {
          preservedCookies.push(cookie);
          if (isDevelopment || enableProductionDebug) {
            console.log(`Preserving cookie: ${cookie.name}`);
          }
        }
      }
    }
    
    // Clear all cookies
    for (const cookie of allCookies) {
      const cookieUrl = `http${cookie.secure ? 's' : ''}://${cookie.domain}${cookie.path}`;
      await sessionObj.cookies.remove(cookieUrl, cookie.name);
    }
    
    if (shouldPreserve && preservedCookies.length > 0) {
      // Wait a bit for clearing to complete
      await new Promise(resolve => setTimeout(resolve, 100));
      
      // Restore preserved cookies
      for (const cookie of preservedCookies) {
        try {
          const cookieDetails = {
            url: `http${cookie.secure ? 's' : ''}://${cookie.domain}${cookie.path}`,
            name: cookie.name,
            value: cookie.value,
            domain: cookie.domain,
            path: cookie.path,
            secure: cookie.secure,
            httpOnly: cookie.httpOnly
          };
          if (cookie.expirationDate) {
            cookieDetails.expirationDate = cookie.expirationDate;
          }
          await sessionObj.cookies.set(cookieDetails);
          if (isDevelopment || enableProductionDebug) {
            console.log(`Restored cookie: ${cookie.name}`);
          }
        } catch (restoreError) {
          console.error(`Error restoring cookie ${cookie.name}:`, restoreError);
        }
      }
    }
  } catch (error) {
    console.error('Error in preserveAndClearCookies:', error);
  }
  
  return preservedCookies.length;
}

// Helper function to clean up duplicate cookies (keeps subdomain-specific, removes wildcards)
async function cleanupDuplicateCookies(sessionObj) {
  try {
    const allCookies = await sessionObj.cookies.get({});
    const cookiesByName = {};
    
    // Group cookies by name
    for (const cookie of allCookies) {
      if (!cookiesByName[cookie.name]) {
        cookiesByName[cookie.name] = [];
      }
      cookiesByName[cookie.name].push(cookie);
    }
    
    let removedCount = 0;
    
    // For each cookie name, check for duplicates
    for (const cookieName in cookiesByName) {
      const cookies = cookiesByName[cookieName];
      
      if (cookies.length > 1) {
        // Find wildcard cookies (domain starts with .)
        const wildcardCookies = cookies.filter(c => c.domain.startsWith('.'));
        const specificCookies = cookies.filter(c => !c.domain.startsWith('.'));
        
        // If we have both wildcard and specific cookies, remove the wildcard ones
        if (wildcardCookies.length > 0 && specificCookies.length > 0) {
          for (const cookie of wildcardCookies) {
            const cookieUrl = `http${cookie.secure ? 's' : ''}://${cookie.domain}${cookie.path}`;
            await sessionObj.cookies.remove(cookieUrl, cookie.name);
            removedCount++;
            if (isDevelopment || enableProductionDebug) {
              console.log(`Removed duplicate wildcard cookie: ${cookie.name} from ${cookie.domain}`);
            }
          }
        }
      }
    }
    
    if (removedCount > 0 && (isDevelopment || enableProductionDebug)) {
      console.log(`Cleaned up ${removedCount} duplicate cookies`);
    }
    
    return removedCount;
  } catch (error) {
    console.error('Error cleaning up duplicate cookies:', error);
    return 0;
  }
}

// URL navigation management functions
function addToUrlStack(url) {
  // Don't add duplicate consecutive URLs or problematic URLs
  if (url === 'about:blank' || url.includes('data:text/html') || url === '') {
    return;
  }
  
  if (urlNavigationStack.length > 0 && urlNavigationStack[urlNavigationStack.length - 1] === url) {
    return;
  }
  
  // Add URL to stack
  urlNavigationStack.push(url);
  currentUrlIndex = urlNavigationStack.length - 1;
  
  // Keep stack size manageable (max 20 URLs)
  if (urlNavigationStack.length > 20) {
    urlNavigationStack.shift();
    currentUrlIndex--;
  }
  
  //console.log('URL Stack updated:', { url, stackSize: urlNavigationStack.length, currentIndex: currentUrlIndex });
}

function canGoBackToUrl() {
  if (currentUrlIndex <= 0 || urlNavigationStack.length < 2) {
    return false;
  }
  
  const previousUrl = urlNavigationStack[currentUrlIndex - 1];
  
  // Don't allow back navigation to login pages or problematic URLs
  if (previousUrl.includes('/login') || 
      previousUrl.includes('/return/') || 
      previousUrl === 'about:blank' ||
      previousUrl.includes('data:text/html')) {
    return false;
  }
  
  return true;
}

function getPreviousUrl() {
  if (canGoBackToUrl()) {
    return urlNavigationStack[currentUrlIndex - 1];
  }
  return null;
}

// Get domain from storage or prompt user
async function getDomain() {
  try {
    //console.log('getDomain() called - checking for stored domain');
    const storedSubdomain = store.get('customerSubdomain');
    const storedDomain = store.get('customerDomain');
    const storedDomainType = store.get('customerDomainType', 'subdomain');
    //console.log('Stored subdomain:', storedSubdomain);
    //console.log('Stored domain:', storedDomain);
    //console.log('Stored domain type:', storedDomainType);
    
    if (storedDomain && storedDomainType === 'custom') {
      //console.log('Using stored custom domain:', storedDomain);
      
      // Validate stored custom domain before using it
      const isValid = await validateCustomDomain(storedDomain);
      if (isValid) {
        return storedDomain;
      } else {
        // Clear invalid stored domain and show form
        //console.log('Stored custom domain is invalid, clearing and showing form');
        store.delete('customerDomain');
        store.delete('customerDomainType');
        store.delete('customerSubdomain');
        showDomainErrorDialog(storedDomain);
        return await showSubdomainFormInMainWindow();
      }
    } else if (storedSubdomain) {
      const fullDomain = `https://${storedSubdomain}.opticsify.com`;
      //console.log('Using stored subdomain:', storedSubdomain);
      //console.log('Full domain:', fullDomain);
      
      // Validate stored subdomain before using it
      const isValid = await validateSubdomain(storedSubdomain);
      if (isValid) {
        return fullDomain;
      } else {
        // Clear invalid stored subdomain and show form
        //console.log('Stored subdomain is invalid, clearing and showing form');
        store.delete('customerSubdomain');
        store.delete('customerDomain');
        store.delete('customerDomainType');
        showSubdomainErrorDialog(storedSubdomain);
        return await showSubdomainFormInMainWindow();
      }
    } else {
      // Show subdomain form in main window - must enter subdomain to proceed
      //console.log('No stored domain found - showing subdomain form in main window');
      const domain = await showSubdomainFormInMainWindow();
      //console.log('showSubdomainFormInMainWindow returned:', domain);
      // If no valid subdomain was entered, keep showing the form
      if (!domain || domain === 'http://localhost:80') {
        //console.log('Invalid domain returned, calling getDomain recursively');
        return await getDomain(); // Recursive call to show form again
      }
      return domain;
    }
  } catch (error) {
    console.error('Error in getDomain:', error);
    // Don't fallback to localhost - force subdomain entry
    //console.log('Error occurred - showing subdomain form as fallback');
    return await showSubdomainFormInMainWindow();
  }
}

  // Show subdomain form within the main window
async function showSubdomainFormInMainWindow() {
  //console.log('showSubdomainFormInMainWindow() called');
  return new Promise((resolve) => {
    if (!mainWindow) {
      console.error('showSubdomainFormInMainWindow: mainWindow is null or undefined');
      resolve(null);
      return;
    }

    //console.log('showSubdomainFormInMainWindow: mainWindow exists, loading HTML content');

    // Load logo dynamically via IPC
    let logoSrc = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='; // Placeholder

    const html = `
      <!DOCTYPE html>
      <html>
      <head>
        <style>
          @font-face {
            font-family: 'Omnes';
            src: url('fonts://Omnes Regular.otf') format('opentype');
            font-weight: 400;
            font-style: normal;
          }
          @font-face {
            font-family: 'Omnes';
            src: url('fonts://Omnes Light.otf') format('opentype');
            font-weight: 300;
            font-style: normal;
          }
          @font-face {
            font-family: 'Omnes';
            src: url('fonts://Omnes Medium.otf') format('opentype');
            font-weight: 500;
            font-style: normal;
          }
          @font-face {
            font-family: 'Omnes';
            src: url('fonts://Omnes SemiBold.otf') format('opentype');
            font-weight: 600;
            font-style: normal;
          }
          @font-face {
            font-family: 'Omnes';
            src: url('fonts://Omnes Bold.otf') format('opentype');
            font-weight: 700;
            font-style: normal;
          }
          @font-face {
            font-family: 'Omnes';
            src: url('fonts://Omnes Black.otf') format('opentype');
            font-weight: 900;
            font-style: normal;
          }
          @font-face {
            font-family: 'Omnes';
            src: url('fonts://Omnes Thin.otf') format('opentype');
            font-weight: 100;
            font-style: normal;
          }
          @font-face {
            font-family: 'Omnes';
            src: url('fonts://Omnes ExtraLight.otf') format('opentype');
            font-weight: 200;
            font-style: normal;
          }
          @font-face {
            font-family: 'Omnes';
            src: url('fonts://Omnes Hairline.otf') format('opentype');
            font-weight: 50;
            font-style: normal;
          }
          
          /* Animations */
          @keyframes fadeInUp {
            from {
              opacity: 0;
              transform: translateY(30px);
            }
            to {
              opacity: 1;
              transform: translateY(0);
            }
          }
          
          @keyframes fadeIn {
            from {
              opacity: 0;
            }
            to {
              opacity: 1;
            }
          }
          
          @keyframes slideInFromLeft {
            from {
              opacity: 0;
              transform: translateX(-30px);
            }
            to {
              opacity: 1;
              transform: translateX(0);
            }
          }
          
          @keyframes slideInFromRight {
            from {
              opacity: 0;
              transform: translateX(30px);
            }
            to {
              opacity: 1;
              transform: translateX(0);
            }
          }
          
          @keyframes scaleIn {
            from {
              opacity: 0;
              transform: scale(0.9);
            }
            to {
              opacity: 1;
              transform: scale(1);
            }
          }
          
          @keyframes shine {
            0% {
              left: -100%;
            }
            20%, 100% {
              left: 100%;
            }
          }
          
          /* Helper class to restart animations */
          .no-animation,
          .no-animation * {
            animation: none !important;
          }
          
          * {
            margin: 0;
            padding: 0;
            box-sizing: border-box;
          }
          body { 
            font-family: 'Omnes', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; 
            background-image: var(--bg-svg, none);
            background-size: cover;
            background-position: center;
            background-repeat: no-repeat;
            background-attachment: fixed;
            height: 100vh;
            min-height: 100vh;
            display: flex;
            align-items: center;
            justify-content: center;
            overflow: hidden;
            transition: all 0.3s ease;
            padding: 10px;
          }
          
          /* Responsive body adjustments */
          @media (max-height: 700px) {
            body {
              padding: 5px;
            }
          }
          
          @media (max-height: 600px) {
            body {
              padding: 2px;
            }
          }
          
          @media (max-height: 500px) {
            body {
              padding: 1px;
            }
          }
          body.rtl {
            direction: rtl;
            font-family: 'Omnes', 'Segoe UI', Tahoma, Arial, sans-serif;
          }
          .container { 
            background: rgba(255, 255, 255, 0.85);
            backdrop-filter: blur(20px);
            -webkit-backdrop-filter: blur(20px);
            border: 1px solid rgba(102, 126, 234, 0.1);
            padding: 60px;
            border-radius: 20px;
            box-shadow: 0 20px 60px rgba(0,0,0,0.1);
            text-align: center;
            max-width: 600px;
            width: 90%;
            position: relative;
            margin: 0 auto;
            animation: fadeInUp 0.8s ease-out;
          }
          
          /* Responsive design for different screen sizes */
          @media (max-width: 768px) {
            .container {
              padding: 40px 30px;
              width: 95%;
              border-radius: 15px;
            }
          }
          
          @media (max-width: 480px) {
            .container {
              padding: 30px 20px;
              width: 98%;
              border-radius: 12px;
            }
          }
          
          @media (max-width: 320px) {
            .container {
              padding: 20px 15px;
              width: 100%;
              border-radius: 8px;
            }
          }
          
          /* Height-based responsive adjustments - making container smaller */
          @media (max-height: 700px) {
            .container {
              padding: 35px;
              max-width: 500px;
            }
          }
          
          @media (max-height: 600px) {
            .container {
              padding: 25px;
              max-width: 450px;
            }
          }
          
          @media (max-height: 500px) {
            .container {
              padding: 20px;
              max-width: 400px;
            }
          }
          
          @media (max-height: 400px) {
            .container {
              padding: 15px;
              max-width: 350px;
              border-radius: 8px;
            }
          }
          /* Language selector dropdown */
          .lang-selector {
            position: absolute;
            top: 20px;
            right: 20px;
            z-index: 300;
            animation: slideInFromRight 0.6s ease-out 0.2s both;
          }
          body.rtl .lang-selector {
            right: auto;
            left: 20px;
          }

          .lang-trigger {
            display: flex;
            align-items: center;
            gap: 6px;
            padding: 8px 14px;
            border: 2px solid rgba(59, 130, 246, 0.2);
            background: rgba(255, 255, 255, 0.85);
            border-radius: 10px;
            cursor: pointer;
            font-size: 14px;
            font-weight: 600;
            font-family: 'Omnes', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            color: #4b5563;
            transition: all 0.25s;
            white-space: nowrap;
            backdrop-filter: blur(4px);
          }
          .lang-trigger:hover {
            border-color: #3B82F6;
            background: rgba(255, 255, 255, 0.97);
            color: #3B82F6;
          }
          .lang-selector.open .lang-trigger {
            border-color: #3B82F6;
            color: #3B82F6;
          }
          .lang-chevron {
            font-size: 12px;
            transition: transform 0.25s;
          }
          .lang-selector.open .lang-chevron {
            transform: rotate(180deg);
          }

          .lang-dropdown {
            position: absolute;
            top: calc(100% + 6px);
            right: 0;
            min-width: 100%;
            background: white;
            border: 2px solid rgba(59, 130, 246, 0.15);
            border-radius: 10px;
            box-shadow: 0 8px 24px rgba(0, 0, 0, 0.12);
            overflow: hidden;
            display: none;
          }
          body.rtl .lang-dropdown {
            right: auto;
            left: 0;
          }
          .lang-selector.open .lang-dropdown {
            display: block;
          }

          .lang-option {
            display: flex;
            align-items: center;
            gap: 10px;
            width: 100%;
            padding: 10px 16px;
            border: none;
            background: none;
            cursor: pointer;
            font-size: 14px;
            font-weight: 500;
            font-family: 'Omnes', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            color: #4b5563;
            text-align: left;
            transition: background 0.15s;
            white-space: nowrap;
          }
          body.rtl .lang-option {
            text-align: right;
            flex-direction: row-reverse;
          }
          .lang-option:hover {
            background: rgba(59, 130, 246, 0.07);
            color: #3B82F6;
          }
          .lang-option.active {
            background: rgba(59, 130, 246, 0.1);
            color: #3B82F6;
            font-weight: 700;
          }
          .lang-option .lang-flag {
            font-size: 18px;
            line-height: 1;
          }
          
          /* Domain History */
          .history-wrapper {
            position: relative;
            width: 100%;
            margin-top: 8px;
            z-index: 200;
          }

          .history-btn {
            width: 100%;
            padding: 9px 16px;
            border: 2px solid rgba(59, 130, 246, 0.2);
            background: rgba(255, 255, 255, 0.7);
            border-radius: 10px;
            cursor: pointer;
            font-size: 14px;
            font-weight: 600;
            font-family: 'Omnes', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            transition: all 0.3s;
            color: #4b5563;
            text-align: left;
            display: flex;
            align-items: center;
            gap: 8px;
          }

          body.rtl .history-btn {
            text-align: right;
          }

          .history-btn:hover {
            border-color: #3B82F6;
            background: rgba(255, 255, 255, 0.95);
            color: #3B82F6;
          }

          .history-dropdown {
            position: absolute;
            top: calc(100% + 6px);
            left: 0;
            right: 0;
            background: white;
            border: 2px solid rgba(59, 130, 246, 0.2);
            border-radius: 12px;
            box-shadow: 0 10px 30px rgba(0,0,0,0.15);
            max-height: 320px;
            overflow-y: auto;
            z-index: 100;
            display: none;
          }
          
          .history-dropdown.show {
            display: block;
          }
          
          .history-header {
            padding: 15px 20px;
            border-bottom: 2px solid rgba(59, 130, 246, 0.1);
            font-weight: 700;
            color: #1f2937;
            font-size: 16px;
            font-family: 'Omnes', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            display: flex;
            justify-content: space-between;
            align-items: center;
          }
          
          .history-clear {
            font-size: 13px;
            color: #ef4444;
            cursor: pointer;
            font-weight: 500;
            padding: 4px 12px;
            border-radius: 6px;
            transition: all 0.2s;
          }
          
          .history-clear:hover {
            background: rgba(239, 68, 68, 0.1);
          }
          
          .history-empty {
            padding: 40px 20px;
            text-align: center;
            color: #9ca3af;
            font-size: 14px;
            font-family: 'Omnes', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
          }
          
          .history-item {
            padding: 12px 20px;
            border-bottom: 1px solid rgba(0,0,0,0.05);
            transition: all 0.2s;
            cursor: pointer;
            display: flex;
            justify-content: space-between;
            align-items: center;
          }
          
          .history-item:hover {
            background: rgba(59, 130, 246, 0.05);
          }
          
          .history-item:last-child {
            border-bottom: none;
          }
          
          .history-domain-info {
            flex: 1;
            text-align: left;
          }
          
          body.rtl .history-domain-info {
            text-align: right;
          }

          body.rtl .history-header {
            flex-direction: row-reverse;
          }

          body.rtl .history-item {
            flex-direction: row-reverse;
          }
          
          .history-domain {
            font-size: 14px;
            font-weight: 600;
            color: #1f2937;
            font-family: 'Omnes', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            margin-bottom: 3px;
          }
          
          .history-type {
            font-size: 11px;
            color: #6b7280;
            font-family: 'Omnes', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
          }
          
          .history-delete {
            padding: 6px 12px;
            border-radius: 6px;
            font-size: 12px;
            color: #ef4444;
            font-weight: 500;
            transition: all 0.2s;
            font-family: 'Omnes', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
          }
          
          .history-delete:hover {
            background: rgba(239, 68, 68, 0.1);
          }
          
          /* Domain type switcher */
          .domain-type-switch {
            margin-bottom: 20px;
            text-align: center;
            display: flex;
            justify-content: center;
            gap: 0;
          }
          .domain-type-btn {
            padding: 8px 20px;
            border: 2px solid #e9ecef;
            background: white;
            color: #4b5563;
            cursor: pointer;
            font-weight: 600;
            font-family: 'Omnes', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            transition: all 0.3s;
            font-size: 14px;
            outline: none;
            display: inline-flex;
            align-items: center;
            justify-content: center;
            gap: 6px;
          }
          .domain-type-btn:first-child {
            border-radius: 8px 0 0 8px;
            border-right: 1px solid #e9ecef;
          }
          .domain-type-btn:last-child {
            border-radius: 0 8px 8px 0;
            border-left: 1px solid #e9ecef;
          }
          .domain-type-btn:hover {
            background: rgba(59, 130, 246, 0.1);
            color: #3B82F6;
            border-color: #3B82F6;
          }
          .domain-type-btn.active,
          .domain-type-btn[style*="linear-gradient"] {
            background: linear-gradient(135deg, #3B82F6 0%, #8B5CF6 100%) !important;
            border-color: #3B82F6 !important;
            color: white !important;
          }
          
          @media (max-width: 480px) {
            .domain-type-btn {
              padding: 6px 15px;
              font-size: 12px;
            }
          }
          
          /* RTL support for domain type switcher */
          body.rtl .domain-type-switch {
            direction: ltr;
            flex-direction: row-reverse;
          }
          body.rtl .domain-type-btn {
            flex-direction: row-reverse;
          }
          body.rtl .domain-type-btn:first-child {
            border-radius: 0 8px 8px 0;
            border-right: 2px solid #e9ecef;
            border-left: 1px solid #e9ecef;
          }
          body.rtl .domain-type-btn:last-child {
            border-radius: 8px 0 0 8px;
            border-left: 2px solid #e9ecef;
            border-right: 1px solid #e9ecef;
          }
          body.rtl .domain-type-btn.active:first-child {
            border-right: 2px solid #3B82F6;
          }
          body.rtl .domain-type-btn.active:last-child {
            border-left: 2px solid #3B82F6;
          }
          
          .logo {
            margin-bottom: 30px;
            animation: scaleIn 0.8s ease-out 0.3s both;
          }
          .logo img {
            width: 120px;
            height: 120px;
            object-fit: contain;
          }
          
          /* Responsive logo */
          @media (max-width: 768px) {
            .logo {
              margin-bottom: 25px;
            }
            .logo img {
              width: 100px;
              height: 100px;
            }
          }
          
          @media (max-width: 480px) {
            .logo {
              margin-bottom: 20px;
            }
            .logo img {
              width: 80px;
              height: 80px;
            }
          }
          
          @media (max-width: 320px) {
            .logo {
              margin-bottom: 15px;
            }
            .logo img {
              width: 60px;
              height: 60px;
            }
          }
          
          /* Height-based logo adjustments */
          @media (max-height: 700px) {
            .logo {
              margin-bottom: 20px;
            }
            .logo img {
              width: 90px;
              height: 90px;
            }
          }
          
          @media (max-height: 600px) {
            .logo {
              margin-bottom: 15px;
            }
            .logo img {
              width: 70px;
              height: 70px;
            }
          }
          
          @media (max-height: 500px) {
            .logo {
              margin-bottom: 10px;
            }
            .logo img {
              width: 50px;
              height: 50px;
            }
          }
          
          @media (max-height: 400px) {
            .logo {
              margin-bottom: 8px;
            }
            .logo img {
              width: 40px;
              height: 40px;
            }
          }
          
          .title {
            font-size: 32px;
            font-weight: 700;
            color: #1f2937;
            margin-bottom: 10px;
            animation: fadeInUp 0.8s ease-out 0.4s both;
          }
          
          /* Responsive title */
          @media (max-width: 768px) {
            .title {
              font-size: 28px;
            }
          }
          
          @media (max-width: 480px) {
            .title {
              font-size: 24px;
              margin-bottom: 8px;
            }
          }
          
          @media (max-width: 320px) {
            .title {
              font-size: 20px;
              margin-bottom: 6px;
            }
          }
          
          /* Height-based title adjustments */
          @media (max-height: 700px) {
            .title {
              font-size: 26px;
              margin-bottom: 8px;
            }
          }
          
          @media (max-height: 600px) {
            .title {
              font-size: 22px;
              margin-bottom: 6px;
            }
          }
          
          @media (max-height: 500px) {
            .title {
              font-size: 18px;
              margin-bottom: 5px;
            }
          }
          
          @media (max-height: 400px) {
            .title {
              font-size: 16px;
              margin-bottom: 4px;
            }
          }
          
          .subtitle {
            font-size: 18px;
            color: #4b5563;
            margin-bottom: 40px;
            line-height: 1.5;
            animation: fadeInUp 0.8s ease-out 0.5s both;
          }
          
          /* Responsive subtitle */
          @media (max-width: 768px) {
            .subtitle {
              font-size: 16px;
              margin-bottom: 35px;
            }
          }
          
          @media (max-width: 480px) {
            .subtitle {
              font-size: 14px;
              margin-bottom: 30px;
            }
          }
          
          @media (max-width: 320px) {
            .subtitle {
              font-size: 13px;
              margin-bottom: 25px;
            }
          }
          
          /* Height-based subtitle adjustments */
          @media (max-height: 700px) {
            .subtitle {
              font-size: 15px;
              margin-bottom: 25px;
            }
          }
          
          @media (max-height: 600px) {
            .subtitle {
              font-size: 13px;
              margin-bottom: 20px;
            }
          }
          
          @media (max-height: 500px) {
            .subtitle {
              font-size: 12px;
              margin-bottom: 15px;
            }
          }
          
          @media (max-height: 400px) {
            .subtitle {
              font-size: 11px;
              margin-bottom: 10px;
            }
          }
          
          /* RTL support for title and subtitle */
          body.rtl .title {
            text-align: right;
            direction: rtl;
          }
          
          body.rtl .subtitle {
            text-align: right;
            direction: rtl;
          }
          
          .form-group {
            margin-bottom: 40px;
            animation: fadeInUp 0.8s ease-out 0.6s both;
            position: relative;
            z-index: 10;
          }
          
          /* Responsive form group */
          @media (max-width: 768px) {
            .form-group {
              margin-bottom: 35px;
            }
          }
          
          @media (max-width: 480px) {
            .form-group {
              margin-bottom: 30px;
            }
          }
          
          @media (max-width: 320px) {
            .form-group {
              margin-bottom: 25px;
            }
          }
          
          /* Height-based form group adjustments */
          @media (max-height: 700px) {
            .form-group {
              margin-bottom: 25px;
            }
          }
          
          @media (max-height: 600px) {
            .form-group {
              margin-bottom: 20px;
            }
          }
          
          @media (max-height: 500px) {
            .form-group {
              margin-bottom: 15px;
            }
          }
          
          @media (max-height: 400px) {
            .form-group {
              margin-bottom: 10px;
            }
          }
          
          .input-group {
            display: flex;
            align-items: center;
            background: rgba(255, 255, 255, 0.7);
            border: 2px solid rgba(102, 126, 234, 0.2);
            border-radius: 12px;
            padding: 0 20px;
            transition: all 0.3s;
            font-size: 18px;
          }
          
          /* Responsive input group */
          @media (max-width: 768px) {
            .input-group {
              padding: 0 15px;
              font-size: 16px;
              border-radius: 10px;
            }
          }
          
          @media (max-width: 480px) {
            .input-group {
              padding: 0 12px;
              font-size: 14px;
              border-radius: 8px;
              border-width: 2px;
            }
          }
          
          @media (max-width: 320px) {
            .input-group {
              padding: 0 10px;
              font-size: 13px;
              border-radius: 6px;
            }
          }
          
          /* Height-based input group adjustments */
          @media (max-height: 700px) {
            .input-group {
              padding: 0 15px;
              font-size: 16px;
              border-radius: 10px;
            }
          }
          
          @media (max-height: 600px) {
            .input-group {
              padding: 0 12px;
              font-size: 14px;
              border-radius: 8px;
              border-width: 2px;
            }
          }
          
          @media (max-height: 500px) {
            .input-group {
              padding: 0 10px;
              font-size: 13px;
              border-radius: 6px;
            }
          }
          
          @media (max-height: 400px) {
            .input-group {
              padding: 0 8px;
              font-size: 12px;
              border-radius: 5px;
            }
          }
          body.rtl .input-group {
            flex-direction: row-reverse;
          }
          .input-group:focus-within {
            border-color: #3B82F6;
            background: rgba(255, 255, 255, 0.9);
            box-shadow: 0 0 0 4px rgba(59, 130, 246, 0.1);
          }
          .prefix {
            color: #4b5563;
            font-weight: 600;
            margin-right: 5px;
          }
          body.rtl .prefix {
            margin-right: 0;
            margin-left: 5px;
            direction: ltr;
          }
          input { 
            flex: 1;
            padding: 20px 0;
            font-size: 18px;
            border: none;
            background: transparent;
            outline: none;
            font-weight: 500;
            color: #1f2937;
          }
          
          /* Responsive input */
          @media (max-width: 768px) {
            input {
              padding: 18px 0;
              font-size: 16px;
            }
          }
          
          @media (max-width: 480px) {
            input {
              padding: 15px 0;
              font-size: 14px;
            }
          }
          
          @media (max-width: 320px) {
            input {
              padding: 12px 0;
              font-size: 13px;
            }
          }
          
          /* Height-based input adjustments */
          @media (max-height: 700px) {
            input {
              padding: 15px 0;
              font-size: 16px;
            }
          }
          
          @media (max-height: 600px) {
            input {
              padding: 12px 0;
              font-size: 14px;
            }
          }
          
          @media (max-height: 500px) {
            input {
              padding: 10px 0;
              font-size: 13px;
            }
          }
          
          @media (max-height: 400px) {
            input {
              padding: 8px 0;
              font-size: 12px;
            }
          }
          
          body.rtl input {
            text-align: right;
            direction: ltr;
          }
          input::placeholder {
            color: #9ca3af;
          }
          .suffix {
            color: #4b5563;
            font-weight: 600;
            margin-left: 5px;
          }
          body.rtl .suffix {
            margin-left: 0;
            margin-right: 5px;
            direction: ltr;
          }
          .connect-btn { 
            background: linear-gradient(135deg, #3B82F6 0%, #8B5CF6 100%);
            color: white;
            border: none;
            padding: 18px 50px;
            font-size: 18px;
            font-weight: 600;
            font-family: 'Omnes', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            border-radius: 12px;
            cursor: pointer;
            transition: all 0.3s;
            box-shadow: 0 4px 15px rgba(59, 130, 246, 0.4);
            animation: fadeInUp 0.8s ease-out 0.7s both;
            position: relative;
            overflow: hidden;
            display: inline-flex;
            align-items: center;
            justify-content: center;
            gap: 10px;
          }
          
          .connect-btn::before {
            content: '';
            position: absolute;
            top: 0;
            left: -100%;
            width: 100%;
            height: 100%;
            background: linear-gradient(90deg, transparent, rgba(255, 255, 255, 0.4), transparent);
            animation: shine 3s infinite;
          }
          
          /* Responsive connect button */
          @media (max-width: 768px) {
            .connect-btn {
              padding: 16px 40px;
              font-size: 16px;
              border-radius: 10px;
            }
          }
          
          @media (max-width: 480px) {
            .connect-btn {
              padding: 14px 30px;
              font-size: 14px;
              border-radius: 8px;
              width: 100%;
            }
          }
          
          @media (max-width: 320px) {
            .connect-btn {
              padding: 12px 25px;
              font-size: 13px;
              border-radius: 6px;
            }
          }
          
          /* Height-based connect button adjustments */
          @media (max-height: 700px) {
            .connect-btn {
              padding: 14px 40px;
              font-size: 16px;
              border-radius: 10px;
            }
          }
          
          @media (max-height: 600px) {
            .connect-btn {
              padding: 12px 30px;
              font-size: 14px;
              border-radius: 8px;
            }
          }
          
          @media (max-height: 500px) {
            .connect-btn {
              padding: 10px 25px;
              font-size: 13px;
              border-radius: 6px;
            }
          }
          
          @media (max-height: 400px) {
            .connect-btn {
              padding: 8px 20px;
              font-size: 12px;
              border-radius: 5px;
            }
          }
          .connect-btn:hover {
            transform: translateY(-2px);
            box-shadow: 0 8px 25px rgba(59, 130, 246, 0.6);
          }
          .connect-btn:active {
            transform: translateY(0);
          }
          
          /* RTL support for connect button */
          body.rtl .connect-btn {
            direction: rtl;
            flex-direction: row-reverse;
          }
          body.rtl .connect-btn::before {
            left: auto;
            right: -100%;
            animation: shine-rtl 3s infinite;
          }
          @keyframes shine-rtl {
            0% { right: -100%; }
            50% { right: 100%; }
            100% { right: 100%; }
          }
          
          .example {
            font-size: 14px;
            color: #6b7280;
            margin-top: 15px;
          }
          
          /* Responsive example text */
          @media (max-width: 480px) {
            .example {
              font-size: 12px;
              margin-top: 12px;
            }
          }
          
          @media (max-width: 320px) {
            .example {
              font-size: 11px;
              margin-top: 10px;
            }
          }
          
          /* Height-based example text adjustments */
          @media (max-height: 700px) {
            .example {
              font-size: 12px;
              margin-top: 10px;
            }
          }
          
          @media (max-height: 600px) {
            .example {
              font-size: 11px;
              margin-top: 8px;
            }
          }
          
          @media (max-height: 500px) {
            .example {
              font-size: 10px;
              margin-top: 6px;
            }
          }
          
          @media (max-height: 400px) {
            .example {
              font-size: 9px;
              margin-top: 5px;
            }
          }
          
          body.rtl .example {
            text-align: right;
            direction: rtl;
          }
          
          .register-link {
            margin-top: 20px;
            padding-top: 16px;
            border-top: 1px solid rgba(102, 126, 234, 0.15);
            animation: fadeIn 1s ease-out 0.8s both;
            display: flex;
            align-items: center;
            justify-content: center;
            gap: 5px;
            flex-wrap: wrap;
          }
          
          .register-text {
            font-size: 14px;
            color: #9ca3af;
          }
          
          body.rtl .register-link {
            direction: rtl;
          }

          .register-btn {
            background: none;
            border: none;
            padding: 0;
            font-size: 14px;
            font-weight: 600;
            font-family: 'Omnes', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            color: #3B82F6;
            cursor: pointer;
            text-decoration: underline;
            text-underline-offset: 2px;
            transition: color 0.2s;
          }
          .register-btn:hover {
            color: #8B5CF6;
          }
          
          /* Windows-specific styles */
          @media screen and (-ms-high-contrast: active), (-ms-high-contrast: none) {
            /* IE10+ and Edge specific styles */
            .container {
              min-height: 100vh !important;
              display: flex !important;
              flex-direction: column !important;
              justify-content: center !important;
            }
            
            .logo {
              max-width: 120px !important;
              height: auto !important;
            }
            
            .title {
              font-size: 28px !important;
              line-height: 1.2 !important;
            }
            
            .subtitle {
              font-size: 16px !important;
              line-height: 1.4 !important;
            }
            
            .input-group {
              min-height: 50px !important;
              display: flex !important;
              align-items: center !important;
            }
            
          }
          
          /* Windows 10/11 specific adjustments */
          @supports (-ms-ime-align: auto) {
            body {
              font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif !important;
            }
            
            .container {
              padding: 20px !important;
            }
            
            .title {
              font-weight: 600 !important;
            }
            
            .input-group {
              border: 2px solid #e9ecef !important;
            }
            
          }
          
          /* Tabler Icons styling */
          .ti {
            display: inline-block;
            vertical-align: middle;
            margin-right: 6px;
            font-size: 18px;
          }
          
          [dir="rtl"] .ti {
            margin-right: 0;
            margin-left: 6px;
          }
          
          .history-clear .ti,
          .history-item button .ti {
            margin-right: 0;
            margin-left: 0;
          }
        </style>
        <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/@tabler/icons-webfont@latest/tabler-icons.min.css">
        <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/sweetalert2@11/dist/sweetalert2.min.css">
        <script src="https://cdn.jsdelivr.net/npm/sweetalert2@11/dist/sweetalert2.all.min.js"></script>
      </head>
      <body>
        <div class="container">
          <div class="lang-selector" id="lang-selector">
            <button class="lang-trigger" id="lang-trigger" onclick="toggleLangDropdown()">
              <i class="ti ti-world"></i>
              <span id="lang-current">English</span>
              <i class="ti ti-chevron-down lang-chevron"></i>
            </button>
            <div class="lang-dropdown" id="lang-dropdown">
              <button class="lang-option" id="lang-en" data-lang="en">
                <span class="lang-flag">🇬🇧</span>
                <span>English</span>
              </button>
              <button class="lang-option" id="lang-ar" data-lang="ar">
                <span class="lang-flag">🇸🇦</span>
                <span>العربية</span>
              </button>
            </div>
          </div>
          <div class="logo"><img src="${logoSrc}" alt="opticsify"></div>
          <div class="title" id="title">Enter Your Store Domain</div>
          <div class="subtitle" id="subtitle">Enter subdomain or custom domain to continue</div>
          
          <div class="form-group">
            <div class="domain-type-switch">
              <button class="domain-type-btn active" id="subdomain-btn" onclick="switchDomainType('subdomain')"><i class="ti ti-link"></i> Subdomain</button>
              <button class="domain-type-btn" id="custom-btn" onclick="switchDomainType('custom')"><i class="ti ti-building-store"></i> Custom Domain</button>
            </div>
            <div class="input-group" id="subdomain-input">
              <span class="prefix">https://</span>
              <input type="text" id="input" placeholder="mystore" autofocus>
              <span class="suffix">.opticsify.com</span>
            </div>
            <div class="input-group" id="custom-input" style="display: none;">
              <span class="prefix">https://</span>
              <input type="text" id="custom-domain-input" placeholder="mystore.com">
            </div>
            <div class="history-wrapper">
              <button class="history-btn" id="history-btn" onclick="toggleHistory()" style="display:none">
                <i class="ti ti-clock"></i>
                <span id="history-btn-text">Previous Domains</span>
              </button>
              <div class="history-dropdown" id="history-dropdown">
                <div class="history-header">
                  <span id="history-title"><i class="ti ti-clock"></i> Previous Domains</span>
                  <span class="history-clear" onclick="clearAllHistory()" id="history-clear"><i class="ti ti-trash"></i> Clear All</span>
                </div>
                <div id="history-list"></div>
              </div>
            </div>
            <div class="example" id="example">Example: If your store is "mystore.opticsify.com", enter "mystore"</div>
          </div>
          
          <button class="connect-btn" onclick="connect()" id="connect-btn"><i class="ti ti-arrow-right"></i> Connect to Store</button>
          
          <div class="register-link">
            <div class="register-text" id="register-text">Don't have a store yet?</div>
            <button class="register-btn" onclick="openRegistration()" id="register-btn">Create Your Store</button>
          </div>
        </div>
        
        <script>
          ////console.log('Script loaded successfully');
          
          // Domain type state
          let currentDomainType = 'subdomain';
          
          function switchDomainType(type) {
            currentDomainType = type;
            const subdomainBtn = document.getElementById('subdomain-btn');
            const customBtn = document.getElementById('custom-btn');
            const subdomainInput = document.getElementById('subdomain-input');
            const customInput = document.getElementById('custom-input');
            const exampleEl = document.getElementById('example');
            const currentLang = localStorage.getItem('templateCustomizer-vertical-menu-template--Lang') || 'en';
            
            if (type === 'subdomain') {
              subdomainBtn.classList.add('active');
              customBtn.classList.remove('active');
              subdomainInput.style.display = 'flex';
              customInput.style.display = 'none';
              document.getElementById('input').focus();
              exampleEl.textContent = translations[currentLang].exampleSubdomain;
            } else {
              customBtn.classList.add('active');
              subdomainBtn.classList.remove('active');
              subdomainInput.style.display = 'none';
              customInput.style.display = 'flex';
              document.getElementById('custom-domain-input').focus();
              exampleEl.textContent = translations[currentLang].exampleCustom;
            }
          }
          
          // Language translations
          const translations = {
            en: {
              title: 'Enter Your Store Domain',
              subtitle: 'Enter subdomain or custom domain to continue',
              placeholder: 'mystore',
              placeholderCustom: 'mystore.com',
              exampleSubdomain: 'Example: If your store is "mystore.opticsify.com", enter "mystore"',
              exampleCustom: 'Example: Enter your full domain like "mystore.com"',
              connectBtn: '<i class="ti ti-arrow-right"></i> Connect to Store',
              registerText: "Don't have a store yet?",
              registerBtn: 'Create Your Store',
              errorInvalidSubdomain: 'Please enter a domain to continue',
              errorConnection: 'Connection error. Please try again.',
              errorDialogTitle: 'Invalid Domain',
              errorDialogMessage: 'Domain Not Found',
              errorDialogDetail: 'The domain "{domain}" does not exist or is not accessible. Please check the domain and try again.',
              errorDialogButton: 'OK',
              subdomainBtn: '<i class="ti ti-link"></i> Subdomain',
              customBtn: '<i class="ti ti-building-store"></i> Custom Domain',
              historyBtn: 'Previous Domains',
              historyTitle: '<i class="ti ti-clock"></i> Previous Domains',
              historyClear: '<i class="ti ti-trash"></i> Clear All',
              historyEmpty: 'No previous domains',
              historyDelete: '<i class="ti ti-x"></i>',
              historySubdomain: 'Subdomain',
              historyCustom: 'Custom Domain'
            },
            ar: {
              title: 'أدخل نطاق متجرك',
              subtitle: 'أدخل نطاق فرعي أو نطاق مخصص للمتابعة',
              placeholder: 'mystore',
              placeholderCustom: 'mystore.com',
              exampleSubdomain: 'مثال: إذا كان متجرك "mystore.opticsify.com"، أدخل "mystore"',
              exampleCustom: 'مثال: أدخل نطاقك الكامل مثل "mystore.com"',
              connectBtn: '<i class="ti ti-arrow-left"></i> الاتصال بالمتجر',
              registerText: 'ليس لديك متجر بعد؟',
              registerBtn: 'إنشاء متجرك',
              errorInvalidSubdomain: 'يرجى إدخال نطاق للمتابعة',
              errorConnection: 'خطأ في الاتصال. يرجى المحاولة مرة أخرى.',
              errorDialogTitle: 'نطاق غير صالح',
              errorDialogMessage: 'النطاق غير موجود',
              errorDialogDetail: 'النطاق "{domain}" غير موجود أو غير قابل للوصول. يرجى التحقق من النطاق والمحاولة مرة أخرى.',
              errorDialogButton: 'موافق',
              subdomainBtn: '<i class="ti ti-link"></i> نطاق فرعي',
              customBtn: '<i class="ti ti-building-store"></i> نطاق مخصص',
              historyBtn: 'النطاقات السابقة',
              historyTitle: '<i class="ti ti-clock"></i> النطاقات السابقة',
              historyClear: '<i class="ti ti-trash"></i> مسح الكل',
              historyEmpty: 'لا توجد نطاقات سابقة',
              historyDelete: '<i class="ti ti-x"></i>',
              historySubdomain: 'نطاق فرعي',
              historyCustom: 'نطاق مخصص'
            }
          };
          
          // Language switching functionality
          async function switchLanguage(lang) {
            // Apply language in-place — no reload needed (and reload would fail because
            // the temp HTML file is deleted after initial load)
            await applyLanguage(lang);
          }
          
          async function applyLanguage(lang) {
            ////console.log('applyLanguage called with:', lang);
            const t = translations[lang] || translations.en;
            ////console.log('Using translations:', t);
            
            // Get current subdomain
            let subdomain = '';
            if (window.electronAPI && window.electronAPI.getSubdomain) {
              subdomain = await window.electronAPI.getSubdomain() || '';
            }
            
            const storageKey = subdomain ? subdomain + '_' : '';
            
            // Always save without prefix (for landing page and as fallback)
            localStorage.setItem('templateCustomizer-vertical-menu-template--Lang', lang);
            localStorage.setItem('templateCustomizer-vertical-menu-template--Rtl', lang === 'ar' ? 'true' : 'false');
            // Don't set Style - let web app control theme
            
            // Also save with subdomain prefix if subdomain exists
            if (subdomain) {
              localStorage.setItem(storageKey + 'templateCustomizer-vertical-menu-template--Lang', lang);
              localStorage.setItem(storageKey + 'templateCustomizer-vertical-menu-template--Rtl', lang === 'ar' ? 'true' : 'false');
              // Don't set Style - let web app control theme
            }
            
            // Save to Electron store to ensure persistence
            if (window.electronAPI && window.electronAPI.setLanguage) {
              try {
                await window.electronAPI.setLanguage(lang);
                console.log('Language applied and saved to Electron store:', lang, subdomain ? '(subdomain: ' + subdomain + ')' : '(global - landing page)');
              } catch (e) {
                console.error('Error saving language to Electron store:', e);
              }
            }
            
            // Update text content
            const titleEl = document.getElementById('title');
            const subtitleEl = document.getElementById('subtitle');
            const inputEl = document.getElementById('input');
            const customInputEl = document.getElementById('custom-domain-input');
            const exampleEl = document.getElementById('example');
            const connectBtnEl = document.getElementById('connect-btn');
            const registerTextEl = document.getElementById('register-text');
            const registerBtnEl = document.getElementById('register-btn');
            const subdomainBtnEl = document.getElementById('subdomain-btn');
            const customBtnEl = document.getElementById('custom-btn');
            
            if (titleEl) titleEl.textContent = t.title;
            if (subtitleEl) subtitleEl.textContent = t.subtitle;
            if (inputEl) inputEl.placeholder = t.placeholder;
            if (customInputEl) customInputEl.placeholder = t.placeholderCustom;
            if (exampleEl) exampleEl.textContent = currentDomainType === 'subdomain' ? t.exampleSubdomain : t.exampleCustom;
            if (connectBtnEl) connectBtnEl.innerHTML = t.connectBtn;
            if (registerTextEl) registerTextEl.textContent = t.registerText;
            if (registerBtnEl) registerBtnEl.innerHTML = t.registerBtn;
            if (subdomainBtnEl) subdomainBtnEl.innerHTML = t.subdomainBtn;
            if (customBtnEl) customBtnEl.innerHTML = t.customBtn;
            
            // Update history UI
            const historyBtnText = document.getElementById('history-btn-text');
            const historyTitle = document.getElementById('history-title');
            const historyClear = document.getElementById('history-clear');
            if (historyBtnText) historyBtnText.innerHTML = t.historyBtn;
            if (historyTitle) historyTitle.innerHTML = t.historyTitle;
            if (historyClear) historyClear.innerHTML = t.historyClear;
            
            // Reload history to update type labels
            const dropdown = document.getElementById('history-dropdown');
            if (dropdown && dropdown.classList.contains('show')) {
              await window.loadHistory();
            }
            
            // Apply RTL/LTR
            if (lang === 'ar') {
              ////console.log('Applying Arabic RTL styles');
              document.body.classList.add('rtl');
              document.documentElement.setAttribute('dir', 'rtl');
              document.documentElement.setAttribute('lang', 'ar');
            } else {
              ////console.log('Applying English LTR styles');
              document.body.classList.remove('rtl');
              document.documentElement.setAttribute('dir', 'ltr');
              document.documentElement.setAttribute('lang', 'en');
            }
            
            // Update active language option and trigger label
            const langLabels = { en: 'English', ar: 'العربية' };
            const langCurrentEl = document.getElementById('lang-current');
            if (langCurrentEl) langCurrentEl.textContent = langLabels[lang] || lang;
            document.querySelectorAll('.lang-option').forEach(btn => {
              btn.classList.toggle('active', btn.dataset.lang === lang);
            });
            
            // Replay animations on language switch
            const container = document.querySelector('.container');
            if (container) {
              // Disable animations briefly
              container.classList.add('no-animation');
              
              // Force reflow
              void container.offsetWidth;
              
              // Re-enable animations after a small delay
              setTimeout(() => {
                container.classList.remove('no-animation');
              }, 50);
            }
            
            ////console.log('Language applied successfully:', lang);
          }
          
          // Initialize language on page load
          async function initializeLanguage() {
            // First try to get from Electron store, then fallback to localStorage
            let savedLang = 'en'; // default
            
            // Get current subdomain
            let subdomain = '';
            if (window.electronAPI && window.electronAPI.getSubdomain) {
              subdomain = await window.electronAPI.getSubdomain() || '';
            }
            
            const storageKey = subdomain ? subdomain + '_' : '';
            
            if (window.electronAPI && window.electronAPI.getLanguage) {
              // Try to get from Electron store first
              window.electronAPI.getLanguage().then(async lang => {
                if (lang) {
                  savedLang = lang;
                } else {
                  // Try subdomain-prefixed storage first, then fallback to non-prefixed
                  savedLang = localStorage.getItem(storageKey + 'templateCustomizer-vertical-menu-template--Lang') 
                    || localStorage.getItem('templateCustomizer-vertical-menu-template--Lang') 
                    || 'en';
                  
                  // Save to Electron store for transfer to web app
                  if (window.electronAPI && window.electronAPI.setLanguage) {
                    await window.electronAPI.setLanguage(savedLang);
                  }
                }
                ////console.log('Initializing with saved language:', savedLang);
                await applyLanguage(savedLang);
              }).catch(async () => {
                // Fallback to localStorage if Electron store fails
                savedLang = localStorage.getItem(storageKey + 'templateCustomizer-vertical-menu-template--Lang') 
                  || localStorage.getItem('templateCustomizer-vertical-menu-template--Lang') 
                  || 'en';
                ////console.log('Initializing with saved language (fallback):', savedLang);
                await applyLanguage(savedLang);
              });
            } else {
              // Fallback to localStorage if electronAPI not available
              savedLang = localStorage.getItem(storageKey + 'templateCustomizer-vertical-menu-template--Lang') 
                || localStorage.getItem('templateCustomizer-vertical-menu-template--Lang') 
                || 'en';
              ////console.log('Initializing with saved language (no electronAPI):', savedLang);
              await applyLanguage(savedLang);
            }
          }
          
          // Load logo dynamically
          async function loadLogo() {
            try {
              if (window.electronAPI && window.electronAPI.getLogo) {
                const logoData = await window.electronAPI.getLogo();
                if (logoData) {
                  const logoImg = document.querySelector('.logo img');
                  if (logoImg) {
                    logoImg.src = logoData;
                    ////console.log('Logo loaded successfully');
                  }
                }
              }
            } catch (error) {
              console.error('Error loading logo:', error);
            }
          }
          
          // Load animated background SVG
          async function loadBackgroundSVG() {
            try {
              if (window.electronAPI && window.electronAPI.getBackgroundSVG) {
                const svgData = await window.electronAPI.getBackgroundSVG();
                if (svgData) {
                  document.body.style.setProperty('--bg-svg', 'url(' + svgData + ')');
                  ////console.log('Background SVG loaded successfully');
                }
              }
            } catch (error) {
              console.error('Error loading background SVG:', error);
            }
          }
          
          // Load logo when page is ready
          document.addEventListener('DOMContentLoaded', function() {
            ////console.log('DOM loaded - initializing page');
            loadLogo();
            loadBackgroundSVG();
            initializeLanguage();
            if (window.updateHistoryBtn) window.updateHistoryBtn();
            
            // Add keypress listener for both inputs
            const inputElement = document.getElementById('input');
            const customInputElement = document.getElementById('custom-domain-input');
            
            if (inputElement) {
              ////console.log('Adding keypress listener to subdomain input');
              inputElement.addEventListener('keypress', (e) => {
                ////console.log('Key pressed:', e.key);
                if (e.key === 'Enter') {
                  ////console.log('Enter key pressed, calling connect');
                  connect();
                }
              });
            } else {
              console.error('Input element not found for keypress listener');
            }
            
            if (customInputElement) {
              ////console.log('Adding keypress listener to custom domain input');
              customInputElement.addEventListener('keypress', (e) => {
                ////console.log('Key pressed in custom input:', e.key);
                if (e.key === 'Enter') {
                  ////console.log('Enter key pressed in custom input, calling connect');
                  connect();
                }
              });
            } else {
              console.error('Custom domain input element not found for keypress listener');
            }
            
            // Language selector dropdown toggle
            window.toggleLangDropdown = function() {
              const sel = document.getElementById('lang-selector');
              if (sel) sel.classList.toggle('open');
            };

            // Add event listeners for language options
            document.querySelectorAll('.lang-option').forEach(btn => {
              btn.addEventListener('click', async () => {
                const lang = btn.dataset.lang;
                document.getElementById('lang-selector').classList.remove('open');
                await window.switchLanguage(lang);
              });
            });

            // Close lang dropdown when clicking outside
            document.addEventListener('click', function(e) {
              const sel = document.getElementById('lang-selector');
              if (sel && !sel.contains(e.target)) {
                sel.classList.remove('open');
              }
            });
          });
          
          // Use electronAPI from preload script instead of direct require
          if (window.electronAPI) {
            ////console.log('electronAPI available');
            
            // Domain History Management Functions

            // Show or hide the history button depending on whether saved domains exist
            window.updateHistoryBtn = async function() {
              const btn = document.getElementById('history-btn');
              if (!btn) return;
              try {
                const history = await window.electronAPI.getDomainHistory();
                btn.style.display = (history && history.length > 0) ? '' : 'none';
              } catch (e) {
                btn.style.display = 'none';
              }
            };

            window.toggleHistory = async function() {
              const dropdown = document.getElementById('history-dropdown');
              if (dropdown.classList.contains('show')) {
                dropdown.classList.remove('show');
              } else {
                dropdown.classList.add('show');
                await window.loadHistory();
              }
            };
            
            window.loadHistory = async function() {
              const historyList = document.getElementById('history-list');
              const currentLang = localStorage.getItem('templateCustomizer-vertical-menu-template--Lang') || 'en';
              const t = translations[currentLang];
              
              try {
                const history = await window.electronAPI.getDomainHistory();

                // Keep button visibility in sync
                const btn = document.getElementById('history-btn');
                if (btn) btn.style.display = (history && history.length > 0) ? '' : 'none';

                if (!history || history.length === 0) {
                  // Close dropdown if now empty
                  const dropdown = document.getElementById('history-dropdown');
                  if (dropdown) dropdown.classList.remove('show');
                  historyList.innerHTML = '<div class="history-empty">' + t.historyEmpty + '</div>';
                  return;
                }
                
                historyList.innerHTML = '';
                history.forEach((item, index) => {
                  const itemEl = document.createElement('div');
                  itemEl.className = 'history-item';
                  
                  const typeLabel = item.type === 'custom' ? t.historyCustom : t.historySubdomain;
                  
                  // Create domain info section
                  const domainInfo = document.createElement('div');
                  domainInfo.className = 'history-domain-info';
                  
                  const domainDiv = document.createElement('div');
                  domainDiv.className = 'history-domain';
                  domainDiv.textContent = item.domain;
                  
                  const typeDiv = document.createElement('div');
                  typeDiv.className = 'history-type';
                  typeDiv.textContent = typeLabel;
                  
                  domainInfo.appendChild(domainDiv);
                  domainInfo.appendChild(typeDiv);
                  domainInfo.addEventListener('click', () => selectHistoryDomain(item.domain, item.type));
                  
                  // Create delete button
                  const deleteBtn = document.createElement('div');
                  deleteBtn.className = 'history-delete';
                  deleteBtn.innerHTML = t.historyDelete;
                  deleteBtn.addEventListener('click', (e) => deleteDomain(index, e));
                  
                  itemEl.appendChild(domainInfo);
                  itemEl.appendChild(deleteBtn);
                  historyList.appendChild(itemEl);
                });
              } catch (error) {
                console.error('Error loading history:', error);
                historyList.innerHTML = '<div class="history-empty">Error loading history</div>';
              }
            }
            
            window.selectHistoryDomain = async function(domain, type) {
              const dropdown = document.getElementById('history-dropdown');
              dropdown.classList.remove('show');
              
              // Switch to the correct domain type
              switchDomainType(type);
              
              // Fill in the input
              if (type === 'subdomain') {
                const subdomainPart = domain.replace('.opticsify.com', '');
                document.getElementById('input').value = subdomainPart;
              } else {
                document.getElementById('custom-domain-input').value = domain;
              }
            };
            
            window.deleteDomain = async function(index, event) {
              event.stopPropagation();
              
              try {
                await window.electronAPI.deleteDomainHistory(index);
                await window.loadHistory();
              } catch (error) {
                console.error('Error deleting domain:', error);
              }
            };
            
            window.clearAllHistory = async function() {
              const currentLang = localStorage.getItem('templateCustomizer-vertical-menu-template--Lang') || 'en';
              const isAr = currentLang === 'ar';

              const result = await Swal.fire({
                title: isAr ? 'حذف السجل' : 'Clear History',
                text: isAr ? 'هل أنت متأكد من حذف جميع النطاقات السابقة؟' : 'Are you sure you want to clear all previous domains?',
                icon: 'warning',
                showCancelButton: true,
                confirmButtonColor: '#ef4444',
                cancelButtonColor: '#6b7280',
                confirmButtonText: isAr ? 'نعم، احذف' : 'Yes, clear',
                cancelButtonText: isAr ? 'إلغاء' : 'Cancel',
                reverseButtons: isAr,
              });

              if (result.isConfirmed) {
                try {
                  await window.electronAPI.clearDomainHistory();
                  await window.loadHistory();
                } catch (error) {
                  console.error('Error clearing history:', error);
                }
              }
            };
            
            // Close dropdown when clicking outside
            document.addEventListener('click', function(event) {
              const dropdown = document.getElementById('history-dropdown');
              const historyBtn = document.getElementById('history-btn');
              
              if (dropdown && historyBtn && 
                  !dropdown.contains(event.target) && 
                  !historyBtn.contains(event.target)) {
                dropdown.classList.remove('show');
              }
            });
            
            async function connect() {
              ////console.log('Connect function called');
              const inputElement = currentDomainType === 'subdomain' 
                ? document.getElementById('input')
                : document.getElementById('custom-domain-input');
              ////console.log('Input element:', inputElement);
              
              if (!inputElement) {
                console.error('Input element not found!');
                return;
              }
              
              const value = inputElement.value.trim();
              ////console.log('Connect button clicked, value:', value, 'type:', currentDomainType);
              
              if (value) {
                ////console.log('Submitting domain via electronAPI:', value);
                try {
                  // Save current language to Electron store BEFORE navigating
                  const currentLang = localStorage.getItem('templateCustomizer-vertical-menu-template--Lang') || 'en';
                  if (window.electronAPI && window.electronAPI.setLanguage) {
                    await window.electronAPI.setLanguage(currentLang);
                    console.log('Language saved before navigation:', currentLang);
                  }
                  
                  const result = await window.electronAPI.submitSubdomain({ 
                    value, 
                    type: currentDomainType 
                  });
                  ////console.log('Domain submission result:', result);
                  
                  if (result.success) {
                    ////console.log('Domain accepted, reloading with:', result.domain);
                    // The main process will handle the navigation
                  } else {
                    console.error('Domain submission failed:', result.error);
                    showError(result.error || 'Invalid domain');
                  }
                } catch (error) {
                  console.error('Error submitting domain:', error);
                  const currentLang = localStorage.getItem('templateCustomizer-vertical-menu-template--Lang') || 'en';
                  const errorMessage = translations[currentLang].errorConnection;
                  showError(errorMessage);
                }
              } else {
                ////console.log('No value entered, showing error');
                const currentLang = localStorage.getItem('templateCustomizer-vertical-menu-template--Lang') || 'en';
                const errorMessage = translations[currentLang].errorInvalidSubdomain;
                showError(errorMessage);
              }
            }
            
            function showError(message) {
              // Highlight the active input briefly
              const activeInputGroup = document.querySelector('#subdomain-input.input-group') ||
                                       document.querySelector('.input-group:not([style*="display: none"])');
              if (activeInputGroup) {
                activeInputGroup.style.borderColor = '#ef4444';
                activeInputGroup.style.transition = 'border-color 0.3s';
                setTimeout(() => { activeInputGroup.style.borderColor = ''; }, 2500);
              }

              Swal.fire({
                toast: true,
                position: 'top',
                icon: 'error',
                title: message,
                showConfirmButton: false,
                timer: 3000,
                timerProgressBar: true,
              });
            }
            
            // Make connect function global
            window.connect = connect;
            ////console.log('Connect function attached to window');
            
            // Function to open registration page
            async function openRegistration() {
              ////console.log('Opening registration page');
              try {
                await window.electronAPI.openExternal('https://opticsify.com/opticsify/signup.php');
              } catch (error) {
                console.error('Error opening registration page:', error);
              }
            }
            
            // Make openRegistration function global
            window.openRegistration = openRegistration;
            ////console.log('OpenRegistration function attached to window');
            
            // Make switchLanguage function global
            window.switchLanguage = switchLanguage;
            ////console.log('SwitchLanguage function attached to window');
            
            document.addEventListener('DOMContentLoaded', () => {
              ////console.log('DOM loaded');
              // This is a duplicate event listener - removing it
            });
            
          } else {
            console.error('electronAPI not available - preload script may not be loaded');
          }
        </script>
      </body>
      </html>
    `;

    // Load the HTML directly into the main window using loadFile approach
    const fs = require('fs');
    const path = require('path');
    const os = require('os');
    
    // Use system temp directory instead of app directory (which is read-only in production)
    const tempHtmlPath = path.join(os.tmpdir(), 'opticsify-subdomain-form.html');
    
    //console.log('showSubdomainFormInMainWindow: Writing HTML to temp file:', tempHtmlPath);
    
    // Write HTML to temporary file
    fs.writeFileSync(tempHtmlPath, html, 'utf8');
    
    //console.log('showSubdomainFormInMainWindow: Loading HTML file into mainWindow');
    
    // Load the temporary HTML file
    mainWindow.loadFile(tempHtmlPath).then(() => {
      //console.log('showSubdomainFormInMainWindow: HTML file loaded successfully');
      // Clean up temporary file after loading
      setTimeout(() => {
        try {
          fs.unlinkSync(tempHtmlPath);
          //console.log('showSubdomainFormInMainWindow: Temp file cleaned up');
        } catch (error) {
          //console.log('Temp file cleanup error (non-critical):', error.message);
        }
      }, 1000);
    }).catch(error => {
      console.error('showSubdomainFormInMainWindow: Error loading HTML file:', error);
      //console.log('showSubdomainFormInMainWindow: Falling back to data URL');
      // Fallback to data URL without encoding
      mainWindow.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
    });
    
    // Remove any existing listeners to prevent conflicts
    const { ipcMain } = require('electron');
    // No need to handle main-window-subdomain-result anymore since we use submit-subdomain handler
    
    // The form will use electronAPI.submitSubdomain which is handled by the existing handler
    // No need for additional listeners here
  });
}

// IPC handler to open external URLs
// IPC handler for setting language
ipcMain.handle('set-language', async (event, language) => {
  // Get current subdomain
  const subdomain = store.get('customerSubdomain', '');
  
  // Save globally (for landing page)
  store.set('language', language);
  
  // Also save subdomain-specific language if subdomain exists
  if (subdomain) {
    store.set(`language_${subdomain}`, language);
    ////console.log('Language saved to store for subdomain', subdomain, ':', language);
  } else {
    ////console.log('Language saved to store (global):', language);
  }
  
  // Refresh menu with new language
  createMenu();
});

// IPC handler for getting language
ipcMain.handle('get-language', async (event) => {
  // Get current subdomain
  const subdomain = store.get('customerSubdomain', '');
  
  // Try to get subdomain-specific language first
  if (subdomain) {
    const subdomainLang = store.get(`language_${subdomain}`, null);
    if (subdomainLang) {
      ////console.log('Language retrieved from store for subdomain', subdomain, ':', subdomainLang);
      return subdomainLang;
    }
  }
  
  // Fall back to global language
  const language = store.get('language', 'en');
  ////console.log('Language retrieved from store (global):', language);
  return language;
});

ipcMain.handle('open-external', async (event, url) => {
  try {
    ////console.log('Opening external URL:', url);
    await shell.openExternal(url);
    return { success: true };
  } catch (error) {
    console.error('Error opening external URL:', error);
    return { success: false, error: error.message };
  }
});

// IPC handler to get logo data
ipcMain.handle('get-logo', async () => {
  try {
    const fs = require('fs');
    const logoPath = path.join(__dirname, 'assets', 'logo.png');
    const logoData = fs.readFileSync(logoPath);
    const base64String = logoData.toString('base64');
    return 'data:image/png;base64,' + base64String;
  } catch (error) {
    console.error('Error loading logo:', error);
    // Fallback to icon if logo.png fails
    try {
      const fallbackPath = path.join(__dirname, 'assets', 'icon.png');
      const fallbackData = fs.readFileSync(fallbackPath);
      const base64String = fallbackData.toString('base64');
      return 'data:image/png;base64,' + base64String;
    } catch (fallbackError) {
      console.error('Error loading fallback logo:', fallbackError);
      return null;
    }
  }
});

// IPC handler to get animated background SVG
ipcMain.handle('get-background-svg', async () => {
  // Simply return the URL - let the browser handle loading it
  return 'https://opticsify.com/images/backgrounds/login-background.svg';
});

// Helper function to show SweetAlert2 in the renderer
async function showSweetAlert(options) {
  if (!mainWindow || mainWindow.isDestroyed()) return null;

  const sweetalert2Path = path.join(__dirname, 'node_modules', 'sweetalert2', 'dist', 'sweetalert2.all.min.js');
  const sweetalert2JS = fs.readFileSync(sweetalert2Path, 'utf8');
  const swalJson = JSON.stringify(sweetalert2JS);
  const optsJson = JSON.stringify(options);

  try {
    // Reset state, load Swal if not present, then fire
    await mainWindow.webContents.executeJavaScript(`
      window.__swalDone = false;
      window.__swalResult = undefined;
      (function() {
        function _fire() {
          Swal.fire(${optsJson}).then(function(r) {
            window.__swalResult = r;
            window.__swalDone = true;
          });
        }
        if (typeof Swal === 'undefined') {
          var s = document.createElement('script');
          s.textContent = ${swalJson};
          document.head.appendChild(s);
        }
        _fire();
      })();
    `);

    // Poll every 150 ms until user interacts (up to 5 minutes)
    for (let i = 0; i < 2000; i++) {
      await new Promise(r => setTimeout(r, 150));
      const done = await mainWindow.webContents.executeJavaScript('!!window.__swalDone');
      if (done) {
        return await mainWindow.webContents.executeJavaScript('window.__swalResult');
      }
    }
    return null;
  } catch (error) {
    console.error('Error showing SweetAlert:', error);
    return null;
  }
}

// IPC handler for showing SweetAlert2
ipcMain.handle('show-sweet-alert', async (event, options) => {
  return await showSweetAlert(options);
});

// IPC handler for back button functionality
ipcMain.on('navigate-back', () => {
  if (mainWindow && mainWindow.webContents.navigationHistory.canGoBack()) {
    try {
      // Try to go back multiple steps to skip redirects
      const history = mainWindow.webContents.navigationHistory;
      const currentIndex = history.getActiveIndex();
      
      // Go back up to 3 steps to skip intermediate redirects
      let targetIndex = Math.max(0, currentIndex - 3);
      
      // Check if we can find a meaningful page to go back to
      // Note: getAllEntries() might not be available in all Electron versions
      // Use a safer approach with canGoBack() and goBack()
      let stepsBack = 0;
      const maxSteps = 3;
      
      // Try to go back multiple steps, but safely
      while (stepsBack < maxSteps && mainWindow.webContents.navigationHistory.canGoBack()) {
        mainWindow.webContents.navigationHistory.goBack();
        stepsBack++;
        
        // Check if we've reached a meaningful page (not a redirect)
        const currentUrl = mainWindow.webContents.getURL();
        if (currentUrl && !currentUrl.includes('redirect') && !currentUrl.includes('loading')) {
          break;
        }
      }
      
      // If we didn't go back at all, try at least once
      if (stepsBack === 0 && mainWindow.webContents.navigationHistory.canGoBack()) {
        mainWindow.webContents.navigationHistory.goBack();
      }
    } catch (error) {
      console.error('Error in navigate-back:', error);
      // Fallback to simple goBack
      if (mainWindow.webContents.navigationHistory.canGoBack()) {
        mainWindow.webContents.navigationHistory.goBack();
      }
    }
  }
});

// IPC handler for print functionality with error handling
ipcMain.handle('print-page', async (event, options = {}) => {
  ////console.log('IPC: print-page called with options:', options);
  try {
    if (!mainWindow || mainWindow.isDestroyed()) {
      console.error('Print failed: Main window not available');
      return { success: false, error: 'Window not available' };
    }

    // Check if we should show print dialog or print silently
    const showDialog = options.showDialog !== false;
    
    if (showDialog) {
      // Show print dialog using SweetAlert2
      const result = await showSweetAlert({
        icon: 'question',
        title: 'Print Page',
        text: 'Do you want to print this page? This will open your system print dialog.',
        showCancelButton: true,
        confirmButtonText: 'Print',
        cancelButtonText: 'Cancel',
        confirmButtonColor: '#3B82F6',
        cancelButtonColor: '#6B7280'
      });

      if (!result || !result.isConfirmed) {
        ////console.log('Print cancelled by user');
        return { success: false, error: 'Print cancelled by user' };
      }
    }

    // Default print options - always show system dialog for safety
    const printOptions = {
      silent: false, // Always show system print dialog
      printBackground: true,
      color: true,
      margin: {
        marginType: 'printableArea'
      },
      landscape: false,
      pagesPerSheet: 1,
      collate: false,
      copies: 1,
      header: '',
      footer: '',
      ...options,
      // Override silent to always be false for safety
      silent: false
    };

    ////console.log('Attempting to print with options:', printOptions);
    
    // Use webContents.print() with proper error handling
    return new Promise((resolve) => {
      try {
        mainWindow.webContents.print(printOptions, (success, failureReason) => {
          if (success) {
            ////console.log('Print completed successfully');
            resolve({ success: true });
          } else {
            console.error('Print failed:', failureReason);
            resolve({ success: false, error: failureReason || 'Print operation failed' });
          }
        });
      } catch (printError) {
        console.error('Print execution error:', printError);
        resolve({ success: false, error: printError.message });
      }
    });
  } catch (error) {
    console.error('Print error:', error);
    return { success: false, error: error.message };
  }
});

// IPC handler for print preview
ipcMain.handle('print-preview', async (event) => {
  ////console.log('IPC: print-preview called');
  try {
    if (!mainWindow || mainWindow.isDestroyed()) {
      console.error('Print preview failed: Main window not available');
      return { success: false, error: 'Window not available' };
    }

    // Generate PDF for preview
    const pdfData = await mainWindow.webContents.printToPDF({
      printBackground: true,
      color: true,
      margin: {
        marginType: 'printableArea'
      }
    });

    ////console.log('Print preview PDF generated successfully');
    return { success: true, pdfData: pdfData.toString('base64') };
  } catch (error) {
    console.error('Print preview error:', error);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('check-can-go-back', () => {
  ////console.log('IPC: check-can-go-back called');
  try {
    if (mainWindow) {
      // Check if page is currently loading - disable back button during loading
      if (mainWindow.webContents.isLoading()) {
        //console.log('check-can-go-back: Page is loading, disabling back button');
        return { canGoBack: false };
      }
      
      const currentURL = mainWindow.webContents.getURL();
      
      // Use our new URL-based navigation check
      const canGoBackToUrlResult = canGoBackToUrl();
      
      ////console.log('Back button check - URL:', currentURL, 'canGoBackToUrl:', canGoBackToUrlResult);
       
      // Check if we're on the first page (subdomain form, initial load, or main domain)
      const isFirstPage = currentURL.startsWith('data:text/html') || 
                         currentURL === 'about:blank' ||
                         !canGoBackToUrlResult;
       
      // Check if we're on a login page - hide back button on login pages
      const isLoginPage = currentURL.includes('/login/') || currentURL.includes('/login');
       
      // Only show back button if we can go back safely AND we're not on the first page AND not on login page
      const shouldShowBackButton = canGoBackToUrlResult && !isFirstPage && !isLoginPage;
      
      ////console.log('Back button - isFirstPage:', isFirstPage, 'isLoginPage:', isLoginPage, 'shouldShow:', shouldShowBackButton);
      ////console.log('IPC: check-can-go-back result:', shouldShowBackButton);
      
      // Return only serializable data
      const result = { canGoBack: shouldShowBackButton };
      ////console.log('IPC: check-can-go-back returning:', JSON.stringify(result));
      return result;
    }
    ////console.log('IPC: check-can-go-back - no mainWindow');
    return { canGoBack: false };
  } catch (error) {
    console.error('IPC: check-can-go-back error:', error);
    return { canGoBack: false };
  }
});

ipcMain.handle('go-back', async () => {
  ////console.log('IPC: go-back called');
  try {
    if (!mainWindow) {
      ////console.log('IPC: go-back - no mainWindow');
      return { success: false, error: 'No main window' };
    }
    
    // Implement debouncing to prevent rapid clicks
    const now = Date.now();
    if (now - lastBackClickTime < BACK_CLICK_DEBOUNCE) {
      //console.log('IPC: go-back - debounced, ignoring rapid click');
      return { success: false, error: 'Too many rapid clicks' };
    }
    lastBackClickTime = now;
    
    // Check if page is currently loading - prevent back navigation during loading
    if (mainWindow.webContents.isLoading()) {
      //console.log('IPC: go-back - page is still loading, preventing back navigation');
      return { success: false, error: 'Page is still loading' };
    }
    
    // Use our new URL-based navigation system
    const previousUrl = getPreviousUrl();
    if (!previousUrl) {
      //console.log('IPC: go-back - no safe previous URL available');
      return { success: false, error: 'Cannot go back safely' };
    }
    
    const currentURL = mainWindow.webContents.getURL();
    //console.log('IPC: go-back - navigating from:', currentURL, 'to:', previousUrl);
    
    try {
      // Navigate directly to the previous URL instead of using browser back
      await mainWindow.loadURL(previousUrl);
      
      // Update our URL stack index
      currentUrlIndex--;
      
      //console.log('IPC: go-back - navigation successful, new index:', currentUrlIndex);
      return { success: true };
      
    } catch (navigationError) {
      console.error('IPC: go-back - navigation failed:', navigationError);
      
      // Fallback: try to navigate to a safe page
      const storedDomain = store.get('customerDomain');
      const storedSubdomain = store.get('customerSubdomain');
      if (storedDomain) {
        const fallbackURL = storedDomain;
        //console.log('IPC: go-back - using fallback URL:', fallbackURL);
        await mainWindow.loadURL(fallbackURL);
      } else if (storedSubdomain) {
        const fallbackURL = `https://${storedSubdomain}.opticsify.com`;
        //console.log('IPC: go-back - using fallback URL:', fallbackURL);
        await mainWindow.loadURL(fallbackURL);
        
        // Reset URL navigation stack
        urlNavigationStack = [fallbackURL];
        currentUrlIndex = 0;
        
        return { success: true, fallback: true };
      } else {
        return { success: false, error: 'Navigation failed and no fallback available' };
      }
    }
    
  } catch (error) {
    console.error('IPC: go-back error:', error);
    return { success: false, error: error.message };
  }
});

// Get current subdomain
ipcMain.handle('get-subdomain', async () => {
  const subdomain = store.get('customerSubdomain', '');
  return subdomain;
});

ipcMain.handle('submit-subdomain', async (event, data) => {
  ////console.log('IPC: submit-subdomain called with:', data);
  
  // Support both old (string) and new (object) format
  let value, type;
  if (typeof data === 'string') {
    value = data;
    type = 'subdomain';
  } else {
    value = data.value;
    type = data.type || 'subdomain';
  }
  
  // Handle domain submission from the form
  if (value && value.trim()) {
    let fullDomain, cleanedValue, subdomain;
    
    if (type === 'custom') {
      // Custom domain - use as is (with minimal cleaning)
      cleanedValue = value.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/$/, '');
      fullDomain = `https://${cleanedValue}`;
      subdomain = cleanedValue.split('.')[0]; // Use first part as subdomain for storage
    } else {
      // Subdomain - append .opticsify.com
      cleanedValue = value.trim().toLowerCase().replace(/[^a-z0-9-]/g, '');
      fullDomain = `https://${cleanedValue}.opticsify.com`;
      subdomain = cleanedValue;
    }
    
    if (cleanedValue) {
      ////console.log('Validating domain:', fullDomain, 'type:', type);
      const isValid = type === 'custom' 
        ? await validateCustomDomain(fullDomain)
        : await validateSubdomain(subdomain);
      ////console.log('IPC: submit-subdomain validation result:', isValid);
      
      if (isValid) {
        // Get current language from global store (from landing page)
        const currentLanguage = store.get('language', 'en');
        console.log('Language from landing page:', currentLanguage);
        
        // Save domain info
        store.set('customerSubdomain', subdomain);
        store.set('customerDomain', fullDomain);
        store.set('customerDomainType', type);
        
        // Transfer language from landing page to subdomain-specific storage
        store.set(`language_${subdomain}`, currentLanguage);
        console.log('Language saved for domain', fullDomain, ':', currentLanguage);
        
        // Save to domain history
        const history = store.get('domainHistory', []);
        const displayDomain = type === 'custom' ? cleanedValue : `${cleanedValue}.opticsify.com`;
        
        // Check if domain already exists in history
        const existingIndex = history.findIndex(item => item.domain === displayDomain);
        if (existingIndex !== -1) {
          // Remove existing entry to re-add at top
          history.splice(existingIndex, 1);
        }
        
        // Add to beginning of history (most recent first)
        history.unshift({
          domain: displayDomain,
          type: type,
          timestamp: Date.now()
        });
        
        // Keep only last 20 domains
        if (history.length > 20) {
          history.splice(20);
        }
        
        store.set('domainHistory', history);
        console.log('Domain saved to history:', displayDomain);
        
        ////console.log('Domain saved:', fullDomain);
        ////console.log('IPC: submit-subdomain - stored domain');
        
        // Load the new domain in the main window
        if (mainWindow) {
          mainWindow.loadURL(fullDomain);
        }
        
        const result = { success: true, domain: fullDomain };
        ////console.log('IPC: submit-subdomain returning:', JSON.stringify(result));
        return result;
      } else {
        // Show error popup for invalid domain
        showDomainErrorDialog(type === 'custom' ? fullDomain : `${subdomain}.opticsify.com`);
        ////console.log('IPC: submit-subdomain - invalid domain');
        const result = { success: false, error: `Domain "${type === 'custom' ? cleanedValue : subdomain}" not found or not accessible` };
        ////console.log('IPC: submit-subdomain returning:', JSON.stringify(result));
        return result;
      }
    }
  }
  
  ////console.log('IPC: submit-subdomain - no valid domain provided');
  const result = { success: false, error: 'Please enter a valid domain' };
  ////console.log('IPC: submit-subdomain returning:', JSON.stringify(result));
  return result;
});

// Domain History Management Handlers
ipcMain.handle('get-domain-history', async () => {
  try {
    const history = store.get('domainHistory', []);
    return history;
  } catch (error) {
    console.error('Error getting domain history:', error);
    return [];
  }
});

ipcMain.handle('delete-domain-history', async (event, index) => {
  try {
    const history = store.get('domainHistory', []);
    
    if (index >= 0 && index < history.length) {
      history.splice(index, 1);
      store.set('domainHistory', history);
      console.log('Domain deleted from history at index:', index);
      return { success: true };
    }
    
    return { success: false, error: 'Invalid index' };
  } catch (error) {
    console.error('Error deleting domain from history:', error);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('clear-domain-history', async () => {
  try {
    store.set('domainHistory', []);
    console.log('Domain history cleared');
    return { success: true };
  } catch (error) {
    console.error('Error clearing domain history:', error);
    return { success: false, error: error.message };
  }
});

// Change Store / Logout handler
ipcMain.handle('change-store', async () => {
  try {
    console.log('Change store requested - logging out and clearing session');
    await resetSubdomain();
    return { success: true };
  } catch (error) {
    console.error('Error changing store:', error);
    return { success: false, error: error.message };
  }
});

// Login credentials handlers
ipcMain.handle('save-login-credentials', async (event, credentials) => {
  try {
    const { username, password, domain } = credentials;
    console.log('Saving login credentials for domain:', domain);
    
    // Store credentials by domain
    const credentialsKey = `login_credentials_${domain}`;
    store.set(credentialsKey, {
      username: username,
      password: password,
      savedAt: Date.now()
    });
    
    return { success: true };
  } catch (error) {
    console.error('Error saving login credentials:', error);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('get-login-credentials', async (event, domain) => {
  try {
    const credentialsKey = `login_credentials_${domain}`;
    const credentials = store.get(credentialsKey);
    
    if (credentials) {
      console.log('Retrieved login credentials for domain:', domain);
      return { 
        success: true, 
        credentials: {
          username: credentials.username,
          password: credentials.password
        }
      };
    }
    
    return { success: false, error: 'No credentials found' };
  } catch (error) {
    console.error('Error getting login credentials:', error);
    return { success: false, error: error.message };
  }
});

// POST data recovery handlers
ipcMain.handle('get-stored-post-data', async (event, url) => {
  ////console.log('Getting stored POST data for URL:', url);
  
  try {
    const allKeys = Object.keys(store.store);
    const postDataKeys = allKeys.filter(key => key.startsWith('post_data_'));
    
    // Find POST data for the specific URL
    for (const key of postDataKeys) {
      const postData = store.get(key);
      if (postData && postData.url === url) {
        ////console.log('Found stored POST data for URL:', url);
        return { success: true, postData: postData };
      }
    }
    
    ////console.log('No stored POST data found for URL:', url);
    return { success: false, message: 'No stored POST data found' };
  } catch (error) {
    console.error('Error retrieving stored POST data:', error);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('get-post-redirect-context', async (event) => {
  ////console.log('Getting POST redirect context');
  
  try {
    const redirectContext = store.get('last_post_redirect');
    
    if (redirectContext) {
      ////console.log('Found POST redirect context:', redirectContext);
      
      // Check if the context is recent (within last 2 minutes)
      const twoMinutesAgo = Date.now() - (2 * 60 * 1000);
      if (redirectContext.timestamp > twoMinutesAgo) {
        return { success: true, context: redirectContext };
      } else {
        ////console.log('POST redirect context is too old, clearing it');
        store.delete('last_post_redirect');
        return { success: false, message: 'Redirect context expired' };
      }
    }
    
    ////console.log('No POST redirect context found');
    return { success: false, message: 'No redirect context found' };
  } catch (error) {
    console.error('Error retrieving POST redirect context:', error);
    return { success: false, error: error.message };
  }
});

// Auto-updater configuration
autoUpdater.autoDownload = false;
autoUpdater.autoInstallOnAppQuit = false;

// Store update info globally
let latestUpdateInfo = null;

// Set the update config path to the unpacked location
// Force update config even in development for testing
const updateConfigPath = path.join(__dirname, 'app-update.yml');
if (fs.existsSync(updateConfigPath)) {
  autoUpdater.updateConfigPath = updateConfigPath;
}

// Force development updates for testing
if (isDevelopment) {
  autoUpdater.forceDevUpdateConfig = true;
}

// Auto-updater event handlers
autoUpdater.on('checking-for-update', () => {
  //console.log('Checking for update...');
  if (mainWindow) {
    mainWindow.webContents.send('checking-for-update');
  }
});

autoUpdater.on('update-available', (info) => {
  console.log('Update available:', info);
  // Store update info for later use
  latestUpdateInfo = info;
  if (mainWindow) {
    mainWindow.webContents.send('update-available', info);
  }
});

autoUpdater.on('update-not-available', (info) => {
  console.log('No update available. Current version:', app.getVersion());
  // Clear any stored update info
  latestUpdateInfo = null;
  if (mainWindow) {
    mainWindow.webContents.send('update-not-available', info);
  }
});

autoUpdater.on('error', (err) => {
  //console.log('Error in auto-updater:', err);
  if (mainWindow) {
    mainWindow.webContents.send('update-error', err);
  }
});

autoUpdater.on('download-progress', (progressObj) => {
  let log_message = "Download speed: " + progressObj.bytesPerSecond;
  log_message = log_message + ' - Downloaded ' + progressObj.percent + '%';
  log_message = log_message + ' (' + progressObj.transferred + "/" + progressObj.total + ')';
  //console.log(log_message);
  
  // Send progress to renderer
  if (mainWindow) {
    mainWindow.webContents.send('update-download-progress', progressObj);
  }
});

autoUpdater.on('update-downloaded', (info) => {
  //console.log('Update downloaded:', info);
  if (mainWindow) {
    mainWindow.webContents.send('update-downloaded', info);
  }
});

// Auto-updater IPC handlers
ipcMain.handle('check-for-updates', async () => {
  try {
    // Force development mode to work
    if (isDevelopment) {
      // Simulate update not available to trigger our fake update
      setTimeout(() => {
        if (mainWindow) {
          mainWindow.webContents.send('update-not-available');
        }
      }, 1000);
      return { message: 'Checking for updates in development mode...' };
    }
    
    const result = await autoUpdater.checkForUpdates();
    return result;
  } catch (error) {
    console.error('Error checking for updates:', error);
    throw error;
  }
});

ipcMain.handle('download-update', async () => {
  try {
    // Check if we have update info
    if (!latestUpdateInfo || !latestUpdateInfo.version) {
      throw new Error('No update information available. Please check for updates first.');
    }
    
    // Get platform and architecture info
    const platform = process.platform;
    const arch = process.arch;
    const currentVersion = app.getVersion();
    const newVersion = latestUpdateInfo.version; // Get version from update info
    
    console.log('=== Download Update ===');
    console.log(`Current Version: ${currentVersion}`);
    console.log(`New Version: ${newVersion}`);
    console.log(`Platform: ${platform}, Architecture: ${arch}`);
    
    let downloadUrl = '';
    let fileName = '';
    
    // Determine download URL based on platform and architecture
    if (platform === 'darwin') { // macOS - Download DMG
      if (arch === 'arm64') {
        // Apple Silicon (M1/M2/M3) Macs
        fileName = `opticsify-Desktop-${newVersion}-arm64-mac.dmg`;
      } else if (arch === 'x64') {
        // Intel Macs
        fileName = `opticsify-Desktop-${newVersion}-mac.dmg`;
      } else {
        // Fallback for other architectures
        fileName = `opticsify-Desktop-${newVersion}-arm64-mac.dmg`;
      }
    } else if (platform === 'win32') { // Windows
      if (arch === 'x64') {
        fileName = `opticsify-Desktop-Setup-${newVersion}-x64.exe`;
      } else {
        fileName = `opticsify-Desktop-Setup-${newVersion}-ia32.exe`;
      }
    } else if (platform === 'linux') { // Linux
      fileName = `opticsify-Desktop-${newVersion}.AppImage`;
    }
    
    downloadUrl = `https://s3.me-south-1.amazonaws.com/opticsify/disktop/apps/releases/${fileName}`;
    
    console.log(`Selected file: ${fileName}`);
    console.log(`Download URL: ${downloadUrl}`);
    
    // Get the Downloads folder path
    const downloadsPath = app.getPath('downloads');
    const filePath = path.join(downloadsPath, fileName);
    
    console.log(`Save path: ${filePath}`);
    
    // Download the file directly with redirect handling
    return new Promise((resolve, reject) => {
      const https = require('https');
      let fileStream = null;
      
      const downloadFile = (url, redirectCount = 0) => {
        if (redirectCount > 5) {
          reject(new Error('Too many redirects'));
          return;
        }
        
        console.log(`Downloading from: ${url} (redirect #${redirectCount})`);
        
        const request = https.get(url, { timeout: 30000 }, (response) => {
          console.log(`Response status: ${response.statusCode}`);
          
          // Handle redirects
          if (response.statusCode === 301 || response.statusCode === 302 || 
              response.statusCode === 307 || response.statusCode === 308) {
            const redirectUrl = response.headers.location;
            console.log(`Redirecting to: ${redirectUrl}`);
            downloadFile(redirectUrl, redirectCount + 1);
            return;
          }
          
          // Check for errors
          if (response.statusCode !== 200) {
            if (fileStream) {
              fileStream.close();
              fs.unlink(filePath, () => {});
            }
            reject(new Error(`Failed to download: HTTP ${response.statusCode}`));
            return;
          }
          
          const totalBytes = parseInt(response.headers['content-length'] || '0', 10);
          let downloadedBytes = 0;
          let lastProgressTime = Date.now();
          let lastLoggedPercent = 0;
          
          console.log(`Starting download: ${(totalBytes / 1024 / 1024).toFixed(2)} MB`);
          
          // Create write stream
          fileStream = fs.createWriteStream(filePath);
          
          // Don't use response.on('data') with pipe - they conflict!
          // Instead, monitor the write stream
          fileStream.on('pipe', () => {
            console.log('Pipe started');
          });
          
          // Track progress using intervals instead of data events
          const progressInterval = setInterval(() => {
            if (fileStream.bytesWritten) {
              downloadedBytes = fileStream.bytesWritten;
              const percent = totalBytes > 0 ? (downloadedBytes / totalBytes) * 100 : 0;
              
              // Send progress update to renderer
              if (mainWindow) {
                mainWindow.webContents.send('download-progress', {
                  percent: percent,
                  transferred: downloadedBytes,
                  total: totalBytes
                });
              }
              
              // Log progress every 10%
              if (Math.floor(percent / 10) > Math.floor(lastLoggedPercent / 10) || percent >= 99.9) {
                console.log(`Download progress: ${percent.toFixed(1)}% (${(downloadedBytes / 1024 / 1024).toFixed(2)} MB / ${(totalBytes / 1024 / 1024).toFixed(2)} MB)`);
                lastLoggedPercent = percent;
              }
            }
          }, 100);
          
          response.pipe(fileStream);
          
          fileStream.on('finish', () => {
            clearInterval(progressInterval);
            fileStream.close();
            console.log(`✅ Download completed: ${filePath}`);
            
            // Send final 100% progress
            if (mainWindow) {
              mainWindow.webContents.send('download-progress', {
                percent: 100,
                transferred: totalBytes,
                total: totalBytes
              });
            }
            
            resolve({ 
              success: true, 
              downloadUrl: downloadUrl,
              fileName: fileName,
              filePath: filePath,
              message: 'Download completed'
            });
          });
          
          fileStream.on('error', (err) => {
            clearInterval(progressInterval);
            console.error('File stream error:', err);
            fs.unlink(filePath, () => {});
            reject(err);
          });
        });
        
        request.on('error', (err) => {
          console.error('Request error:', err);
          if (fileStream) {
            fileStream.close();
            fs.unlink(filePath, () => {});
          }
          reject(err);
        });
        
        request.on('timeout', () => {
          console.error('Request timeout');
          request.destroy();
          if (fileStream) {
            fileStream.close();
            fs.unlink(filePath, () => {});
          }
          reject(new Error('Download timeout (30s)'));
        });
      };
      
      downloadFile(downloadUrl);
    });
  } catch (error) {
    console.error('Error initiating download:', error);
    throw error;
  }
});

ipcMain.handle('install-update', async () => {
  autoUpdater.quitAndInstall();
});

ipcMain.handle('open-installer', async (event, filePath) => {
  try {
    if (!filePath || !fs.existsSync(filePath)) {
      throw new Error('Installer file not found');
    }
    
    // Open the installer file
    shell.openPath(filePath);
    
    return { success: true, message: 'Installer opened' };
  } catch (error) {
    console.error('Error opening installer:', error);
    throw error;
  }
});

ipcMain.handle('get-app-version', async () => {
  return app.getVersion();
});

ipcMain.handle('reset-subdomain', async () => {
  await resetSubdomain();
});

// Validate subdomain by checking if the domain exists
async function validateSubdomain(subdomain) {
  return new Promise((resolve) => {
    const https = require('https');
    const url = `https://${subdomain}.opticsify.com`;
    
    ////console.log('Checking domain availability:', url);
    
    const request = https.get(url, { timeout: 5000 }, (response) => {
      ////console.log('Domain check response status:', response.statusCode);
      // If we get any response (even 404), the domain exists
      resolve(true);
    });
    
    request.on('error', (error) => {
      ////console.log('Domain check error:', error.code);
      // If it's a DNS resolution error, the domain doesn't exist
      if (error.code === 'ENOTFOUND' || error.code === 'ECONNREFUSED') {
        resolve(false);
      } else {
        // For other errors (timeout, etc.), assume domain exists to be safe
        resolve(true);
      }
    });
    
    request.on('timeout', () => {
      ////console.log('Domain check timeout');
      request.destroy();
      // On timeout, assume domain exists to be safe
      resolve(true);
    });
  });
}

// Validate custom domain by checking if the domain exists
async function validateCustomDomain(domain) {
  return new Promise((resolve) => {
    const https = require('https');
    
    ////console.log('Checking custom domain availability:', domain);
    
    const request = https.get(domain, { timeout: 5000 }, (response) => {
      ////console.log('Custom domain check response status:', response.statusCode);
      // If we get any response (even 404), the domain exists
      resolve(true);
    });
    
    request.on('error', (error) => {
      ////console.log('Custom domain check error:', error.code);
      // If it's a DNS resolution error, the domain doesn't exist
      if (error.code === 'ENOTFOUND' || error.code === 'ECONNREFUSED') {
        resolve(false);
      } else {
        // For other errors (timeout, etc.), assume domain exists to be safe
        resolve(true);
      }
    });
    
    request.on('timeout', () => {
      ////console.log('Custom domain check timeout');
      request.destroy();
      // On timeout, assume domain exists to be safe
      resolve(true);
    });
  });
}

// Show error dialog for invalid domain
async function showDomainErrorDialog(domain) {
  if (!mainWindow) return;
  
  // Get the current language from the store
  const currentLanguage = store.get('language', 'en');
  
  // Define translations for the error dialog
  const translations = {
    en: {
      title: 'Invalid Domain',
      text: `The domain "${domain}" does not exist or is not accessible. Please check the domain and try again.`,
      confirmButtonText: 'OK'
    },
    ar: {
      title: 'نطاق غير صالح',
      text: `النطاق "${domain}" غير موجود أو غير قابل للوصول. يرجى التحقق من النطاق والمحاولة مرة أخرى.`,
      confirmButtonText: 'موافق'
    }
  };

  const t = translations[currentLanguage] || translations.en;
  
  try {
    await showSweetAlert({
      icon: 'error',
      title: t.title,
      text: t.text,
      confirmButtonText: t.confirmButtonText,
      confirmButtonColor: '#3B82F6',
      background: '#fff',
      customClass: {
        popup: 'swal-rtl-' + currentLanguage
      }
    });
    
    // After user clicks OK, focus back on the form
    if (mainWindow) {
      mainWindow.focus();
    }
  } catch (error) {
    console.error('Error showing domain error dialog:', error);
  }
}

// Legacy function for backward compatibility
async function showSubdomainErrorDialog(subdomain) {
  return showDomainErrorDialog(`${subdomain}.opticsify.com`);
}

 async function showSimpleInputDialog(message, defaultValue = '') {
   return new Promise((resolve) => {
     const inputWindow = new BrowserWindow({
       width: 450,
       height: 250,
       modal: true,
       parent: mainWindow,
       webPreferences: {
         nodeIntegration: false,
         contextIsolation: true,
         preload: path.join(__dirname, 'preload.js')
       },
       resizable: false,
       minimizable: false,
       maximizable: false,
       icon: path.join(__dirname, 'assets', 'icon.png')
     });

     const html = `
       <!DOCTYPE html>
       <html>
       <head>
         <style>
           body { 
             font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; 
             padding: 20px; 
             margin: 0; 
             background: #f5f5f5;
           }
           .container { 
             display: flex; 
             flex-direction: column; 
             gap: 20px; 
             background: white;
             padding: 25px;
             border-radius: 8px;
             box-shadow: 0 2px 10px rgba(0,0,0,0.1);
           }
           .logo {
             text-align: center;
             margin-bottom: 10px;
           }
           .logo img {
             width: 60px;
             height: 60px;
           }
           .title {
             font-size: 18px;
             font-weight: 600;
             color: #333;
             text-align: center;
             margin-bottom: 5px;
           }
           .subtitle {
             font-size: 14px;
             color: #666;
             text-align: center;
             margin-bottom: 15px;
           }
           .input-group {
             display: flex;
             align-items: center;
             gap: 5px;
           }
           .prefix {
             font-size: 14px;
             color: #666;
             font-weight: 500;
           }
           input { 
             flex: 1;
             padding: 10px 12px; 
             font-size: 14px; 
             border: 2px solid #e1e5e9; 
             border-radius: 6px;
             outline: none;
             transition: border-color 0.2s;
           }
           input:focus {
             border-color: #007acc;
           }
           .suffix {
             font-size: 14px;
             color: #666;
             font-weight: 500;
           }
           .buttons { 
             display: flex; 
             gap: 12px; 
             justify-content: flex-end; 
             margin-top: 10px;
           }
           button { 
             padding: 10px 20px; 
             border: none; 
             border-radius: 6px; 
             cursor: pointer;
             font-size: 14px;
             font-weight: 500;
             font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
             transition: all 0.2s;
           }
           .ok { 
             background: linear-gradient(135deg, #3B82F6 0%, #8B5CF6 100%);
             color: white; 
           }
           .ok:hover {
             background: linear-gradient(135deg, #2563EB 0%, #7C3AED 100%);
           }
           .cancel { 
             background: #F3F4F6; 
             color: #6B7280;
           }
           .cancel:hover {
             background: #E5E7EB;
             color: #4B5563;
           }
         </style>
       </head>
       <body>
         <div class="container">
           <div class="logo">
             <img src="" alt="opticsify" id="logo">
           </div>
           <div class="title">Opticsify Desktop</div>
           <div class="subtitle">${message}</div>
           <div class="input-group">
             <span class="prefix">https://</span>
             <input type="text" id="input" value="${defaultValue}" placeholder="mystore" autofocus>
             <span class="suffix">.opticsify.com</span>
           </div>
           <div class="buttons">
             <button class="cancel" onclick="window.close()">Cancel</button>
             <button class="ok" onclick="submit()">Connect</button>
           </div>
         </div>
         <script>
           // Create a unique IPC channel for this dialog
           const dialogId = 'simple-input-' + Date.now();
           
           // Load logo dynamically
           async function loadLogo() {
             try {
               if (window.electronAPI && window.electronAPI.getLogo) {
                 const logoData = await window.electronAPI.getLogo();
                 if (logoData) {
                   const logoImg = document.getElementById('logo');
                   if (logoImg) {
                     logoImg.src = logoData;
                     ////console.log('Logo loaded successfully in dialog');
                   }
                 }
               }
             } catch (error) {
               console.error('Error loading logo in dialog:', error);
             }
           }
           
           // Load logo when page is ready
           document.addEventListener('DOMContentLoaded', loadLogo);
           
           function submit() {
             const value = document.getElementById('input').value.trim();
             if (value) {
               // Send result directly to main process using a unique channel
               if (window.electronAPI && window.electronAPI.sendMessage) {
                 window.electronAPI.sendMessage(dialogId, value);
               } else {
                 console.error('electronAPI not available');
               }
               window.close();
             } else {
               document.getElementById('input').focus();
             }
           }
           
           function cancel() {
             if (window.electronAPI && window.electronAPI.sendMessage) {
               window.electronAPI.sendMessage(dialogId, null);
             }
             window.close();
           }
           
           document.getElementById('input').addEventListener('keypress', (e) => {
             if (e.key === 'Enter') submit();
             if (e.key === 'Escape') cancel();
           });
           
           // Expose the dialog ID to the main process
           window.dialogId = dialogId;
         </script>
       </body>
       </html>
     `;

     inputWindow.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
     
     // Create a unique IPC handler for this dialog
     const dialogId = 'simple-input-' + Date.now();
     const { ipcMain } = require('electron');
     
     const handleResult = async (event, channelId, value) => {
       ////console.log('IPC: dialog-message called with channelId:', channelId, 'value:', value);
       try {
         if (channelId === dialogId) {
           ////console.log('IPC: dialog-message - matching channelId, resolving');
           resolve(value);
           ipcMain.removeHandler('dialog-message');
           if (!inputWindow.isDestroyed()) {
             inputWindow.close();
           }
           // Return only serializable data
           const result = { success: true, value: value };
           ////console.log('IPC: dialog-message returning:', JSON.stringify(result));
           return result;
         }
         ////console.log('IPC: dialog-message - non-matching channelId');
         const result = { success: false, value: null };
         ////console.log('IPC: dialog-message returning:', JSON.stringify(result));
         return result;
       } catch (error) {
         console.error('IPC: dialog-message error:', error);
         return { success: false, error: error.message };
       }
     };
     
     ipcMain.handle('dialog-message', handleResult);

     inputWindow.on('closed', () => {
       try {
         ipcMain.removeHandler('dialog-message');
         resolve(null);
       } catch (error) {
         console.error('Error cleaning up dialog handler:', error);
         resolve(null);
       }
     });
     
     // Pass the dialog ID to the window after it loads
     inputWindow.webContents.once('did-finish-load', () => {
       inputWindow.webContents.executeJavaScript(`window.dialogId = '${dialogId}';`);
     });
   });
 }

// Function to show domain change dialog
async function showDomainDialog() {
  try {
    const currentSubdomain = store.get('customerSubdomain', '');
    const newSubdomain = await showSimpleInputDialog('Enter your store subdomain:', currentSubdomain);
    
    if (newSubdomain && newSubdomain.trim()) {
      const subdomain = newSubdomain.trim().toLowerCase();
      // Clean subdomain - remove any protocol or domain parts if user entered full URL
      const cleanSubdomain = subdomain.replace(/^https?:\/\//, '').replace(/\.opticsify\.com.*$/, '').replace(/\/$/, '');
      
      // Validate subdomain before saving
      const isValid = await validateSubdomain(cleanSubdomain);
      if (isValid) {
        const fullDomain = `https://${cleanSubdomain}.opticsify.com`;
        
        store.set('customerSubdomain', cleanSubdomain);
        ////console.log('Subdomain updated to:', cleanSubdomain);
        ////console.log('Full domain:', fullDomain);
        
        // Reload the main window with new domain
        if (mainWindow) {
          mainWindow.loadURL(fullDomain);
        }
      } else {
        showSubdomainErrorDialog(cleanSubdomain);
      }
    }
  } catch (error) {
    console.error('Error in domain dialog:', error);
  }
}

// Reset subdomain and show setup form again
async function resetSubdomain() {
  try {
    if (!mainWindow) {
      console.error('Main window not available for reset subdomain');
      return;
    }

    // Get the current language from the store
    const currentLanguage = store.get('language', 'en');
    
    // Define translations for the reset confirmation dialog
    const translations = {
      en: {
        title: 'Change Store / Logout',
        message: 'Are you sure you want to change your store?',
        detail: 'This will log you out and clear your current session. You can then connect to a different store.',
        resetButton: 'Logout & Change Store',
        cancelButton: 'Cancel',
        errorTitle: 'Logout Error',
        errorMessage: 'Failed to logout. Please try again.'
      },
      ar: {
        title: 'تغيير المتجر / تسجيل الخروج',
        message: 'هل أنت متأكد من أنك تريد تغيير متجرك؟',
        detail: 'سيؤدي هذا إلى تسجيل خروجك ومسح الجلسة الحالية. يمكنك بعد ذلك الاتصال بمتجر آخر.',
        resetButton: 'تسجيل الخروج وتغيير المتجر',
        cancelButton: 'إلغاء',
        errorTitle: 'خطأ في تسجيل الخروج',
        errorMessage: 'فشل في تسجيل الخروج. يرجى المحاولة مرة أخرى.'
      }
    };
    
    const t = translations[currentLanguage] || translations.en;

    const result = await showSweetAlert({
      icon: 'question',
      title: t.title,
      text: t.message + '\n\n' + t.detail,
      showCancelButton: true,
      confirmButtonText: t.resetButton,
      cancelButtonText: t.cancelButton,
      confirmButtonColor: '#EF4444',
      cancelButtonColor: '#6B7280'
    });

    if (result && result.isConfirmed) { // Reset button clicked
      // Clear stored subdomain and domain
      store.delete('customerSubdomain');
      store.delete('customerDomain');
      store.delete('customerDomainType');
      console.log('Store information cleared');
      
      // Clear session data (cookies, storage, cache)
      const { session } = require('electron');
      const opticsifySession = session.fromPartition('persist:opticsify-session');
      
      try {
        // Clear all cookies from session
        const cookies = await opticsifySession.cookies.get({});
        console.log(`Clearing ${cookies.length} cookies...`);
        for (const cookie of cookies) {
          const url = `http${cookie.secure ? 's' : ''}://${cookie.domain}${cookie.path}`;
          await opticsifySession.cookies.remove(url, cookie.name);
        }
        console.log('Session cookies cleared');
        
        // Clear all storage data (localStorage, sessionStorage, indexedDB, etc.)
        await opticsifySession.clearStorageData({
          storages: ['appcache', 'cookies', 'filesystem', 'indexdb', 'localstorage', 'shadercache', 'websql', 'serviceworkers', 'cachestorage']
        });
        console.log('Session storage cleared');
        
        // Clear cache
        await opticsifySession.clearCache();
        console.log('Session cache cleared');
        
        // Also clear webContents session
        if (mainWindow && mainWindow.webContents) {
          const webSession = mainWindow.webContents.session;
          await webSession.clearStorageData({
            storages: ['appcache', 'cookies', 'filesystem', 'indexdb', 'localstorage', 'shadercache', 'websql', 'serviceworkers', 'cachestorage']
          });
          await webSession.clearCache();
          console.log('WebContents session cleared');
          
          // Also clear storage via JavaScript execution for extra thoroughness
          try {
            await mainWindow.webContents.executeJavaScript(`
              // Clear all localStorage keys including subdomain-prefixed ones
              const keysToRemove = [];
              for (let i = 0; i < localStorage.length; i++) {
                const key = localStorage.key(i);
                keysToRemove.push(key);
              }
              keysToRemove.forEach(key => localStorage.removeItem(key));
              
              localStorage.clear();
              sessionStorage.clear();
              console.log('localStorage and sessionStorage cleared via JavaScript (including all prefixed keys)');
            `);
          } catch (jsError) {
            console.error('Error clearing storage via JavaScript:', jsError);
          }
        }
      } catch (sessionError) {
        console.error('Error clearing session:', sessionError);
      }
      
      // Wait a bit to ensure all clearing is complete
      await new Promise(resolve => setTimeout(resolve, 500));
      
      // Show the subdomain form in the main window
      const newDomain = await showSubdomainFormInMainWindow();
      
      // Load the new domain
      if (mainWindow && newDomain) {
        //console.log('Loading new domain:', newDomain);
        await mainWindow.loadURL(newDomain);
      } else {
        console.error('Failed to get new domain or main window not available');
      }
    }
  } catch (error) {
    console.error('Error in reset subdomain:', error);
    // Show error dialog to user with localized message
    if (mainWindow) {
      const currentLanguage = store.get('language', 'en');
      const translations = {
        en: {
          errorTitle: 'Reset Error',
          errorMessage: 'Failed to reset subdomain. Please try again.',
          confirmButtonText: 'OK'
        },
        ar: {
          errorTitle: 'خطأ في إعادة التعيين',
          errorMessage: 'فشل في إعادة تعيين النطاق الفرعي. يرجى المحاولة مرة أخرى.',
          confirmButtonText: 'موافق'
        }
      };
      const t = translations[currentLanguage] || translations.en;
      showSweetAlert({
        icon: 'error',
        title: t.errorTitle,
        text: t.errorMessage,
        confirmButtonText: t.confirmButtonText,
        confirmButtonColor: '#EF4444'
      }).catch(err => console.error('Error showing alert:', err));
    }
  }
}

// Create system tray
function createTray() {
  if (tray) return; // Tray already exists
  
  const iconPath = path.join(__dirname, 'assets', 'tray-icon.png');
  const trayIcon = nativeImage.createFromPath(iconPath);
  
  // Resize icon for tray (different sizes for different platforms)
  const resizedIcon = process.platform === 'darwin' 
    ? trayIcon.resize({ width: 18, height: 18 })
    : trayIcon.resize({ width: 32, height: 32 });
  
  // Set as template image for macOS (will automatically adapt to light/dark mode)
  if (process.platform === 'darwin') {
    resizedIcon.setTemplateImage(true);
  }
  
  tray = new Tray(resizedIcon);
  
  const contextMenu = Menu.buildFromTemplate([
    {
      label: 'Show Opticsify',
      click: () => {
        if (mainWindow) {
          mainWindow.show();
          mainWindow.maximize();
          mainWindow.focus();
        }
      }
    },
    {
      label: 'Quit',
      click: () => {
        // Set a flag to actually quit
        app.isQuitting = true;
        app.quit();
      }
    }
  ]);
  
  tray.setToolTip('Opticsify Desktop');
  tray.setContextMenu(contextMenu);
  
  // Show window on tray icon click (Windows/Linux)
  tray.on('click', () => {
    if (mainWindow) {
      mainWindow.show();
      mainWindow.maximize();
      mainWindow.focus();
    }
  });
}

function createWindow() {
  //console.log('createWindow() called - environment:', process.env.NODE_ENV);
  
  // Get the primary display dimensions
  const { screen } = require('electron');
  const primaryDisplay = screen.getPrimaryDisplay();
  const { width, height } = primaryDisplay.workAreaSize;
  
  // Create the browser window with session persistence
  mainWindow = new BrowserWindow({
    width: width,
    height: height,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      enableRemoteModule: false,
      webSecurity: false, // Disable web security for better session persistence
      allowRunningInsecureContent: true,
      experimentalFeatures: false,
      preload: path.join(__dirname, 'preload.js'),
      // Enable session persistence
      partition: 'persist:opticsify-session',
      // Enable autofill and password saving
      spellcheck: true,
      // Additional settings for better credential storage
      backgroundThrottling: false,
      offscreen: false
    },
    icon: path.join(__dirname, 'assets', 'icon.png'),
    show: false, // Don't show until ready
    titleBarStyle: 'default'
  });
  
  // Maximize window to fill the screen (but not fullscreen mode)
  mainWindow.maximize();
  
  // Increase max listeners to prevent warnings for our legitimate event handlers
  mainWindow.webContents.setMaxListeners(20);
  
  // Allow camera/media and clipboard; deny everything else
  mainWindow.webContents.session.setPermissionCheckHandler((webContents, permission) => {
    const allowed = ['media', 'microphone', 'camera', 'clipboard-read', 'clipboard-sanitized-write'];
    return allowed.includes(permission);
  });

  mainWindow.webContents.session.setPermissionRequestHandler((webContents, permission, callback) => {
    const allowed = ['media', 'mediaKeySystem', 'clipboard-read', 'clipboard-sanitized-write'];
    callback(allowed.includes(permission));
  });

  //console.log('mainWindow created, preload path:', path.join(__dirname, 'preload.js'));

  // Load the web application
  // Get domain from storage or prompt user
  getDomain().then(appUrl => {
    //console.log('getDomain resolved with URL:', appUrl);
    if (mainWindow) {
      mainWindow.loadURL(appUrl);
    }
  }).catch(err => {
    console.error('Error loading domain:', err);
    if (mainWindow) {
      mainWindow.loadURL('https://opticsify.com');
    }
  });

  // Show window when ready to prevent visual flash
  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
    
    // Focus on window
    if (process.platform === 'darwin') {
      app.dock.show();
    }
  });

  // Handle window close - minimize to tray instead of quitting
  mainWindow.on('close', (event) => {
    if (!app.isQuitting) {
      event.preventDefault();
      mainWindow.hide();
      
      // Hide dock icon on macOS when window is hidden
      if (process.platform === 'darwin') {
        app.dock.hide();
      }
      
      return false;
    }
  });

  // Set zoom level for Windows after DOM is ready to prevent layout issues
  mainWindow.webContents.once('dom-ready', () => {
    // Inject autofill enablement script for all platforms
    mainWindow.webContents.executeJavaScript(`
      // Enhanced autofill with visual dropdown like Chrome
      function enableAutofillWithVisualDropdown() {
        // Create CSS for the autofill dropdown
        if (!document.getElementById('opticsify-autofill-styles')) {
          const style = document.createElement('style');
          style.id = 'opticsify-autofill-styles';
          style.textContent = \`
            .opticsify-autofill-dropdown {
              position: absolute;
              background: #fff;
              border: 1px solid #ccc;
              border-radius: 4px;
              box-shadow: 0 2px 8px rgba(0,0,0,0.15);
              z-index: 10000;
              max-height: 200px;
              overflow-y: auto;
              font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
              font-size: 14px;
            }
            .opticsify-autofill-item {
              padding: 8px 12px;
              cursor: pointer;
              border-bottom: 1px solid #f0f0f0;
              display: flex;
              align-items: center;
              gap: 8px;
            }
            .opticsify-autofill-item:hover {
              background: #f5f5f5;
            }
            .opticsify-autofill-item:last-child {
              border-bottom: none;
            }
            .opticsify-autofill-icon {
              width: 16px;
              height: 16px;
              background: #4285f4;
              border-radius: 50%;
              display: flex;
              align-items: center;
              justify-content: center;
              color: white;
              font-size: 10px;
              font-weight: bold;
            }
            .opticsify-autofill-text {
              flex: 1;
            }
            .opticsify-autofill-domain {
              font-size: 12px;
              color: #666;
            }
          \`;
          document.head.appendChild(style);
        }

        // Get stored credentials for current subdomain only
        function getAllStoredCredentials() {
          const credentials = [];
          const domain = window.location.hostname; // Use exact subdomain
          
          // Only get credentials for the exact current subdomain
          const storageKey = 'opticsify_credentials_' + domain;
          const stored = localStorage.getItem(storageKey) || sessionStorage.getItem(storageKey);
          if (stored) {
            try {
              const cred = JSON.parse(stored);
              if (cred.username) {
                credentials.push({
                  username: cred.username,
                  domain: domain,
                  usernameField: cred.usernameField
                });
              }
            } catch (e) {}
          }
          
          return credentials;
        }

        // Create and show dropdown
        function showAutofillDropdown(input) {
          console.log('showAutofillDropdown called for input:', input);
          
          // Remove existing dropdown
          const existingDropdown = document.querySelector('.opticsify-autofill-dropdown');
          if (existingDropdown) {
            existingDropdown.remove();
          }

          const credentials = getAllStoredCredentials();
          console.log('Found credentials:', credentials);
          if (credentials.length === 0) {
            console.log('No credentials found, not showing dropdown');
            return;
          }

          const dropdown = document.createElement('div');
          dropdown.className = 'opticsify-autofill-dropdown';
          
          // Position dropdown
          const rect = input.getBoundingClientRect();
          dropdown.style.left = rect.left + 'px';
          dropdown.style.top = (rect.bottom + window.scrollY) + 'px';
          dropdown.style.width = Math.max(rect.width, 200) + 'px';

          // Add credentials to dropdown
          credentials.forEach(cred => {
            const item = document.createElement('div');
            item.className = 'opticsify-autofill-item';
            
            const icon = document.createElement('div');
            icon.className = 'opticsify-autofill-icon';
            icon.textContent = cred.username.charAt(0).toUpperCase();
            
            const textContainer = document.createElement('div');
            textContainer.className = 'opticsify-autofill-text';
            
            const username = document.createElement('div');
            username.textContent = cred.username;
            
            const domain = document.createElement('div');
            domain.className = 'opticsify-autofill-domain';
            domain.textContent = cred.domain;
            
            textContainer.appendChild(username);
            textContainer.appendChild(domain);
            
            item.appendChild(icon);
            item.appendChild(textContainer);
            
            // Click handler
            item.addEventListener('click', () => {
              input.value = cred.username;
              input.dispatchEvent(new Event('input', { bubbles: true }));
              input.dispatchEvent(new Event('change', { bubbles: true }));
              dropdown.remove();
              
              // Auto-fill password if available
              if (cred.password) {
                const form = input.closest('form');
                if (form) {
                  const passwordInput = form.querySelector('input[type="password"]');
                  if (passwordInput) {
                    passwordInput.value = cred.password;
                    passwordInput.dispatchEvent(new Event('input', { bubbles: true }));
                    passwordInput.dispatchEvent(new Event('change', { bubbles: true }));
                  }
                }
              }
              
              // Focus next input (usually password) if password wasn't auto-filled
              if (!cred.password) {
                const form = input.closest('form');
                if (form) {
                  const inputs = form.querySelectorAll('input');
                  const currentIndex = Array.from(inputs).indexOf(input);
                  if (currentIndex >= 0 && currentIndex < inputs.length - 1) {
                    inputs[currentIndex + 1].focus();
                  }
                }
              }
            });
            
            dropdown.appendChild(item);
          });

          document.body.appendChild(dropdown);

          // Close dropdown when clicking outside
          setTimeout(() => {
            document.addEventListener('click', function closeDropdown(e) {
              if (!dropdown.contains(e.target) && e.target !== input) {
                dropdown.remove();
                document.removeEventListener('click', closeDropdown);
              }
            });
          }, 100);
        }

        // Enable autofill attributes on form inputs
        document.querySelectorAll('input[type="password"], input[type="email"], input[type="text"], input[name*="user"], input[name*="login"], input[name*="email"]').forEach(input => {
          if (!input.getAttribute('autocomplete')) {
            if (input.type === 'password') {
              input.setAttribute('autocomplete', 'current-password');
            } else if (input.type === 'email' || input.name.toLowerCase().includes('email')) {
              input.setAttribute('autocomplete', 'email');
            } else if (input.name && (input.name.toLowerCase().includes('user') || input.name.toLowerCase().includes('login'))) {
              input.setAttribute('autocomplete', 'username');
            }
          }

          // Add dropdown functionality to username/email fields
          if (input.type !== 'password' && !input.hasAttribute('data-autofill-enhanced')) {
            console.log('Adding autofill dropdown to input:', input);
            input.setAttribute('data-autofill-enhanced', 'true');
            
            // Show dropdown on focus
            input.addEventListener('focus', () => {
              console.log('Input focused, showing dropdown');
              showAutofillDropdown(input);
            });
            
            // Show dropdown on click
            input.addEventListener('click', () => {
              console.log('Input clicked, showing dropdown');
              showAutofillDropdown(input);
            });
            
            // Hide dropdown on blur (with delay to allow clicking)
            input.addEventListener('blur', () => {
              setTimeout(() => {
                const dropdown = document.querySelector('.opticsify-autofill-dropdown');
                if (dropdown && !dropdown.matches(':hover')) {
                  dropdown.remove();
                }
              }, 150);
            });
          }
        });
        
        // Enable form autocomplete and add persistence
        document.querySelectorAll('form').forEach(form => {
          if (!form.getAttribute('autocomplete')) {
            form.setAttribute('autocomplete', 'on');
          }
          
          // Add form submission handler for credential persistence
          if (!form.hasAttribute('data-persistence-added')) {
            form.setAttribute('data-persistence-added', 'true');
            form.addEventListener('submit', function(e) {
              try {
                const formData = new FormData(this);
                const credentials = {};
                
                // Capture username/email fields
                this.querySelectorAll('input[type="email"], input[type="text"], input[name*="user"], input[name*="login"], input[name*="email"]').forEach(input => {
                  if (input.value && input.value.trim()) {
                    credentials.username = input.value.trim();
                    credentials.usernameField = input.name || input.id;
                  }
                });
                
                // Capture password fields
                this.querySelectorAll('input[type="password"]').forEach(input => {
                  if (input.value && input.value.trim()) {
                    credentials.password = input.value.trim();
                    credentials.passwordField = input.name || input.id;
                  }
                });
                
                // Store credentials in both localStorage and sessionStorage for persistence
                if (credentials.username) {
                  const domain = window.location.hostname;
                  const storageKey = 'opticsify_credentials_' + domain;
                  
                  const credentialData = {
                    username: credentials.username,
                    usernameField: credentials.usernameField,
                    password: credentials.password || '',
                    passwordField: credentials.passwordField || '',
                    timestamp: Date.now(),
                    url: window.location.href
                  };
                  
                  localStorage.setItem(storageKey, JSON.stringify(credentialData));
                  sessionStorage.setItem(storageKey, JSON.stringify(credentialData));
                }
              } catch (err) {
                console.log('Error saving credentials:', err);
              }
            });
          }
        });
        
        // Auto-fill from stored credentials for current subdomain only (silent mode)
        try {
          const domain = window.location.hostname; // Use exact subdomain
          const storageKey = 'opticsify_credentials_' + domain;
          
          // Try localStorage first, then sessionStorage for current subdomain only
          let storedData = localStorage.getItem(storageKey) || sessionStorage.getItem(storageKey);
          
          if (storedData) {
            const credentials = JSON.parse(storedData);
            
            // Auto-fill username and password if found and fields are empty
            if (credentials.username) {
              const usernameInputs = document.querySelectorAll('input[type="email"], input[type="text"], input[name*="user"], input[name*="login"], input[name*="email"]');
              usernameInputs.forEach(input => {
                if (!input.value && (input.name === credentials.usernameField || input.id === credentials.usernameField || !credentials.usernameField)) {
                  // Auto-fill since we only have credentials for this exact subdomain
                  input.value = credentials.username;
                  input.dispatchEvent(new Event('input', { bubbles: true }));
                  input.dispatchEvent(new Event('change', { bubbles: true }));
                }
              });
            }
            
            // Auto-fill password if available
            if (credentials.password) {
              const passwordInputs = document.querySelectorAll('input[type="password"]');
              passwordInputs.forEach(input => {
                if (!input.value && (input.name === credentials.passwordField || input.id === credentials.passwordField || !credentials.passwordField)) {
                  input.value = credentials.password;
                  input.dispatchEvent(new Event('input', { bubbles: true }));
                  input.dispatchEvent(new Event('change', { bubbles: true }));
                }
              });
            }
          }
        } catch (err) {
          console.log('Error loading stored credentials:', err);
        }
      }
      
      // Run immediately and on any DOM changes
      enableAutofillWithVisualDropdown();
      
      // Watch for dynamically added forms
      const observer = new MutationObserver(() => {
        enableAutofillWithVisualDropdown();
      });
      observer.observe(document.body, { childList: true, subtree: true });
      
      // Also run when page becomes visible (for subdomain navigation)
      document.addEventListener('visibilitychange', () => {
        if (!document.hidden) {
          setTimeout(enableAutofillWithVisualDropdown, 100);
        }
      });
    `).then(() => {
      console.log('Enhanced autofill script with visual dropdown injected successfully');
    }).catch(err => {
      console.log('Could not inject autofill script:', err);
    });
    
    if (process.platform === 'win32') {
      //console.log('Windows platform detected - applying zoom factor and debugging');
      
      // Use a slight delay to ensure the page is fully rendered
      setTimeout(() => {
        try {
          mainWindow.webContents.setZoomFactor(0.9); // Increased from 0.8 to 0.9 for better visibility
          //console.log('Windows zoom factor applied successfully: 0.9');
          
          // Additional Windows debugging
          mainWindow.webContents.executeJavaScript(`
            //console.log('Windows debugging - Page dimensions:', {
              windowWidth: window.innerWidth,
              windowHeight: window.innerHeight,
              documentWidth: document.documentElement.clientWidth,
              documentHeight: document.documentElement.clientHeight,
              bodyWidth: document.body ? document.body.clientWidth : 'N/A',
              bodyHeight: document.body ? document.body.clientHeight : 'N/A',
              userAgent: navigator.userAgent,
              platform: navigator.platform
            });
            
            // Check if landing page elements are visible
            const container = document.querySelector('.container');
            const logo = document.querySelector('.logo');
            const title = document.querySelector('.title');
            const subtitle = document.querySelector('.subtitle');
            
            if (container) {
              //console.log('Windows debugging - Container found:', {
                display: getComputedStyle(container).display,
                visibility: getComputedStyle(container).visibility,
                opacity: getComputedStyle(container).opacity,
                height: container.offsetHeight,
                width: container.offsetWidth
              });
            } else {
              //console.log('Windows debugging - Container NOT found');
            }
            
            if (logo) {
              //console.log('Windows debugging - Logo found:', {
                display: getComputedStyle(logo).display,
                visibility: getComputedStyle(logo).visibility,
                width: logo.offsetWidth,
                height: logo.offsetHeight
              });
            } else {
              //console.log('Windows debugging - Logo NOT found');
            }
            
            if (title) {
              //console.log('Windows debugging - Title found:', title.textContent);
            } else {
              //console.log('Windows debugging - Title NOT found');
            }
            
            if (subtitle) {
              //console.log('Windows debugging - Subtitle found:', subtitle.textContent);
            } else {
              //console.log('Windows debugging - Subtitle NOT found');
            }
          `).catch(err => {
            console.error('Error executing Windows debugging script:', err);
          });
          
        } catch (error) {
          console.error('Error applying Windows zoom factor:', error);
        }
      }, 100);
    }
  });

  // Comprehensive print page protection - multiple event handlers
  
  // 1. Handle navigation to print pages - allow them to open in new tabs
  mainWindow.webContents.on('will-navigate', async (event, navigationUrl) => {
    //console.log('will-navigate event:', navigationUrl);
    const willNavigateParsedUrl = new URL(navigationUrl);
    //console.log('will-navigate details:', {
    //   hostname: willNavigateParsedUrl.hostname,
    //   pathname: willNavigateParsedUrl.pathname,
    //   isopticsify: willNavigateParsedUrl.hostname.endsWith('opticsify.com')
    // });
    ////console.log('Navigation intercepted:', navigationUrl);
    
    // Check if navigating to a print page - allow it to proceed
    if (navigationUrl.includes('/print/') || navigationUrl.includes('/print')) {
      ////console.log('Print page navigation detected - allowing navigation to open in new tab');
      // Don't prevent navigation for print pages - let them open in new tabs
      return;
    }
    
    // PROACTIVE LOGOUT DETECTION: Clear session when navigating to login/logout pages
    const isNavigatingToLoginOrLogout = willNavigateParsedUrl.pathname.includes('/login') ||
                                        willNavigateParsedUrl.pathname.includes('/logout') ||
                                        willNavigateParsedUrl.pathname.includes('/sign-in') ||
                                        willNavigateParsedUrl.pathname.includes('/signin') ||
                                        willNavigateParsedUrl.pathname.endsWith('/login.html');
    
    if (isNavigatingToLoginOrLogout && willNavigateParsedUrl.hostname.endsWith('opticsify.com')) {
      if (isDevelopment || enableProductionDebug) {
        console.log('🔄 [LOGOUT DETECTED] Proactively clearing session before navigation to:', navigationUrl);
      }
      
      // Get current URL to check if we're coming from a logged-in state
      const currentUrl = mainWindow.webContents.getURL();
      let shouldClearSession = true;
      
      if (currentUrl && !currentUrl.startsWith('data:text/html')) {
        try {
          const currentParsedUrl = new URL(currentUrl);
          const wasAlreadyOnLoginPage = currentParsedUrl.pathname.includes('/login') ||
                                       currentParsedUrl.pathname.includes('/sign-in') ||
                                       currentParsedUrl.pathname.includes('/signin');
          
          // Only clear if we weren't already on a login page (to avoid redundant clearing)
          shouldClearSession = !wasAlreadyOnLoginPage;
        } catch (err) {
          // If URL parsing fails, clear session anyway
          shouldClearSession = true;
        }
      }
      
      if (shouldClearSession) {
        if (isDevelopment || enableProductionDebug) {
          console.log('✅ [SESSION CLEAR] Clearing session immediately before logout/login navigation');
        }
        
        // Clear session IMMEDIATELY and SYNCHRONOUSLY (don't wait)
        const { session } = require('electron');
        const opticsifySession = session.fromPartition('persist:opticsify-session');
        
        try {
          // Clear cookies while preserving user preferences
          const preservedCount = await preserveAndClearCookies(opticsifySession, true);
          if (isDevelopment || enableProductionDebug) {
            console.log(`Session cookies cleared, preserved ${preservedCount} preference cookies`);
          }
          
          // Clear all storage data
          await opticsifySession.clearStorageData({
            storages: ['appcache', 'cookies', 'filesystem', 'indexdb', 'localstorage', 'shadercache', 'websql', 'serviceworkers', 'cachestorage']
          });
          
          // Clear cache
          await opticsifySession.clearCache();
          
          // Also clear webContents session
          if (mainWindow && mainWindow.webContents) {
            const webSession = mainWindow.webContents.session;
            const webPreservedCount = await preserveAndClearCookies(webSession, true);
            if (isDevelopment || enableProductionDebug) {
              console.log(`WebContents cookies cleared, preserved ${webPreservedCount} preference cookies`);
            }
            
            await webSession.clearStorageData({
              storages: ['appcache', 'cookies', 'filesystem', 'indexdb', 'localstorage', 'shadercache', 'websql', 'serviceworkers', 'cachestorage']
            });
            await webSession.clearCache();
          }
          
          if (isDevelopment || enableProductionDebug) {
            console.log('✅ [SESSION CLEARED] All session data cleared successfully before navigation');
          }
        } catch (clearError) {
          console.error('[SESSION CLEAR ERROR]', clearError);
        }
      }
    }
    
    // Handle deep links and URLs with data - ensure session persistence
    const deepLinkParsedUrl = new URL(navigationUrl);
    if (deepLinkParsedUrl.hostname.endsWith('opticsify.com')) {
      ////console.log('opticsify navigation detected:', navigationUrl);
      
      // For deep links like /customers/manage_customers/, ensure session data is preserved
      if (deepLinkParsedUrl.pathname.includes('/customers/') || 
          deepLinkParsedUrl.pathname.includes('/manage_') ||
          deepLinkParsedUrl.search || deepLinkParsedUrl.hash) {
        ////console.log('Deep link or URL with data detected, ensuring session persistence');
        
        // Force session data to be saved before navigation (only for non-logout navigation)
        if (!isNavigatingToLoginOrLogout) {
          const { session } = require('electron');
          const opticsifySession = session.fromPartition('persist:opticsify-session');
          opticsifySession.cookies.flushStore().catch(err => {
            console.error('Error flushing cookies before navigation:', err);
          });
        }
      }
    }
  });

  // 2. Comprehensive new window/tab handling - allow new tabs for opticsify.com links
  mainWindow.webContents.setWindowOpenHandler(({ url, frameName, features, disposition, referrer, postBody }) => {
    //console.log('New window open attempt:', url, 'frameName:', frameName, 'features:', features, 'disposition:', disposition);
    //console.log('POST body present:', !!postBody, 'POST body length:', postBody ? postBody.length : 0);
    
    const parsedUrl = new URL(url);
    
    // Check for social media share URLs and open them in the system browser (Chrome)
    const socialMediaDomains = ['whatsapp.com', 'wa.me', 'facebook.com', 'twitter.com', 'x.com', 'linkedin.com', 't.me', 'telegram.org'];
    if (socialMediaDomains.some(domain => parsedUrl.hostname.includes(domain))) {
      //console.log('Social media share link detected - opening in system browser:', url);
      shell.openExternal(url);
      return { action: 'deny' };
    }
    
    // CHECK PRINT PAGES FIRST - Allow print pages to open in new windows
    if (url.includes('/print/') || url.includes('/print')) {
      //console.log('Print page detected - allowing new window for printing:', url);
      
      // Allow the print page to open in a new window
      return { 
        action: 'allow',
        overrideBrowserWindowOptions: {
          width: 1200,
          height: 800,
          webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
            enableRemoteModule: false,
            webSecurity: true,
            allowRunningInsecureContent: false,
            experimentalFeatures: false,
            preload: path.join(__dirname, 'preload.js'),
            partition: 'persist:opticsify-session'
          },
          icon: path.join(__dirname, 'assets', 'icon.png'),
          titleBarStyle: 'default'
        }
      };
    }
    
    // Handle opticsify links with POST data - load in SAME window with POST data
    if (parsedUrl.hostname.endsWith('opticsify.com') && postBody) {
      //console.log('opticsify link with POST data - loading in same window with POST data:', url);
      //console.log('POST body details:', {
      //   exists: !!postBody,
      //   type: typeof postBody,
      //   isArray: Array.isArray(postBody),
      //   length: Array.isArray(postBody) ? postBody.length : 'N/A'
      // });
      
      // Try to log the POST data for debugging
      try {
        if (Array.isArray(postBody) && postBody.length > 0) {
          const postDataString = Buffer.concat(postBody.map(item => item.bytes)).toString();
          //console.log('POST data content:', postDataString);
        } else {
          //console.log('POST body structure:', JSON.stringify(postBody, null, 2));
        }
      } catch (e) {
        //console.log('Could not parse POST data:', e.message);
        //console.log('POST body raw:', postBody);
      }
      
      // Load the URL in the same window with POST data
      // postData must be an array of UploadData objects
      // postBody has structure: { data: [...], contentType: "..." }
      // We need to pass postBody.data as the postData
      const postDataToSend = postBody.data || postBody;
      const contentType = postBody.contentType || 'application/x-www-form-urlencoded';
      
      mainWindow.webContents.loadURL(url, {
        postData: postDataToSend,
        extraHeaders: `Content-Type: ${contentType}`
      }).then(() => {
        //console.log('Successfully loaded URL with POST data');
      }).catch((err) => {
        console.error('Error loading URL with POST data:', err);
      });
      
      return { action: 'deny' };
    }
    
    // Handle ALL other opticsify.com links (without POST data) - keep them in the SAME window
    if (parsedUrl.hostname.endsWith('opticsify.com')) {
      //console.log('opticsify link (no POST data) - loading in same window:', url);
      
      // Navigate in the current window instead of opening a new tab
      mainWindow.loadURL(url);
      return { action: 'deny' };
    }
    
    // Open truly external links in system browser
    shell.openExternal(url);
    return { action: 'deny' };
  });

  // Navigation tracking with enhanced logging for debugging
  mainWindow.webContents.on('did-navigate', (event, url) => {
    if (isDevelopment || enableProductionDebug) {
      console.log('');
      console.log('═══════════════════════════════════════════════════════════════');
      console.log('🧭 [NAVIGATION] Navigated to:', url);
      console.log('═══════════════════════════════════════════════════════════════');
    }
    
    // Add URL to our navigation stack
    addToUrlStack(url);
    
    // Reset session clear tracker when navigating to non-login pages
    // This allows session clearing to work again if user logs out later
    const parsedUrl = new URL(url);
    const isLoginPage = parsedUrl.pathname.includes('/login') ||
                       parsedUrl.pathname.includes('/sign-in') ||
                       parsedUrl.pathname.includes('/signin');
    
    if (!isLoginPage && lastSessionClearUrl) {
      if (isDevelopment || enableProductionDebug) {
        console.log('🔄 [SESSION] Navigated away from login page - resetting session clear tracker');
      }
      lastSessionClearUrl = null;
      lastSessionClearTime = 0;
    }
    
    // Log additional details for debugging URL issues
    //console.log('Navigation details:', {
    //    hostname: parsedUrl.hostname,
    //    pathname: parsedUrl.pathname,
    //    search: parsedUrl.search,
    //    hash: parsedUrl.hash,
    //    hasData: !!(parsedUrl.search || parsedUrl.hash)
    //  });
    
    // Check if this is a deep link with data
    if (parsedUrl.pathname.includes('/customers/') || 
        parsedUrl.pathname.includes('/manage_') ||
        parsedUrl.search || parsedUrl.hash) {
      ////console.log('Deep link navigation completed with data preservation');
    }
    
    // Detect logout/login pages
    const isAuthPage = parsedUrl.pathname.includes('/auth/') || 
                       parsedUrl.pathname.includes('/login') || 
                       parsedUrl.pathname.endsWith('/login.html') ||
                       parsedUrl.pathname.includes('/logout') ||
                       parsedUrl.pathname.includes('/sign-in') ||
                       parsedUrl.pathname.includes('/signin');
    
    // Check if navigating TO a login page (which means logout happened)
    // Support both opticsify.com subdomains and custom domains
    const isNavigatingToLogin = parsedUrl.pathname.includes('/login') || 
                                parsedUrl.pathname.includes('/sign-in') ||
                                parsedUrl.pathname.includes('/signin');
    
    if (isDevelopment || enableProductionDebug) {
      console.log('🔍 [LOGOUT DETECTION] Current URL:', url);
      console.log('🔍 [LOGOUT DETECTION] Is login page?', isNavigatingToLogin);
    }
    
    // If navigating to login page and coming from a non-login page, it means logout happened
    const previousUrl = mainWindow.webContents.getURL();
    if (isDevelopment || enableProductionDebug) {
      console.log('🔍 [LOGOUT DETECTION] Previous URL:', previousUrl);
    }
    
    if (previousUrl && isNavigatingToLogin && !previousUrl.startsWith('data:text/html')) {
      try {
        const prevParsedUrl = new URL(previousUrl);
        const wasLoggedIn = !prevParsedUrl.pathname.includes('/login') && 
                           !prevParsedUrl.pathname.includes('/sign-in') &&
                           !prevParsedUrl.pathname.includes('/signin') &&
                           !prevParsedUrl.pathname.includes('/auth/');
        
        if (isDevelopment || enableProductionDebug) {
          console.log('🔍 [LOGOUT DETECTION] Was logged in?', wasLoggedIn);
        }
        
        if (wasLoggedIn) {
          if (isDevelopment || enableProductionDebug) {
            console.log('✅ [LOGOUT CONFIRMED] Navigating from app to login page - performing final cleanup');
          }
          
          // Additional cleanup after navigation (most cleaning should have happened in will-navigate)
          // This is a safety net in case will-navigate didn't catch it
          const { session } = require('electron');
          const opticsifySession = session.fromPartition('persist:opticsify-session');
          
          // Use immediate async execution (no setTimeout delay) for faster cleanup
          (async () => {
            try {
              // Clear cookies while preserving user preferences
              const preservedCount = await preserveAndClearCookies(opticsifySession, true);
              if (isDevelopment || enableProductionDebug) {
                console.log(`[FINAL CLEANUP] Session cookies cleared, preserved ${preservedCount} preference cookies`);
              }
              
              // Clear ALL storage data (comprehensive clear)
              await opticsifySession.clearStorageData({
                storages: ['appcache', 'cookies', 'filesystem', 'indexdb', 'localstorage', 'shadercache', 'websql', 'serviceworkers', 'cachestorage']
              });
              if (isDevelopment || enableProductionDebug) {
                console.log('Opticsify session storage cleared');
              }
              
              // Clear cache
              await opticsifySession.clearCache();
              if (isDevelopment || enableProductionDebug) {
                console.log('Opticsify session cache cleared');
              }
              
              // Also clear webContents session
              if (mainWindow && mainWindow.webContents) {
                const webSession = mainWindow.webContents.session;
                
                // Clear webSession cookies while preserving preferences
                const webPreservedCount = await preserveAndClearCookies(webSession, true);
                if (isDevelopment || enableProductionDebug) {
                  console.log(`[FINAL CLEANUP] WebContents cookies cleared, preserved ${webPreservedCount} preference cookies`);
                }
                
                await webSession.clearStorageData({
                  storages: ['appcache', 'cookies', 'filesystem', 'indexdb', 'localstorage', 'shadercache', 'websql', 'serviceworkers', 'cachestorage']
                });
                await webSession.clearCache();
                if (isDevelopment || enableProductionDebug) {
                  console.log('WebContents session cleared');
                }
                
                // Also clear storage via JavaScript execution
                try {
                  await mainWindow.webContents.executeJavaScript(`
                    // Get subdomain to clear subdomain-specific keys
                    const hostname = window.location.hostname;
                    const subdomain = hostname.split('.')[0];
                    const storageKey = subdomain + '_';
                    
                    // Clear all localStorage keys, including subdomain-prefixed ones
                    const keysToRemove = [];
                    for (let i = 0; i < localStorage.length; i++) {
                      const key = localStorage.key(i);
                      keysToRemove.push(key);
                    }
                    keysToRemove.forEach(key => localStorage.removeItem(key));
                    
                    // Also use clear() for good measure
                    localStorage.clear();
                    sessionStorage.clear();
                    
                    // Clear cookies via JavaScript while preserving user preferences
                    const preservedCookieNames = ['dont_show_all_videos', 'lang', 'user_lang'];
                    const preservedCookies = {};
                    
                    // Save preserved cookies
                    preservedCookieNames.forEach(function(name) {
                      const value = document.cookie.split('; ').find(row => row.startsWith(name + '='));
                      if (value) {
                        preservedCookies[name] = value.split('=')[1];
                      }
                    });
                    
                    // Clear all cookies
                    document.cookie.split(";").forEach(function(c) { 
                      document.cookie = c.replace(/^ +/, "").replace(/=.*/, "=;expires=" + new Date().toUTCString() + ";path=/"); 
                    });
                    
                    // Restore preserved cookies
                    Object.keys(preservedCookies).forEach(function(name) {
                      document.cookie = name + '=' + preservedCookies[name] + '; path=/; max-age=31536000';
                    });
                    
                    console.log('localStorage, sessionStorage, and cookies cleared after logout (preserved ' + Object.keys(preservedCookies).length + ' preference cookies)');
                  `);
                } catch (jsError) {
                  console.error('Error clearing storage via JavaScript:', jsError);
                }
              }
              
              if (isDevelopment || enableProductionDebug) {
                console.log('Electron session fully cleared after web app logout');
                // Don't reload - let the web app handle the logout UI naturally
                
                console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
                console.log('✅ [LOGOUT COMPLETE] Final cleanup finished');
                console.log('   - Cookies cleared from both sessions');
                console.log('   - Storage cleared (localStorage, sessionStorage, etc.)');
                console.log('   - Cache cleared');
                console.log('   - Ready for fresh login');
                console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
              }
            } catch (err) {
              console.error('[LOGOUT ERROR] Error in final cleanup on logout:', err);
            }
          })();
        }
      } catch (err) {
        // Ignore URL parsing errors
      }
    }
    
    if (isAuthPage && parsedUrl.hostname.includes('opticsify.com')) {
      console.log('Login/Logout page detected:', url);
      
      // Get current language for translation
      const currentLanguage = store.get('language', 'en');
      const translations = {
        en: {
          changeStore: '<i class="ti ti-building-store"></i> Change Store'
        },
        ar: {
          changeStore: '<i class="ti ti-building-store"></i> تغيير المتجر'
        }
      };
      
      const buttonText = translations[currentLanguage]?.changeStore || translations.en.changeStore;
      const isRTL = currentLanguage === 'ar';
      const buttonPosition = isRTL ? 'left: 20px;' : 'right: 20px;';
      
      // Inject a button to return to store selector
      setTimeout(() => {
        mainWindow.webContents.executeJavaScript(`
          (function() {
            // Check if button already exists
            if (document.getElementById('electron-change-store-btn')) {
              return;
            }
            
            const isRTL = ${isRTL};
            
            // Create change store button
            const btn = document.createElement('button');
            btn.id = 'electron-change-store-btn';
            btn.innerHTML = '${buttonText}';
            btn.style.cssText = \`
              position: fixed;
              top: 20px;
              ${buttonPosition}
              padding: 12px 24px;
              background: linear-gradient(135deg, #3B82F6 0%, #8B5CF6 100%);
              color: white;
              border: none;
              border-radius: 8px;
              font-size: 14px;
              font-weight: 600;
              cursor: pointer;
              box-shadow: 0 4px 15px rgba(59, 130, 246, 0.4);
              z-index: 999999;
              transition: all 0.3s;
              font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
              direction: \${isRTL ? 'rtl' : 'ltr'};
            \`;
            
            btn.onmouseover = function() {
              this.style.transform = 'translateY(-2px)';
              this.style.boxShadow = '0 8px 25px rgba(59, 130, 246, 0.6)';
            };
            
            btn.onmouseout = function() {
              this.style.transform = 'translateY(0)';
              this.style.boxShadow = '0 4px 15px rgba(59, 130, 246, 0.4)';
            };
            
            btn.onclick = async function() {
              if (window.electronAPI && window.electronAPI.changeStore) {
                await window.electronAPI.changeStore();
              }
            };
            
            document.body.appendChild(btn);
            console.log('Change Store button injected on login page');
          })();
        `).catch(err => {
          console.error('Error injecting change store button:', err);
        });
      }, 500);
      
      // Inject autofill credentials script
      setTimeout(() => {
        mainWindow.webContents.executeJavaScript(`
          (async function() {
            if (!window.electronAPI || !window.electronAPI.getLoginCredentials || !window.electronAPI.saveLoginCredentials) {
              console.log('Electron API not available for autofill');
              return;
            }
            
            const domain = window.location.hostname;
            console.log('Login page autofill: checking for saved credentials for', domain);
            
            // Try to get saved credentials
            try {
              const result = await window.electronAPI.getLoginCredentials(domain);
              
              if (result.success && result.credentials) {
                console.log('Found saved credentials, attempting autofill...');
                
                // Wait for form to be ready
                const waitForForm = setInterval(() => {
                  // Look for common login input fields
                  const usernameInput = document.querySelector('input[type="email"], input[name="email"], input[name="username"], input[id*="email"], input[id*="username"], input[placeholder*="email" i], input[placeholder*="username" i]');
                  const passwordInput = document.querySelector('input[type="password"]');
                  
                  if (usernameInput && passwordInput) {
                    clearInterval(waitForForm);
                    
                    // Fill in the credentials
                    usernameInput.value = result.credentials.username;
                    passwordInput.value = result.credentials.password;
                    
                    // Trigger input events to ensure the form recognizes the values
                    usernameInput.dispatchEvent(new Event('input', { bubbles: true }));
                    usernameInput.dispatchEvent(new Event('change', { bubbles: true }));
                    passwordInput.dispatchEvent(new Event('input', { bubbles: true }));
                    passwordInput.dispatchEvent(new Event('change', { bubbles: true }));
                    
                    console.log('Credentials autofilled successfully');
                  }
                }, 100);
                
                // Stop checking after 5 seconds
                setTimeout(() => clearInterval(waitForForm), 5000);
              }
            } catch (error) {
              console.error('Error loading credentials:', error);
            }
            
            // Monitor form submission to save credentials
            const monitorFormSubmission = () => {
              const forms = document.querySelectorAll('form');
              
              forms.forEach(form => {
                if (form.dataset.electronMonitored) return;
                form.dataset.electronMonitored = 'true';
                
                form.addEventListener('submit', async (e) => {
                  const usernameInput = form.querySelector('input[type="email"], input[name="email"], input[name="username"], input[id*="email"], input[id*="username"]');
                  const passwordInput = form.querySelector('input[type="password"]');
                  
                  if (usernameInput && passwordInput && usernameInput.value && passwordInput.value) {
                    console.log('Login form submitted, saving credentials...');
                    
                    try {
                      await window.electronAPI.saveLoginCredentials({
                        username: usernameInput.value,
                        password: passwordInput.value,
                        domain: domain
                      });
                      console.log('Credentials saved successfully');
                    } catch (error) {
                      console.error('Error saving credentials:', error);
                    }
                  }
                });
              });
            };
            
            // Initial check
            monitorFormSubmission();
            
            // Monitor for dynamically added forms
            const observer = new MutationObserver(() => {
              monitorFormSubmission();
            });
            
            observer.observe(document.body, {
              childList: true,
              subtree: true
            });
            
            console.log('Login autofill monitoring active');
          })();
        `).catch(err => {
          if (isDevelopment || enableProductionDebug) {
            console.error('Error injecting autofill script:', err);
          }
        });
      }, 1000);
    }
  });

  // Add back button functionality when page loads - TEMPORARILY DISABLED FOR DEBUGGING
  mainWindow.webContents.on('did-finish-load', () => {
    ////console.log('Page loaded, back button injection enabled');
    
    
    const currentUrl = mainWindow.webContents.getURL();
    console.log('');
    console.log('═══════════════════════════════════════════════════════════════');
    console.log('📄 [PAGE LOAD] URL:', currentUrl);
    console.log('═══════════════════════════════════════════════════════════════');
    ////console.log('Current URL:', currentUrl);
    
    // Only add back button for opticsify.com pages (not the subdomain form)
    if (currentUrl.includes('opticsify.com') && !currentUrl.includes('data:text/html')) {
      ////console.log('Injecting back button for opticsify.com page');
      
      // Check if this is a login/logout page - skip localStorage injection to avoid interfering with logout
      const isAuthPage = currentUrl.includes('/login') || 
                        currentUrl.includes('/logout') || 
                        currentUrl.includes('/sign-in') || 
                        currentUrl.includes('/signin') ||
                        currentUrl.includes('/auth/');
      
      // If we're on auth page, ensure logout flag is cleared for fresh start
      if (isAuthPage) {
        if (isDevelopment || enableProductionDebug) {
          console.log('🔓 [AUTH PAGE] On auth page, clearing logout flag');
        }
        setTimeout(() => {
          mainWindow.webContents.executeJavaScript(`
            try {
              const had_flag = sessionStorage.getItem('electron_logout_in_progress');
              if (had_flag) {
                sessionStorage.removeItem('electron_logout_in_progress');
                console.log('🔓 [AUTH PAGE] Cleared logout flag (was: true)');
              } else {
                console.log('🔓 [AUTH PAGE] No logout flag to clear');
              }
            } catch (e) {
              console.log('⚠️ [AUTH PAGE] Could not access sessionStorage yet');
            }
          `).catch(err => {
            // Silently fail - page might not be ready yet
          });
        }, 500);
      }
      
      // If we're on a logged-in page (not auth), also clear any stale logout flag
      if (!isAuthPage) {
        setTimeout(() => {
          mainWindow.webContents.executeJavaScript(`
            try {
              const had_flag = sessionStorage.getItem('electron_logout_in_progress');
              if (had_flag) {
                sessionStorage.removeItem('electron_logout_in_progress');
                console.log('✅ [CLEAR FLAG] Cleared stale logout flag on logged-in page');
              }
            } catch (e) {
              console.log('⚠️ [CLEAR FLAG] Could not clear flag yet (page not ready)');
            }
          `).catch(err => {
            // Silently fail - page might not be ready yet
          });
        }, 500);
      }
      
      // Inject custom Omnes fonts from assets
      console.log('Injecting Omnes fonts for subdomain page...');
      mainWindow.webContents.insertCSS(`
        @font-face {
          font-family: 'Omnes';
          src: url('fonts://Omnes Regular.otf') format('opentype');
          font-weight: 400;
          font-style: normal;
        }
        @font-face {
          font-family: 'Omnes';
          src: url('fonts://Omnes Light.otf') format('opentype');
          font-weight: 300;
          font-style: normal;
        }
        @font-face {
          font-family: 'Omnes';
          src: url('fonts://Omnes Medium.otf') format('opentype');
          font-weight: 500;
          font-style: normal;
        }
        @font-face {
          font-family: 'Omnes';
          src: url('fonts://Omnes SemiBold.otf') format('opentype');
          font-weight: 600;
          font-style: normal;
        }
        @font-face {
          font-family: 'Omnes';
          src: url('fonts://Omnes Bold.otf') format('opentype');
          font-weight: 700;
          font-style: normal;
        }
        @font-face {
          font-family: 'Omnes';
          src: url('fonts://Omnes Black.otf') format('opentype');
          font-weight: 900;
          font-style: normal;
        }
        @font-face {
          font-family: 'Omnes';
          src: url('fonts://Omnes Thin.otf') format('opentype');
          font-weight: 100;
          font-style: normal;
        }
        @font-face {
          font-family: 'Omnes';
          src: url('fonts://Omnes ExtraLight.otf') format('opentype');
          font-weight: 200;
          font-style: normal;
        }
        @font-face {
          font-family: 'Omnes';
          src: url('fonts://Omnes Hairline.otf') format('opentype');
          font-weight: 50;
          font-style: normal;
        }
        
        /* Apply Omnes font globally, excluding icon font elements */
        body,
        body *:not([class*="fa"]):not([class*=" fa-"]):not([class^="fa-"]):not([class*="ti "]):not([class*=" ti-"]):not([class^="ti-"]):not([class*="glyphicon"]):not([class*="icon-"]) {
          font-family: 'Omnes', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif !important;
        }

        /* Preserve specific UI elements */
        input, textarea, select, button {
          font-family: 'Omnes', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif !important;
        }

        /* Guarantee icon font families are never clobbered */
        .fa, [class*=" fa-"], [class^="fa-"] {
          font-family: 'Font Awesome 6 Free', 'Font Awesome 5 Free', 'FontAwesome' !important;
          font-style: normal;
        }
        .ti, [class*=" ti-"], [class^="ti-"] {
          font-family: 'tabler-icons' !important;
          font-style: normal;
        }
        
        /* Hide desktop app download button */
        .dropdown-desktop-app {
          display: none !important;
        }
      `).then(() => {
        console.log('Omnes fonts CSS injected successfully');
        
        // Inject logout monitoring script
        mainWindow.webContents.executeJavaScript(`
          (function() {
            // Prevent double injection
            if (window.__electronLogoutMonitorInjected) {
              console.log('⏭️ [SKIP] Logout monitor already injected, skipping...');
              return;
            }
            window.__electronLogoutMonitorInjected = true;
            
            // Monitor for logout actions
            let logoutDetected = false;
            
            // Also monitor form submissions (common logout method)
            document.addEventListener('submit', function(e) {
              const form = e.target;
              const action = form.action || '';
              const method = form.method || '';
              
              console.log('📋 [FORM SUBMIT] Form submitted:', {
                action: action,
                method: method,
                id: form.id,
                class: form.className
              });
              
              if (action.includes('/logout') || action.includes('/sign-out') || 
                  form.id.includes('logout') || form.className.includes('logout')) {
                console.log('🚪 [LOGOUT FORM] Logout form detected!');
                sessionStorage.setItem('electron_logout_in_progress', 'true');
                logoutDetected = true;
              }
            }, true);
            
            // Monitor ALL clicks to see what's being clicked
            let clickCount = 0;
            document.addEventListener('click', function(e) {
              clickCount++;
              const target = e.target;
              
              // Log every 10th click to avoid spam, or if it looks like logout
              const text = (target.textContent || '').toLowerCase();
              const href = target.getAttribute ? (target.getAttribute('href') || '') : '';
              const isLogoutRelated = text.includes('logout') || text.includes('خروج') || 
                                      href.includes('/logout') || href.includes('/sign-out');
              
              if (isLogoutRelated || clickCount % 10 === 0) {
                console.log('🖱️ [CLICK #' + clickCount + ']', {
                  tag: target.tagName,
                  id: target.id,
                  class: target.className ? target.className.substring(0, 30) : '',
                  text: text.substring(0, 50),
                  href: href
                });
              }
            }, true);
            
            // Watch for clicks on logout buttons/links
            document.addEventListener('click', function(e) {
              let target = e.target;
              
              // Traverse up the DOM tree to find the actual link/button (max 5 levels)
              let checkElement = target;
              let found = false;
              
              for (let i = 0; i < 5 && checkElement; i++) {
                const href = checkElement.getAttribute ? (checkElement.getAttribute('href') || '') : '';
                const text = checkElement.textContent || '';
                const id = checkElement.id || '';
                const className = checkElement.className || '';
                
                // Check if this is a logout action
                const isLogout = href.includes('/logout') || 
                                href.includes('/sign-out') ||
                                href.includes('/signout') ||
                                text.toLowerCase().includes('logout') ||
                                text.toLowerCase().includes('sign out') ||
                                text.toLowerCase().includes('تسجيل خروج') ||
                                id.includes('logout') ||
                                className.includes('logout');
                
                if (isLogout) {
                  found = true;
                  target = checkElement; // Use the parent element that has the logout info
                  break;
                }
                
                checkElement = checkElement.parentElement;
              }
              
              if (found && !logoutDetected) {
                logoutDetected = true;
                const href = target.getAttribute ? (target.getAttribute('href') || '') : '';
                const text = target.textContent || '';
                console.log('🚪 [LOGOUT CLICK] Logout action detected from web app');
                console.log('🚪 [LOGOUT CLICK] Target:', target.tagName, 'href:', href, 'text:', text.substring(0, 50));
                // Mark logout in progress immediately to prevent localStorage restoration
                sessionStorage.setItem('electron_logout_in_progress', 'true');
                console.log('🚪 [LOGOUT CLICK] Set electron_logout_in_progress = true');
                
                // Give the web app time to process logout, then clear Electron session
                setTimeout(() => {
                  // Check if we're on a login page now (logout was successful)
                  if (window.location.pathname.includes('/login') || 
                      window.location.pathname.includes('/sign-in')) {
                    console.log('Logout confirmed - on login page');
                    // Clear the logout flag on login page
                    sessionStorage.removeItem('electron_logout_in_progress');
                    // The did-navigate handler will clear the session
                  }
                }, 1000);
              }
            }, true);
            
            // Monitor fetch/AJAX requests for logout (many SPAs use this)
            const originalFetch = window.fetch;
            window.fetch = function(...args) {
              const url = args[0];
              const urlStr = typeof url === 'string' ? url : url.url || '';
              
              if (urlStr.includes('/logout') || urlStr.includes('/sign-out') || 
                  urlStr.includes('/auth/logout') || urlStr.includes('/api/logout')) {
                console.log('🌐 [FETCH LOGOUT] Logout API call detected:', urlStr);
                sessionStorage.setItem('electron_logout_in_progress', 'true');
                logoutDetected = true;
              }
              
              return originalFetch.apply(this, args);
            };
            
            // Also monitor XMLHttpRequest (older AJAX method)
            const originalOpen = XMLHttpRequest.prototype.open;
            XMLHttpRequest.prototype.open = function(method, url) {
              const urlStr = url.toString();
              
              if (urlStr.includes('/logout') || urlStr.includes('/sign-out') || 
                  urlStr.includes('/auth/logout') || urlStr.includes('/api/logout')) {
                console.log('🌐 [XHR LOGOUT] Logout API call detected:', urlStr);
                sessionStorage.setItem('electron_logout_in_progress', 'true');
                logoutDetected = true;
              }
              
              return originalOpen.apply(this, arguments);
            };
            
            // Monitor localStorage clearing (another logout indicator)
            const originalClear = Storage.prototype.clear;
            const originalRemoveItem = Storage.prototype.removeItem;
            let logoutInProgress = false;
            
            Storage.prototype.clear = function() {
              console.log('🧹 [STORAGE.CLEAR] localStorage.clear() called - logout in progress');
              logoutInProgress = true;
              // Mark that logout is happening so we don't restore localStorage
              sessionStorage.setItem('electron_logout_in_progress', 'true');
              console.log('🧹 [STORAGE.CLEAR] Set electron_logout_in_progress = true');
              return originalClear.apply(this, arguments);
            };
            
            // Also detect when session/auth keys are removed (another logout indicator)
            Storage.prototype.removeItem = function(key) {
              // If removing auth/session related keys, mark logout in progress
              if (key && (key.includes('session') || key.includes('auth') || key.includes('token') || 
                         key.includes('user') || key.includes('login'))) {
                console.log('🔑 [STORAGE.REMOVE] Auth-related localStorage key removed:', key, '- possible logout');
                logoutInProgress = true;
                sessionStorage.setItem('electron_logout_in_progress', 'true');
                console.log('🔑 [STORAGE.REMOVE] Set electron_logout_in_progress = true');
              }
              return originalRemoveItem.apply(this, arguments);
            };
            
            console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
            console.log('✅ [LOGOUT MONITOR] Logout monitoring installed');
            console.log('   - Click monitoring: Active');
            console.log('   - Storage.clear() override: Active');
            console.log('   - Storage.removeItem() override: Active');
            console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
            
            // Also monitor for navigation away from the page (logout often causes redirect)
            console.log('🔍 [MONITOR] Setting up navigation monitoring...');
            window.addEventListener('beforeunload', function() {
              console.log('🚪 [BEFOREUNLOAD] Page is about to unload - possible logout navigation');
            });
            
            // Monitor for URL changes
            const originalPushState = history.pushState;
            history.pushState = function() {
              console.log('🔄 [HISTORY] pushState called:', arguments);
              return originalPushState.apply(this, arguments);
            };
            
            const originalReplaceState = history.replaceState;
            history.replaceState = function() {
              console.log('🔄 [HISTORY] replaceState called:', arguments);
              return originalReplaceState.apply(this, arguments);
            };
            
            window.addEventListener('popstate', function(e) {
              console.log('🔄 [POPSTATE] URL changed:', window.location.href);
            });
          })();
        `).catch(err => {
          console.error('Error injecting logout monitoring:', err);
        });
        
        // Verify font loading
        mainWindow.webContents.executeJavaScript(`
          (function() {
            setTimeout(() => {
              const testElement = document.createElement('div');
              testElement.style.fontFamily = 'Omnes';
              testElement.style.position = 'absolute';
              testElement.style.visibility = 'hidden';
              testElement.textContent = 'Test';
              document.body.appendChild(testElement);
              
              const computedFont = window.getComputedStyle(testElement).fontFamily;
              console.log('Computed font family:', computedFont);
              
              if (computedFont.includes('Omnes')) {
                console.log('✓ Omnes fonts successfully loaded and applied');
              } else {
                console.warn('⚠ Omnes fonts not applied. Falling back to:', computedFont);
              }
              
              document.body.removeChild(testElement);
            }, 500);
          })();
        `).catch(err => {
          console.error('Error verifying font loading:', err);
        });
      }).catch(err => {
        console.error('Error injecting custom fonts:', err);
      });
      
      // Inject back button CSS and HTML with language detection
      mainWindow.webContents.insertCSS(`
        /* Hide desktop app download button */
        .dropdown-desktop-app {
          display: none !important;
        }
        
        #electron-back-btn {
          position: fixed !important;
          bottom: 20px !important;
          z-index: 999999 !important;
          background: #7367f0 !important;
          color: white !important;
          border: none !important;
          border-radius: 50% !important;
          width: 50px !important;
          height: 50px !important;
          cursor: pointer !important;
          font-size: 18px !important;
          align-items: center !important;
          justify-content: center !important;
          box-shadow: 0 4px 12px rgba(0, 0, 0, 0.2) !important;
          transition: all 0.3s ease !important;
          backdrop-filter: blur(10px) !important;
        }
        #electron-back-btn.hidden {
          display: none !important;
        }
        #electron-back-btn.visible {
          display: flex !important;
        }
        #electron-back-btn.left-position {
          left: 20px !important;
        }
        #electron-back-btn.right-position {
          right: 20px !important;
        }
        #electron-back-btn:hover {
          background: #5e57d1 !important;
          transform: scale(1.1) !important;
          box-shadow: 0 6px 16px rgba(0, 0, 0, 0.3) !important;
        }
        #electron-back-btn:active {
          transform: scale(0.95) !important;
        }
      `);

      // Inject back button HTML and functionality with simplified implementation
      mainWindow.webContents.executeJavaScript(`
        (function() {
          try {
            // Remove existing back button if any
            const existingBtn = document.getElementById('electron-back-btn');
            if (existingBtn) {
              existingBtn.remove();
            }

            // Check if electronAPI is available from preload script
            if (!window.electronAPI) {
              return;
            }
          
          // Create back button
          const backBtn = document.createElement('button');
          backBtn.id = 'electron-back-btn';
          backBtn.innerHTML = '←'; // Always use left arrow
          backBtn.className = 'left-position hidden'; // Always position on left and hide by default
          backBtn.title = 'Go Back';
          
          // Add click handler that uses electronAPI
          backBtn.addEventListener('click', async () => {
            try {
              // Double-check loading state before attempting navigation
              if (document.readyState !== 'complete') {
                //console.log('Back button clicked but page not fully loaded, ignoring');
                return;
              }
              await window.electronAPI.goBack();
            } catch (error) {
              // Silent error handling
            }
          });
          
          // Add to page
          if (document.body) {
            document.body.appendChild(backBtn);
          }
          
          // Show/hide button based on navigation history
          const updateBackButtonVisibility = async () => {
            try {
              const shouldShow = await window.electronAPI.checkCanGoBack();
              const btn = document.getElementById('electron-back-btn');
              if (btn) {
                btn.className = shouldShow ? 'left-position visible' : 'left-position hidden';
              }
            } catch (error) {
              // Silent error handling
            }
          };
          
          // Listen for navigation changes
          window.addEventListener('popstate', updateBackButtonVisibility);
          
          // Initial check
          updateBackButtonVisibility();
          
          } catch (error) {
            // Silent error handling
          }
        })();
      `).then(() => {
        ////console.log('Back button injection script executed successfully');
      }).catch((error) => {
        console.error('Error executing back button injection script:', error);
      });
      
      // Inject update UI script
      const updateUIPath = path.join(__dirname, 'update-ui.js');
      
      try {
        const updateUIScript = fs.readFileSync(updateUIPath, 'utf8');
        mainWindow.webContents.executeJavaScript(updateUIScript).then(() => {
          ////console.log('Update UI script injected successfully');
        }).catch((error) => {
          console.error('Error injecting update UI script:', error);
        });
      } catch (error) {
        console.error('Error reading update UI script:', error);
      }
    } else {
      ////console.log('Skipping back button injection - not a opticsify.com page or is subdomain form');
    }
  });

  // Add error handling for page load failures
  mainWindow.webContents.on('did-fail-load', (event, errorCode, errorDescription, validatedURL) => {
    ////console.log('Page failed to load:', validatedURL, 'Error:', errorDescription, 'Code:', errorCode);
    
    // Handle specific error cases
    if (errorCode === -105 || errorDescription.includes('ERR_NAME_NOT_RESOLVED')) {
      ////console.log('Domain not resolved, clearing stored subdomain and showing form again');
      
      // Extract subdomain from failed URL for error message
      const urlMatch = validatedURL.match(/https:\/\/(.+?)\.opticsify\.com/);
      const failedSubdomain = urlMatch ? urlMatch[1] : 'unknown';
      
      // Clear the invalid subdomain
      store.delete('customerSubdomain');
      
      // Show error dialog first, then show form
      showSubdomainErrorDialog(failedSubdomain);
      
      // Show the subdomain form after a brief delay
      setTimeout(() => {
        showSubdomainFormInMainWindow();
      }, 1000);
    }
  });

  // Add error handling for unresponsive pages
  mainWindow.webContents.on('unresponsive', () => {
    ////console.log('Page became unresponsive');
    
    showSweetAlert({
      icon: 'warning',
      title: 'Page Unresponsive',
      text: 'The page has become unresponsive. Would you like to reload it?',
      showCancelButton: true,
      confirmButtonText: 'Reload',
      cancelButtonText: 'Wait',
      confirmButtonColor: '#3B82F6',
      cancelButtonColor: '#6B7280'
    }).then((result) => {
      if (result && result.isConfirmed) {
        mainWindow.webContents.reload();
      }
    }).catch((error) => {
      console.error('Error showing unresponsive dialog:', error);
    });
  });

  // Add error handling for crashes
  mainWindow.webContents.on('render-process-gone', (event, details) => {
    ////console.log('Render process gone:', details);
    
    showSweetAlert({
      icon: 'error',
      title: 'Page Crashed',
      text: 'The page has crashed. The application will reload.',
      confirmButtonText: 'OK',
      confirmButtonColor: '#EF4444'
    }).then(() => {
      mainWindow.webContents.reload();
    }).catch((error) => {
      console.error('Error showing crash dialog:', error);
      // Still try to reload even if dialog fails
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.reload();
      }
    });
  });

  // Add JavaScript error handling to prevent ApexCharts and other JS errors (only in development)
  if (isDevelopment || enableProductionDebug) {
    mainWindow.webContents.on('console-message', (event, level, message, line, sourceId) => {
      // Log JavaScript errors for debugging
      if (level === 3) { // Error level
        //console.log('JavaScript Error:', String(message), 'at line', Number(line), 'in', String(sourceId));
      }
    });
  }

  // Inject error handling for ApexCharts and other chart libraries
  mainWindow.webContents.on('dom-ready', () => {
    if (isDevelopment || enableProductionDebug) {
      //console.log('DOM ready - debug mode enabled, environment:', process.env.NODE_ENV);
    }
    /*
    mainWindow.webContents.executeJavaScript(`
      // Override console.error to catch and handle ApexCharts errors
      const originalConsoleError = console.error;
      console.error = function(...args) {
        const errorMessage = args.join(' ');
        
        // Handle specific ApexCharts errors
        if (errorMessage.includes('__resizeTriggers__') || errorMessage.includes('apexcharts')) {
          ////console.log('ApexCharts error caught and handled:', errorMessage);
          
          // Try to reinitialize charts after a delay
          setTimeout(() => {
            try {
              // Look for chart containers and try to reinitialize
              const chartContainers = document.querySelectorAll('[id*="chart"], [class*="chart"], .apexcharts-canvas');
              chartContainers.forEach(container => {
                if (container && container.parentElement) {
                  // Clear the container and trigger a re-render
                  container.innerHTML = '';
                  
                  // Dispatch a custom event to trigger chart re-rendering
                  const event = new CustomEvent('chartReinitialize', { 
                    detail: { container: container } 
                  });
                  document.dispatchEvent(event);
                }
              });
            } catch (reinitError) {
              ////console.log('Chart reinitialization failed:', reinitError);
            }
          }, 1000);
          
          return; // Don't call original console.error for ApexCharts errors
        }
        
        // Call original console.error for other errors
        originalConsoleError.apply(console, args);
      };

      // Add global error handler for unhandled promise rejections
      window.addEventListener('unhandledrejection', function(event) {
        ////console.log('Unhandled promise rejection:', event.reason);
        
        // Handle ApexCharts promise rejections
        if (event.reason && event.reason.toString().includes('__resizeTriggers__')) {
          ////console.log('ApexCharts promise rejection handled');
          event.preventDefault(); // Prevent the error from being logged
        }
        
        // Handle IPC cloning errors
        if (event.reason && event.reason.toString().includes('could not be cloned')) {
          ////console.log('IPC cloning error handled');
          event.preventDefault(); // Prevent the error from being logged
        }
      });

      // Add resize observer error handling
      const originalResizeObserver = window.ResizeObserver;
      if (originalResizeObserver) {
        window.ResizeObserver = class extends originalResizeObserver {
          constructor(callback) {
            super((entries, observer) => {
              try {
                callback(entries, observer);
              } catch (error) {
                if (error.toString().includes('__resizeTriggers__')) {
                  ////console.log('ResizeObserver error handled:', error);
                } else {
                  throw error;
                }
              }
            });
          }
        };
      }
    `);
    */
  });

  // Additional session clearing when login page loads (safety net)
  mainWindow.webContents.on('did-finish-load', async () => {
    try {
      const currentUrl = mainWindow.webContents.getURL();
      if (!currentUrl || currentUrl.startsWith('data:text/html')) {
        return;
      }
      
      const parsedUrl = new URL(currentUrl);
      const isLoginPage = parsedUrl.pathname.includes('/login') ||
                         parsedUrl.pathname.includes('/sign-in') ||
                         parsedUrl.pathname.includes('/signin') ||
                         parsedUrl.pathname.endsWith('/login.html');
      
      if (isLoginPage && parsedUrl.hostname.endsWith('opticsify.com')) {
        // Check if we've already cleared session for this URL recently
        const now = Date.now();
        const timeSinceLastClear = now - lastSessionClearTime;
        const isSameUrl = lastSessionClearUrl === currentUrl;
        
        if (isSameUrl && timeSinceLastClear < SESSION_CLEAR_COOLDOWN) {
          if (isDevelopment || enableProductionDebug) {
            console.log(`🔒 [LOGIN PAGE] Session already cleared ${Math.round(timeSinceLastClear/1000)}s ago, skipping to prevent loop`);
          }
          return;
        }
        
        if (isDevelopment || enableProductionDebug) {
          console.log('🔒 [LOGIN PAGE LOADED] Ensuring all session data is cleared...');
        }
        
        // Update tracking variables BEFORE clearing to prevent concurrent clears
        lastSessionClearUrl = currentUrl;
        lastSessionClearTime = now;
        
        // Final safety check - clear any remaining session data
        const { session } = require('electron');
        const opticsifySession = session.fromPartition('persist:opticsify-session');
        
        // Check if there are any remaining cookies
        const remainingCookies = await opticsifySession.cookies.get({});
        if (remainingCookies.length > 0) {
          if (isDevelopment || enableProductionDebug) {
            console.log(`⚠️ [SESSION WARNING] Found ${remainingCookies.length} remaining cookies on login page - clearing them...`);
          }
          for (const cookie of remainingCookies) {
            const cookieUrl = `http${cookie.secure ? 's' : ''}://${cookie.domain}${cookie.path}`;
            await opticsifySession.cookies.remove(cookieUrl, cookie.name);
          }
          if (isDevelopment || enableProductionDebug) {
            console.log('✅ [SESSION] Cookies cleared successfully');
          }
        } else {
          if (isDevelopment || enableProductionDebug) {
            console.log('✅ [SESSION] No cookies to clear - session is clean');
          }
        }
        
        // Note: Removed aggressive client-side storage clearing to prevent reload loops
        // The Electron session clearing above is sufficient for logout functionality
        // Client-side storage (localStorage, sessionStorage) will be naturally cleared
        // when the user logs in with fresh credentials
        
        if (isDevelopment || enableProductionDebug) {
          console.log('✅ [LOGIN PAGE] Session fully cleaned - ready for fresh login');
        }
      }
      
      // Clean up duplicate cookies on every page load
      if (parsedUrl.hostname.endsWith('opticsify.com')) {
        const { session } = require('electron');
        const opticsifySession = session.fromPartition('persist:opticsify-session');
        await cleanupDuplicateCookies(opticsifySession);
      }
    } catch (err) {
      // Ignore errors in this safety net
      console.error('Error in login page session cleanup:', err);
    }
  });

  // Handle window closed
  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  // Set up periodic duplicate cookie cleanup (every 60 seconds)
  const { session } = require('electron');
  const opticsifySession = session.fromPartition('persist:opticsify-session');
  const cookieCleanupInterval = setInterval(async () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      try {
        const currentUrl = mainWindow.webContents.getURL();
        if (currentUrl && currentUrl.includes('opticsify.com')) {
          await cleanupDuplicateCookies(opticsifySession);
        }
      } catch (err) {
        // Ignore cleanup errors
      }
    } else {
      // Stop interval if window is destroyed
      clearInterval(cookieCleanupInterval);
    }
  }, 60000); // Run every 60 seconds

  // Handle external links - this is now handled by the comprehensive handler above
  // Removed duplicate setWindowOpenHandler to avoid conflicts

  // Prevent navigation to external sites - allow opticsify.com navigation
  mainWindow.webContents.on('will-navigate', (event, navigationUrl) => {
    const parsedUrl = new URL(navigationUrl);
    const currentUrl = new URL(mainWindow.webContents.getURL());
    
    // Check for social media URLs and open them in the system browser (Chrome)
    const socialMediaDomains = ['whatsapp.com', 'wa.me', 'facebook.com', 'twitter.com', 'x.com', 'linkedin.com', 't.me', 'telegram.org'];
    if (socialMediaDomains.some(domain => parsedUrl.hostname.includes(domain))) {
      //console.log('Social media link navigation detected - opening in system browser:', navigationUrl);
      event.preventDefault();
      shell.openExternal(navigationUrl);
      return;
    }
    
    // Allow navigation within opticsify.com domain
    if (parsedUrl.hostname.endsWith('opticsify.com')) {
      return; // Allow navigation
    }
    
    // Prevent navigation to truly external sites
    if (parsedUrl.origin !== currentUrl.origin) {
      event.preventDefault();
      shell.openExternal(navigationUrl);
    }
  });

  // Handle certificate errors (for development)
  mainWindow.webContents.on('certificate-error', (event, url, error, certificate, callback) => {
    if (url.startsWith('https://localhost') || url.startsWith('https://127.0.0.1')) {
      // Ignore certificate errors for localhost in development
      event.preventDefault();
      callback(true);
    } else {
      callback(false);
    }
  });

  // Rate limiting for error recovery to prevent infinite loops
  const errorRecoveryTracker = new Map();
  const MAX_RECOVERY_ATTEMPTS = 3;
  const RECOVERY_COOLDOWN = 30000; // 30 seconds

  // Handle failed URL loads (e.g., ERR_NAME_NOT_RESOLVED)
  mainWindow.webContents.on('did-fail-load', (event, errorCode, errorDescription, validatedURL) => {
    //console.log('Failed to load URL:', validatedURL, 'Error:', errorDescription, 'Code:', errorCode);
    
    // Enhanced logging for debugging URL issues
    const parsedUrl = new URL(validatedURL);
    //console.log('Failed URL details:', {
    //    hostname: parsedUrl.hostname,
    //    pathname: parsedUrl.pathname,
    //    search: parsedUrl.search,
    //    hash: parsedUrl.hash,
    //    errorCode: errorCode,
    //    errorDescription: errorDescription
    // });
    
    // Create a unique key for this error type and URL
    const errorKey = `${errorCode}-${validatedURL}`;
    const now = Date.now();
    
    // Check if we've already tried to recover from this error recently
    if (errorRecoveryTracker.has(errorKey)) {
      const { attempts, lastAttempt } = errorRecoveryTracker.get(errorKey);
      
      // If we're still in cooldown period, don't attempt recovery
      if (now - lastAttempt < RECOVERY_COOLDOWN) {
        //console.log('Recovery cooldown active for:', errorKey);
        return;
      }
      
      // If we've exceeded max attempts, stop trying
      if (attempts >= MAX_RECOVERY_ATTEMPTS) {
        //console.log('Max recovery attempts exceeded for:', errorKey);
        // Clear the tracker entry after cooldown
        if (now - lastAttempt > RECOVERY_COOLDOWN) {
          errorRecoveryTracker.delete(errorKey);
        }
        return;
      }
      
      // Update attempt count
      errorRecoveryTracker.set(errorKey, { attempts: attempts + 1, lastAttempt: now });
    } else {
      // First attempt for this error
      errorRecoveryTracker.set(errorKey, { attempts: 1, lastAttempt: now });
    }
    
    // Handle different types of errors
    if (errorCode === -105 || errorDescription.includes('ERR_NAME_NOT_RESOLVED')) {
      //console.log('Domain not resolved, clearing stored subdomain and showing form again');
      
      // Extract subdomain from failed URL for error message
      const urlMatch = validatedURL.match(/https:\/\/(.+?)\.opticsify\.com/);
      const failedSubdomain = urlMatch ? urlMatch[1] : 'unknown';
      
      // Clear the invalid subdomain
      store.delete('customerSubdomain');
      
      // Show error dialog first, then show form
      showSubdomainErrorDialog(failedSubdomain);
      
      // Show the subdomain form after a brief delay
      setTimeout(() => {
        showSubdomainFormInMainWindow();
      }, 1000);
    } else if (errorCode === -3 || errorDescription.includes('ERR_ABORTED')) {
      // Navigation was aborted - this might be normal for some redirects
      //console.log('Navigation aborted - this might be normal for redirects or form submissions');
    } else if (errorCode === -400 || errorDescription.includes('ERR_CACHE_MISS')) {
      // Cache miss error - implement smart recovery with rate limiting
      //console.log('Cache miss error detected, attempting recovery (attempt:', errorRecoveryTracker.get(errorKey).attempts, ')');
      
      // Try recovery with increasing delays
      const recoveryDelay = errorRecoveryTracker.get(errorKey).attempts * 2000; // 2s, 4s, 6s
      
      setTimeout(() => {
        try {
          if (mainWindow && !mainWindow.isDestroyed()) {
            const currentURL = mainWindow.webContents.getURL();
            //console.log('Current URL during recovery:', currentURL);
            
            // If we're on the same failing URL, try alternative approaches
            if (currentURL === validatedURL || currentURL === 'about:blank' || currentURL === '') {
              const storedDomain = store.get('customerDomain');
              const storedSubdomain = store.get('customerSubdomain');
              
              if ((storedDomain || storedSubdomain) && errorRecoveryTracker.get(errorKey).attempts === 1) {
                // First attempt: try main domain
                const mainDomainURL = storedDomain || `https://${storedSubdomain}.opticsify.com`;
                //console.log('Attempting to navigate to main domain:', mainDomainURL);
                mainWindow.loadURL(mainDomainURL);
              } else if (mainWindow.webContents.navigationHistory.canGoBack() && errorRecoveryTracker.get(errorKey).attempts === 2) {
                // Second attempt: try going back with enhanced safety checks
                //console.log('Attempting to go back in history with safety checks');
                
                // Check if going back would lead to the same problematic URL
                try {
                  const history = mainWindow.webContents.navigationHistory;
                  const currentIndex = history.getActiveIndex();
                  
                  // Only go back if we have a reasonable chance of success
                  if (currentIndex > 0) {
                    // Try to go back, but with a timeout to prevent infinite loops
                    const backNavTimeout = setTimeout(() => {
                      //console.log('Back navigation timeout, falling back to main domain');
                      const storedDomain = store.get('customerDomain');
                      const storedSubdomain = store.get('customerSubdomain');
                      if (storedDomain) {
                        mainWindow.loadURL(storedDomain);
                      } else if (storedSubdomain) {
                        const mainDomainURL = `https://${storedSubdomain}.opticsify.com`;
                        mainWindow.loadURL(mainDomainURL);
                      } else {
                        showSubdomainFormInMainWindow();
                      }
                    }, 3000);
                    
                    // Set up a one-time success listener to clear the timeout
                    const backSuccessHandler = () => {
                      clearTimeout(backNavTimeout);
                      mainWindow.webContents.removeListener('did-finish-load', backSuccessHandler);
                    };
                    
                    mainWindow.webContents.once('did-finish-load', backSuccessHandler);
                    mainWindow.webContents.navigationHistory.goBack();
                  } else {
                    // Can't go back safely, use main domain fallback
                    const storedDomain = store.get('customerDomain');
                    const storedSubdomain = store.get('customerSubdomain');
                    if (storedDomain) {
                      mainWindow.loadURL(storedDomain);
                    } else if (storedSubdomain) {
                      const mainDomainURL = `https://${storedSubdomain}.opticsify.com`;
                      mainWindow.loadURL(mainDomainURL);
                    } else {
                      showSubdomainFormInMainWindow();
                    }
                  }
                } catch (backError) {
                  console.error('Error during enhanced back navigation:', backError);
                  // Fallback to main domain
                  const storedDomain = store.get('customerDomain');
                  const storedSubdomain = store.get('customerSubdomain');
                  if (storedDomain) {
                    mainWindow.loadURL(storedDomain);
                  } else if (storedSubdomain) {
                    const mainDomainURL = `https://${storedSubdomain}.opticsify.com`;
                    mainWindow.loadURL(mainDomainURL);
                  } else {
                    showSubdomainFormInMainWindow();
                  }
                }
              } else {
                // Final attempt: show subdomain form with enhanced error context
                //console.log('Final fallback: showing subdomain form with error context');
                
                // Store the error context for user feedback
                store.set('last_cache_miss_error', {
                  url: validatedURL,
                  timestamp: Date.now(),
                  attempts: errorRecoveryTracker.get(errorKey).attempts
                });
                
                showSubdomainFormInMainWindow();
              }
            }
          }
        } catch (recoveryError) {
          console.error('Error during cache miss recovery:', recoveryError);
          // Ultimate fallback with error logging
          //console.log('Ultimate fallback: showing subdomain form due to recovery error');
          showSubdomainFormInMainWindow();
        }
      }, recoveryDelay);
    } else {
      // Other errors - log for debugging
      //console.log('Other navigation error occurred:', errorCode, errorDescription);
      
      // For other errors, try a gentle recovery approach with rate limiting
      setTimeout(() => {
        try {
          if (mainWindow && !mainWindow.isDestroyed()) {
            const currentURL = mainWindow.webContents.getURL();
            
            // If we're on a blank page or problematic URL, try to recover
            if (currentURL === 'about:blank' || currentURL === '' || currentURL.includes('data:text/html')) {
              const storedDomain = store.get('customerDomain');
              const storedSubdomain = store.get('customerSubdomain');
              if (storedDomain) {
                //console.log('Recovering from blank page, navigating to:', storedDomain);
                mainWindow.loadURL(storedDomain);
              } else if (storedSubdomain) {
                const mainDomainURL = `https://${storedSubdomain}.opticsify.com`;
                //console.log('Recovering from blank page, navigating to:', mainDomainURL);
                mainWindow.loadURL(mainDomainURL);
              } else {
                showSubdomainFormInMainWindow();
              }
            }
          }
        } catch (recoveryError) {
          console.error('Error during general recovery:', recoveryError);
        }
      }, 1000);
    }
  });
}

// Create application menu
function createMenu() {
  // Get current language for menu translations
  const currentLanguage = store.get('language', 'en');
  const menuTranslations = {
    en: {
      file: 'File',
      checkForUpdates: 'Check for Updates',
      logoutAndChangeStore: 'Logout & Change Store',
      quit: 'Quit',
      edit: 'Edit',
      noUpdatesTitle: 'No Updates Available',
      noUpdatesText: 'You are running the latest version of Opticsify Desktop.',
      updateFailedTitle: 'Update Check Failed',
      updateFailedText: 'Failed to check for updates. Please try again later.',
      ok: 'OK'
    },
    ar: {
      file: 'ملف',
      checkForUpdates: 'التحقق من التحديثات',
      logoutAndChangeStore: 'تسجيل الخروج وتغيير المتجر',
      quit: 'خروج',
      edit: 'تحرير',
      noUpdatesTitle: 'لا توجد تحديثات متاحة',
      noUpdatesText: 'أنت تستخدم أحدث إصدار من Opticsify Desktop.',
      updateFailedTitle: 'فشل التحقق من التحديثات',
      updateFailedText: 'فشل التحقق من التحديثات. يرجى المحاولة مرة أخرى لاحقاً.',
      ok: 'موافق'
    }
  };
  
  const t = menuTranslations[currentLanguage] || menuTranslations.en;
  
  const template = [
    {
      label: t.file,
      submenu: [
        {
          label: t.checkForUpdates,
          click: async () => {
            if (mainWindow) {
              try {
                const result = await autoUpdater.checkForUpdates();
                if (!result || !result.updateInfo) {
                  // Show "no updates available" message
                  showSweetAlert({
                    icon: 'info',
                    title: t.noUpdatesTitle,
                    text: t.noUpdatesText,
                    confirmButtonText: t.ok,
                    confirmButtonColor: '#3B82F6'
                  });
                }
              } catch (error) {
                console.error('Manual update check error:', error);
                showSweetAlert({
                  icon: 'error',
                  title: t.updateFailedTitle,
                  text: t.updateFailedText + '\n\n' + error.message,
                  confirmButtonText: t.ok,
                  confirmButtonColor: '#EF4444'
                });
              }
            }
          }
        },
        { type: 'separator' },
        {
          label: t.logoutAndChangeStore,
          accelerator: 'CmdOrCtrl+Shift+L',
          click: () => {
            resetSubdomain();
          }
        },
        { type: 'separator' },
        {
          label: t.quit,
          accelerator: process.platform === 'darwin' ? 'Cmd+Q' : 'Ctrl+Q',
          click: () => {
            app.quit();
          }
        }
      ]
    },
    {
      label: t.edit,
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectall' }
      ]
    },
    {
      label: 'View',
      submenu: [
        {
          label: 'Reload',
          accelerator: 'CmdOrCtrl+R',
          click: () => {
            if (mainWindow) {
              const currentURL = mainWindow.webContents.getURL();
              console.log('Reloading page...', currentURL);
              
              // If on subdomain form (temp file or data URL), reload it properly
              if (currentURL.includes('opticsify-subdomain-form.html') || 
                  currentURL.startsWith('data:text/html') ||
                  currentURL.includes('tmpdir')) {
                console.log('Reloading subdomain form...');
                showSubdomainFormInMainWindow();
              } else {
                mainWindow.webContents.reload();
              }
            }
          }
        },
        {
          label: 'Force Reload',
          accelerator: 'CmdOrCtrl+Shift+R',
          click: () => {
            if (mainWindow) {
              const currentURL = mainWindow.webContents.getURL();
              console.log('Force reloading page (clearing cache)...', currentURL);
              
              // If on subdomain form (temp file or data URL), reload it properly
              if (currentURL.includes('opticsify-subdomain-form.html') || 
                  currentURL.startsWith('data:text/html') ||
                  currentURL.includes('tmpdir')) {
                console.log('Force reloading subdomain form...');
                // Clear cache before reloading form
                mainWindow.webContents.session.clearCache().then(() => {
                  console.log('Cache cleared, reloading subdomain form...');
                  showSubdomainFormInMainWindow();
                });
              } else {
                // Clear session cache before reloading
                mainWindow.webContents.session.clearCache().then(() => {
                  console.log('Cache cleared, reloading...');
                  mainWindow.webContents.reloadIgnoringCache();
                });
              }
            }
          }
        },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' }
      ]
    },
    {
      label: 'Window',
      submenu: [
        { role: 'minimize' },
        { role: 'close' }
      ]
    },
    {
      label: 'Help',
      submenu: [
        {
          label: 'About',
          click: () => {
            showSweetAlert({
              icon: 'info',
              title: 'About',
              html: '<strong>Opticsify Desktop App</strong><br><br>Desktop application for opticsify web platform',
              confirmButtonText: 'OK',
              confirmButtonColor: '#3B82F6'
            });
          }
        }
      ]
    }
  ];

  // macOS specific menu adjustments
  if (process.platform === 'darwin') {
    template.unshift({
      label: app.getName(),
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' }
      ]
    });

    // Window menu
    template[4].submenu = [
      { role: 'close' },
      { role: 'minimize' },
      { role: 'zoom' },
      { type: 'separator' },
      { role: 'front' }
    ];
  }

  const menu = Menu.buildFromTemplate(template);
  Menu.setApplicationMenu(menu);
}

// App event handlers
app.whenReady().then(() => {
  // Block all media device access globally BEFORE creating any windows
  const { session } = require('electron');
  const allSessions = [session.defaultSession, session.fromPartition('persist:opticsify-session')];
  
  allSessions.forEach(sess => {
    // Allow camera/media and clipboard; deny everything else
    sess.setPermissionCheckHandler((webContents, permission) => {
      const allowed = ['media', 'microphone', 'camera', 'clipboard-read', 'clipboard-sanitized-write'];
      return allowed.includes(permission);
    });

    sess.setPermissionRequestHandler((webContents, permission, callback) => {
      const allowed = ['media', 'mediaKeySystem', 'clipboard-read', 'clipboard-sanitized-write'];
      callback(allowed.includes(permission));
    });
  });
  
  // Register custom protocol for serving fonts — must be registered for every
  // session that loads font:// URLs (default + the persistent opticsify session).
  const fontProtocolHandler = (request, callback) => {
    const raw = request.url.replace(/^fonts:\/\//, '').replace(/\/$/, '');
    const fontName = decodeURIComponent(raw);
    const fontPath = path.join(__dirname, 'assets', 'fonts', fontName);
    if (fs.existsSync(fontPath)) {
      callback({ path: fontPath });
    } else {
      console.error('Font file not found:', fontPath);
      callback({ error: -6 }); // FILE_NOT_FOUND
    }
  };

  protocol.registerFileProtocol('fonts', fontProtocolHandler);
  session.fromPartition('persist:opticsify-session').protocol.registerFileProtocol('fonts', fontProtocolHandler);
  
  // Configure session for better login state persistence
  const opticsifySession = session.fromPartition('persist:opticsify-session');
  
  // Configure POST data preservation using webRequest API
  opticsifySession.webRequest.onBeforeSendHeaders({ urls: ['*://*.opticsify.com/*'] }, (details, callback) => {
    ////console.log('Request intercepted:', details.method, details.url);
    
    // Log POST data if available
    if (details.method === 'POST' && details.uploadData) {
      ////console.log('POST data detected:', details.uploadData.length, 'bytes');
      
      // Store POST data temporarily for potential re-submission
      const postDataKey = `post_data_${Date.now()}`;
      store.set(postDataKey, {
        url: details.url,
        uploadData: details.uploadData,
        timestamp: Date.now()
      });
      
      // Clean up old POST data (older than 5 minutes)
      const allKeys = Object.keys(store.store);
      const fiveMinutesAgo = Date.now() - (5 * 60 * 1000);
      allKeys.forEach(key => {
        if (key.startsWith('post_data_') && store.get(key)?.timestamp < fiveMinutesAgo) {
          store.delete(key);
        }
      });
    }
    
    callback({ requestHeaders: details.requestHeaders });
  });
  
  // Intercept responses to handle redirects with POST data
  opticsifySession.webRequest.onBeforeRedirect({ urls: ['*://*.opticsify.com/*'] }, (details) => {
    ////console.log('Redirect intercepted:', details.statusCode, details.redirectURL);
    
    if (details.method === 'POST') {
      ////console.log('POST request being redirected, preserving data context');
      
      // Store redirect context for potential data recovery
      store.set('last_post_redirect', {
        fromUrl: details.url,
        toUrl: details.redirectURL,
        timestamp: Date.now()
      });
    }
  });
  
  // Allow camera/media and standard web permissions
  opticsifySession.setPermissionRequestHandler((webContents, permission, callback) => {
    const allowed = ['media', 'mediaKeySystem', 'notifications', 'clipboard-read', 'clipboard-sanitized-write', 'fullscreen', 'display-capture'];
    callback(allowed.includes(permission));
  });

  opticsifySession.setPermissionCheckHandler((webContents, permission) => {
    const allowed = ['media', 'microphone', 'camera', 'notifications', 'clipboard-read', 'clipboard-sanitized-write', 'fullscreen', 'display-capture'];
    return allowed.includes(permission);
  });

  // Configure session to persist login data
  opticsifySession.setUserAgent(opticsifySession.getUserAgent() + ' opticsifyDesktop/1.0.0');
  
  // Configure protocol handler for better form data persistence
  opticsifySession.protocol.registerHttpProtocol('opticsify-session', (request, callback) => {
    // Handle session-specific requests
    callback({ url: request.url });
  });
  
  // Enable form data persistence
  opticsifySession.setDownloadPath(app.getPath('userData'));
  
  // Force enable credential storage
  opticsifySession.setUserAgent(opticsifySession.getUserAgent().replace('Electron', 'Chrome'));
  
  // Configure session for autofill and password saving
  opticsifySession.webContents?.on('dom-ready', () => {
    // Inject autofill enablement script
    opticsifySession.webContents.executeJavaScript(`
      // Enable autofill attributes
      document.querySelectorAll('input[type="password"], input[type="email"], input[type="text"]').forEach(input => {
        if (!input.getAttribute('autocomplete')) {
          if (input.type === 'password') {
            input.setAttribute('autocomplete', 'current-password');
          } else if (input.type === 'email') {
            input.setAttribute('autocomplete', 'email');
          } else if (input.name && input.name.toLowerCase().includes('user')) {
            input.setAttribute('autocomplete', 'username');
          }
        }
      });
    `).catch(err => {
      console.log('Could not inject autofill script:', err);
    });
  });
  
  // Ensure cookies are properly saved and loaded with subdomain sharing
  const flushPromise = opticsifySession.cookies.flushStore ? opticsifySession.cookies.flushStore() : Promise.resolve();
  flushPromise.then(() => {
    ////console.log('Cookie store initialized for persistent storage');
    
    // Configure cookie sharing for subdomains
    opticsifySession.cookies.on('changed', (event, cookie, cause, removed) => {
      if (!removed && cookie.domain && cookie.domain.includes('opticsify.com')) {
        // Only process cookies that aren't already shared
        if (!cookie.domain.startsWith('.')) {
          try {
            // Set the cookie for subdomain sharing with proper URL
            const cookieUrl = cookie.secure ? 'https://' : 'http://';
            const baseDomain = cookie.domain.replace(/^[^.]*\./, ''); // Remove subdomain part
            
            opticsifySession.cookies.set({
              url: cookieUrl + baseDomain,
              name: cookie.name,
              value: cookie.value,
              domain: '.' + baseDomain,
              path: cookie.path || '/',
              secure: cookie.secure || false,
              httpOnly: cookie.httpOnly || false,
              expirationDate: cookie.expirationDate
            }).catch(err => {
              // Silently handle cookie setting errors to avoid spam
              if (err.message && !err.message.includes('invalid Domain')) {
                console.log('Error setting shared cookie:', err.message);
              }
            });
          } catch (err) {
            // Silently handle parsing errors
          }
        }
      }
    });
  }).catch(err => {
    console.error('Error initializing cookie store:', err);
  });
  
  // Ensure all session storage is properly initialized
  try {
    if (opticsifySession.flushStorageData && typeof opticsifySession.flushStorageData === 'function') {
      const flushResult = opticsifySession.flushStorageData();
      if (flushResult && typeof flushResult.then === 'function') {
        flushResult.then(() => {
          ////console.log('Session storage initialized for persistent data');
        }).catch(err => {
          console.error('Error initializing session storage:', err);
        });
      }
    } else {
      ////console.log('flushStorageData not available in this Electron version');
    }
  } catch (err) {
    console.error('flushStorageData error:', err);
  }
  
  // Configure cache settings - DON'T clear cache to preserve login state
  // opticsifySession.clearCache().then(() => {
  //   ////console.log('Cache cleared on startup for fresh session state');
  // });
  
  createWindow();
  createMenu();
  createTray();
  
  // Register DevTools keyboard shortcuts (always available)
  globalShortcut.register('CommandOrControl+Alt+]', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.openDevTools();
    }
  });

  globalShortcut.register('CommandOrControl+Shift+I', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.openDevTools();
    }
  });

  // F12 as an additional shortcut for inspect element
  globalShortcut.register('F12', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.openDevTools();
    }
  });
  
  // Disable hardware acceleration for better compatibility (optional)
  // app.disableHardwareAcceleration();
  
  // Set app user model ID for Windows
  if (process.platform === 'win32') {
    app.setAppUserModelId('com.opticsify.desktop');
  }
  
  // Note: --max-old-space-size must be set before V8 initializes (before app.whenReady),
  // so it cannot be applied here.

  app.on('activate', () => {
    // On macOS, re-create window when dock icon is clicked
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
}).catch((error) => {
  console.error('Error during app initialization:', error);
  app.quit();
});

app.on('will-quit', () => {
  // Unregister all global shortcuts
  globalShortcut.unregisterAll();
  console.log('Global shortcuts unregistered');
});

app.on('window-all-closed', () => {
  // Ensure session data is saved before closing
  const { session } = require('electron');
  const opticsifySession = session.fromPartition('persist:opticsify-session');
  
  // Force save cookies and session data before quitting
  Promise.all([
    opticsifySession.cookies.flushStore(),
    // Only flush storage data if the method exists
    opticsifySession.flushStorageData ? opticsifySession.flushStorageData() : Promise.resolve()
  ]).then(() => {
    ////console.log('Session data and storage saved before app close');
    
    // Don't quit the app if tray exists - let it run in the background
    // Only quit if app.isQuitting flag is set (from tray "Quit" option)
    if (!app.isQuitting && tray) {
      // Keep app running in tray
      return;
    }
    
    // On macOS, keep app running even when all windows are closed
    if (process.platform !== 'darwin') {
      app.quit();
    }
  }).catch(err => {
    console.error('Error saving session data:', err);
    
    // Same quit logic for error case
    if (!app.isQuitting && tray) {
      return;
    }
    
    if (process.platform !== 'darwin') {
      app.quit();
    }
  });
});

// Security: Handle new window creation - keep all pages in same window
app.on('web-contents-created', (event, contents) => {
  contents.on('new-window', (event, navigationUrl) => {
    const parsedUrl = new URL(navigationUrl);
    
    // Check for social media URLs and open them in the system browser (Chrome)
    const socialMediaDomains = ['whatsapp.com', 'wa.me', 'facebook.com', 'twitter.com', 'x.com', 'linkedin.com', 't.me', 'telegram.org'];
    if (socialMediaDomains.some(domain => parsedUrl.hostname.includes(domain))) {
      //console.log('Social media link in new window detected - opening in system browser:', navigationUrl);
      event.preventDefault();
      shell.openExternal(navigationUrl);
      return;
    }
    
    // CHECK PRINT PAGES FIRST - Allow print pages to open in new windows (don't prevent)
    if (navigationUrl.includes('/print/') || navigationUrl.includes('/print')) {
      //console.log('Print page detected - allowing new window:', navigationUrl);
      // Don't prevent default - let it open in a new window naturally
      return;
    }
    
    // Keep all other opticsify.com links in the SAME window (no new tabs)
    if (parsedUrl.hostname.endsWith('opticsify.com')) {
      //console.log('opticsify link - loading in same window:', navigationUrl);
      event.preventDefault();
      // Navigate in the current window
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.loadURL(navigationUrl);
      }
      return;
    }
    
    // Only prevent default for truly external links
    event.preventDefault();
    
    // Open external links in system browser
    shell.openExternal(navigationUrl);
  });
});

// Handle app protocol for deep linking (optional)
app.setAsDefaultProtocolClient('opticsify');

// Remove the problematic electron:// protocol handler
// This prevents the "No application set to open the URL electron://localhost" error
