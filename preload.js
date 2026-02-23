const { contextBridge, ipcRenderer } = require('electron');

// Expose protected methods that allow the renderer process to use
// the ipcRenderer without exposing the entire object
contextBridge.exposeInMainWorld('electronAPI', {
  openExternal: (url) => ipcRenderer.invoke('open-external', url),
  getVersion: () => ipcRenderer.invoke('get-version'),
  platform: String(process.platform),
  
  // Logo functionality
  getLogo: () => ipcRenderer.invoke('get-logo'),
  
  // Background SVG functionality
  getBackgroundSVG: () => ipcRenderer.invoke('get-background-svg'),
  
  // SweetAlert2 functionality
  showSweetAlert: (options) => ipcRenderer.invoke('show-sweet-alert', options),
  
  // Language functionality
  setLanguage: (language) => ipcRenderer.invoke('set-language', language),
  getLanguage: () => ipcRenderer.invoke('get-language'),
  
  // Subdomain functionality
  getSubdomain: () => ipcRenderer.invoke('get-subdomain'),
  
  // Back button functionality
  checkCanGoBack: async () => {
    //console.log('Preload: checkCanGoBack called');
    try {
      const result = await ipcRenderer.invoke('check-can-go-back');
      //console.log('Preload: checkCanGoBack result:', result);
      return result.canGoBack;
    } catch (error) {
      console.error('Preload: checkCanGoBack error:', error);
      return false;
    }
  },
  goBack: async () => {
    //console.log('Preload: goBack called');
    try {
      const result = await ipcRenderer.invoke('go-back');
      //console.log('Preload: goBack result:', result);
      return result.success;
    } catch (error) {
      console.error('Preload: goBack error:', error);
      return false;
    }
  },
  
  // Update functionality
  checkForUpdates: async () => {
    //console.log('Preload: checkForUpdates called');
    try {
      const result = await ipcRenderer.invoke('check-for-updates');
      //console.log('Preload: checkForUpdates result:', result);
      return result;
    } catch (error) {
      console.error('Preload: checkForUpdates error:', error);
      return { success: false, error: error.message };
    }
  },
  downloadUpdate: async () => {
    //console.log('Preload: downloadUpdate called');
    try {
      const result = await ipcRenderer.invoke('download-update');
      //console.log('Preload: downloadUpdate result:', result);
      return result;
    } catch (error) {
      console.error('Preload: downloadUpdate error:', error);
      return { success: false, error: error.message };
    }
  },
  installUpdate: async () => {
    //console.log('Preload: installUpdate called');
    try {
      const result = await ipcRenderer.invoke('install-update');
      //console.log('Preload: installUpdate result:', result);
      return result;
    } catch (error) {
      console.error('Preload: installUpdate error:', error);
      return { success: false, error: error.message };
    }
  },
  openInstaller: async (filePath) => {
    //console.log('Preload: openInstaller called');
    try {
      const result = await ipcRenderer.invoke('open-installer', filePath);
      //console.log('Preload: openInstaller result:', result);
      return result;
    } catch (error) {
      console.error('Preload: openInstaller error:', error);
      return { success: false, error: error.message };
    }
  },
  getAppVersion: async () => {
    //console.log('Preload: getAppVersion called');
    try {
      const result = await ipcRenderer.invoke('get-app-version');
      //console.log('Preload: getAppVersion result:', result);
      return result;
    } catch (error) {
      console.error('Preload: getAppVersion error:', error);
      return null;
    }
  },
  
  // Update event listeners
  onUpdateAvailable: (callback) => {
    ipcRenderer.on('update-available', (event, info) => callback(info));
  },
  onUpdateNotAvailable: (callback) => {
    ipcRenderer.on('update-not-available', (event, info) => callback(info));
  },
  onUpdateError: (callback) => {
    ipcRenderer.on('update-error', (event, error) => callback(error));
  },
  onUpdateDownloadProgress: (callback) => {
    ipcRenderer.on('update-download-progress', (event, progress) => callback(progress));
  },
  onDownloadProgress: (callback) => {
    ipcRenderer.on('download-progress', (event, progress) => callback(progress));
  },
  onUpdateDownloaded: (callback) => {
    ipcRenderer.on('update-downloaded', (event, info) => callback(info));
  },

  // Print functionality
  printPage: async (options = {}) => {
    //console.log('Preload: printPage called with options:', options);
    try {
      const result = await ipcRenderer.invoke('print-page', options);
      //console.log('Preload: printPage result:', result);
      return result;
    } catch (error) {
      console.error('Preload: printPage error:', error);
      return { success: false, error: error.message };
    }
  },
  printPreview: async () => {
    //console.log('Preload: printPreview called');
    try {
      const result = await ipcRenderer.invoke('print-preview');
      //console.log('Preload: printPreview result:', result);
      return result;
    } catch (error) {
      console.error('Preload: printPreview error:', error);
      return { success: false, error: error.message };
    }
  },
  
  // Add function to access print version of current page
  accessPrintVersion: async () => {
    //console.log('Preload: accessPrintVersion called');
    try {
      const currentUrl = window.location.href;
      //console.log('Current URL:', currentUrl);
      
      // Try different print URL patterns
      const printUrls = [
        currentUrl + 'print/',
        currentUrl.replace(/\/$/, '') + '/print/',
        currentUrl.replace(/\/([^\/]+)\/$/, '/print/$1/'),
        currentUrl.replace(/https:\/\/([^\/]+)/, 'https://$1/print')
      ];
      
      //console.log('Trying print URLs:', printUrls);
      
      // Try to open print version in a new window
      for (const printUrl of printUrls) {
        try {
          const printWindow = window.open(printUrl, '_blank', 'width=1200,height=800');
          if (printWindow) {
            //console.log('Print version opened:', printUrl);
            return { success: true, url: printUrl };
          }
        } catch (error) {
          //console.log('Failed to open print URL:', printUrl, error);
        }
      }
      
      return { success: false, error: 'Could not access print version' };
    } catch (error) {
      console.error('Preload: accessPrintVersion error:', error);
      return { success: false, error: error.message };
    }
  },

  // Navigation events
  onNavigate: (callback) => {
    ipcRenderer.on('navigate', callback);
    // Return cleanup function
    return () => ipcRenderer.removeListener('navigate', callback);
  },
  
  // Form submission for subdomain
  submitSubdomain: async (subdomain) => {
    //console.log('Preload: submitSubdomain called with:', subdomain);
    try {
      const result = await ipcRenderer.invoke('submit-subdomain', subdomain);
      //console.log('Preload: submitSubdomain result:', result);
      return result;
    } catch (error) {
      console.error('Preload: submitSubdomain error:', error);
      return { success: false, error: error.message };
    }
  },
  
  resetSubdomain: async () => {
    //console.log('Preload: resetSubdomain called');
    try {
      await ipcRenderer.invoke('reset-subdomain');
      //console.log('Preload: resetSubdomain completed');
      return { success: true };
    } catch (error) {
      console.error('Preload: resetSubdomain error:', error);
      return { success: false, error: error.message };
    }
  },
  
  // Send message to dialog
  sendMessage: async (channelId, data) => {
    //console.log('Preload: sendMessage called with channelId:', channelId, 'data:', data);
    try {
      // Ensure data is serializable
      const serializableData = JSON.parse(JSON.stringify(data));
      //console.log('Preload: sendMessage serialized data:', serializableData);
      
      const result = await ipcRenderer.invoke('dialog-message', channelId, serializableData);
      //console.log('Preload: sendMessage result:', result);
      return result;
    } catch (error) {
      console.error('Preload: sendMessage error:', error);
      return { success: false, error: error.message };
    }
  },
  
  // POST data recovery functionality
  getStoredPostData: async (url) => {
    //console.log('Preload: getStoredPostData called for URL:', url);
    try {
      const result = await ipcRenderer.invoke('get-stored-post-data', url);
      //console.log('Preload: getStoredPostData result:', result);
      return result;
    } catch (error) {
      console.error('Preload: getStoredPostData error:', error);
      return { success: false, error: error.message };
    }
  },
  
  // Check for POST redirect context
  getPostRedirectContext: async () => {
    //console.log('Preload: getPostRedirectContext called');
    try {
      const result = await ipcRenderer.invoke('get-post-redirect-context');
      //console.log('Preload: getPostRedirectContext result:', result);
      return result;
    } catch (error) {
      console.error('Preload: getPostRedirectContext error:', error);
      return { success: false, error: error.message };
    }
  },
  
  // Listen for popstate events
  onPopstate: (callback) => {
    window.addEventListener('popstate', callback);
    return () => window.removeEventListener('popstate', callback);
  },
  
  // Domain History Management
  getDomainHistory: async () => {
    try {
      const result = await ipcRenderer.invoke('get-domain-history');
      return result;
    } catch (error) {
      console.error('Preload: getDomainHistory error:', error);
      return [];
    }
  },
  
  deleteDomainHistory: async (index) => {
    try {
      const result = await ipcRenderer.invoke('delete-domain-history', index);
      return result;
    } catch (error) {
      console.error('Preload: deleteDomainHistory error:', error);
      return { success: false, error: error.message };
    }
  },
  
  clearDomainHistory: async () => {
    try {
      const result = await ipcRenderer.invoke('clear-domain-history');
      return result;
    } catch (error) {
      console.error('Preload: clearDomainHistory error:', error);
      return { success: false, error: error.message };
    }
  },
  
  // Change Store / Logout functionality
  changeStore: async () => {
    try {
      const result = await ipcRenderer.invoke('change-store');
      return result;
    } catch (error) {
      console.error('Preload: changeStore error:', error);
      return { success: false, error: error.message };
    }
  },
  
  // Login credentials autofill
  saveLoginCredentials: async (credentials) => {
    try {
      const result = await ipcRenderer.invoke('save-login-credentials', credentials);
      return result;
    } catch (error) {
      console.error('Preload: saveLoginCredentials error:', error);
      return { success: false, error: error.message };
    }
  },
  
  getLoginCredentials: async (domain) => {
    try {
      const result = await ipcRenderer.invoke('get-login-credentials', domain);
      return result;
    } catch (error) {
      console.error('Preload: getLoginCredentials error:', error);
      return { success: false, error: error.message };
    }
  }
});

// Prevent the renderer process from accessing Node.js APIs
window.addEventListener('DOMContentLoaded', () => {
  //console.log('Opticsify Desktop App loaded - DOMContentLoaded fired');
  
  // Intercept clicks on links with target="_blank" - allow them to open in new tabs naturally
  document.addEventListener('click', (event) => {
    const link = event.target.closest('a');
    if (link) {
      const href = link.href;
      const target = link.target;
      //console.log('Link clicked:', {
      //   href: href,
      //   target: target,
      //   tagName: link.tagName,
      //   innerHTML: link.innerHTML.substring(0, 100)
      // });
      
      // Allow all _blank links to open in new tabs naturally
      // Remove the forced same-window navigation that was causing cache miss errors
      if (target === '_blank' && href && href.includes('opticsify.com')) {
        //console.log('Allowing _blank link to open in new tab:', href);
        // Let the link open naturally in a new tab - don't prevent default
        return true;
      }
    }
  }, true); // Use capture phase to intercept before other handlers
  
  // Intercept form submissions that might open in new tabs
  document.addEventListener('submit', (event) => {
    const form = event.target;
    if (form && form.tagName === 'FORM') {
      const target = form.target;
      const action = form.action;
      const method = form.method.toLowerCase();
      
      //console.log('Form submission intercepted:', {
      //   action: action,
      //   method: method,
      //   target: target,
      //   hasopticsifyAction: action.includes('opticsify.com')
      // });
      
      // If this is a POST form that targets a new window/tab and goes to opticsify.com
      if (method === 'post' && target === '_blank' && action.includes('opticsify.com')) {
        //console.log('POST form with _blank target to opticsify.com detected');
        
        // Let the form submission proceed normally - the setWindowOpenHandler will capture the POST data
        // No need to prevent default here as we want the normal form submission flow
      }
    }
  }, true);
  
  // Check for POST redirect context and handle data recovery
  if (window.electronAPI && window.electronAPI.getPostRedirectContext) {
    //console.log('electronAPI available, checking for POST redirect context...');
    //console.log('Current page URL:', window.location.href);
    //console.log('Page title:', document.title);
    //console.log('Timestamp:', new Date().toISOString());
    
    window.electronAPI.getPostRedirectContext().then(result => {
      //console.log('getPostRedirectContext result:', result);
      if (result.success && result.context) {
        //console.log('POST redirect context found:', result.context);
        //console.log('Context timestamp:', new Date(result.context.timestamp).toISOString());
        //console.log('Time since context created:', Date.now() - result.context.timestamp, 'ms');
        
        // Check if current URL matches the redirect URL
        const currentUrl = window.location.href;
        //console.log('Checking URL match - Current:', currentUrl, 'Expected:', result.context.url);
        //console.log('URLs match exactly:', currentUrl === result.context.url);
        //console.log('URLs match (normalized):', currentUrl.replace(/\/$/, '') === result.context.url.replace(/\/$/, ''));
        
        if (currentUrl === result.context.url || currentUrl.replace(/\/$/, '') === result.context.url.replace(/\/$/, '')) {
          //console.log('Current page matches POST redirect URL, attempting to restore POST data');
          
          // Get the stored POST data using the postDataKey from context
          if (result.context.postDataKey) {
            window.electronAPI.getStoredPostData(result.context.url).then(postResult => {
              if (postResult.success && postResult.postData) {
                //console.log('POST data recovered for new tab navigation');
                
                // Create a form with the POST data and submit it
                const form = document.createElement('form');
                form.method = 'POST';
                form.action = result.context.url;
                form.style.display = 'none';
                
                // Decode the base64 POST data
                try {
                  const postDataString = atob(postResult.postData.postData);
                  //console.log('Decoded POST data length:', postDataString.length);
                  
                  // Parse the POST data (assuming it's URL-encoded)
                  const params = new URLSearchParams(postDataString);
                  //console.log('Parsed POST parameters:', Array.from(params.entries()));
                  
                  for (const [key, value] of params) {
                    const input = document.createElement('input');
                    input.type = 'hidden';
                    input.name = key;
                    input.value = value;
                    form.appendChild(input);
                  }
                  
                  document.body.appendChild(form);
                  //console.log('Resubmitting POST data for new tab navigation');
                  
                  // Small delay to ensure DOM is ready
                  setTimeout(() => {
                    form.submit();
                  }, 100);
                  
                } catch (error) {
                  console.error('Error parsing POST data:', error);
                  // Fallback: dispatch custom event with raw data
                  const event = new CustomEvent('postDataRecovered', {
                    detail: {
                      url: result.context.url,
                      postData: postResult.postData
                    }
                  });
                  document.dispatchEvent(event);
                }
              } else {
                //console.log('No POST data found for URL:', result.context.url);
              }
            }).catch(error => {
              console.error('Error recovering POST data:', error);
            });
          }
        }
      }
    }).catch(error => {
      console.error('Error checking POST redirect context:', error);
    });
  } else {
    //console.log('electronAPI not available or getPostRedirectContext method missing');
  }
  
  // Override window.print to use our safe print handler
  const originalPrint = window.print;
  window.print = function() {
    //console.log('Window.print() called - using safe Electron print handler');
    
    // Prevent the default web print behavior that causes crashes
    if (window.electronAPI && window.electronAPI.printPage) {
      // Use our safe print handler with confirmation dialog
      window.electronAPI.printPage({ showDialog: true }).then(result => {
        if (result.success) {
          //console.log('Print completed successfully');
        } else if (result.error !== 'Print cancelled by user') {
          console.error('Print failed:', result.error);
          // Only show fallback if it wasn't cancelled by user
          console.warn('Print handler failed, but not attempting fallback to prevent crashes');
        }
      }).catch(error => {
        console.error('Print handler error:', error);
        console.warn('Print handler error occurred, not attempting fallback to prevent crashes');
      });
    } else {
      console.warn('electronAPI not available - print functionality disabled to prevent crashes');
      // Don't use original print as it causes crashes
      alert('Print functionality is not available in this application.');
    }
  };
  
  // Also override Ctrl+P keyboard shortcut
  document.addEventListener('keydown', function(event) {
    if ((event.ctrlKey || event.metaKey) && event.key === 'p') {
      event.preventDefault();
      //console.log('Ctrl+P intercepted - using safe print handler');
      window.print(); // This will call our overridden function
    }
  });
});
