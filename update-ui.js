// Update UI System for Opticsify Desktop
(function() {
    'use strict';
    
    let updateNotification = null;
    let updateInfo = null;
    let isDownloading = false;
    let currentLanguage = 'en';
    let downloadedFilePath = null;
    
    // Translation strings
    const translations = {
        en: {
            updateAvailable: 'Update Available',
            updateMessage: 'A new version of Opticsify Desktop is available.',
            version: 'Version',
            later: 'Later',
            download: 'Download',
            updateDownloaded: 'Update Downloaded',
            downloadedMessage: 'The update has been downloaded and is ready to install.',
            installRestart: 'Install & Restart',
            installDirectly: 'Install Directly',
            updateError: 'Update Error',
            close: 'Close',
            downloadingUpdate: 'Downloading update...',
            downloadStarted: 'Download started in your browser',
            readyToInstall: 'Ready to install. Click below to open the installer.'
        },
        ar: {
            updateAvailable: 'تحديث متاح',
            updateMessage: 'إصدار جديد من Opticsify Desktop متاح.',
            version: 'الإصدار',
            later: 'لاحقاً',
            download: 'تحميل',
            updateDownloaded: 'تم تحميل التحديث',
            downloadedMessage: 'تم تحميل التحديث وهو جاهز للتثبيت.',
            installRestart: 'تثبيت وإعادة تشغيل',
            installDirectly: 'تثبيت مباشرة',
            updateError: 'خطأ في التحديث',
            close: 'إغلاق',
            downloadingUpdate: 'جاري تحميل التحديث...',
            downloadStarted: 'بدأ التحميل في المتصفح',
            readyToInstall: 'جاهز للتثبيت. انقر أدناه لفتح المثبت.'
        }
    };
    
    // Get current language
    async function getCurrentLanguage() {
        try {
            if (window.electronAPI && window.electronAPI.getLanguage) {
                currentLanguage = await window.electronAPI.getLanguage() || 'en';
            }
        } catch (error) {
            currentLanguage = 'en';
        }
        return currentLanguage;
    }
    
    // Get translated text
    function t(key) {
        return translations[currentLanguage] && translations[currentLanguage][key] 
            ? translations[currentLanguage][key] 
            : translations.en[key] || key;
    }
    
    // Create update notification UI
    async function createUpdateNotification() {
        if (updateNotification) return;
        
        // Get current language first
        await getCurrentLanguage();
        
        updateNotification = document.createElement('div');
        updateNotification.id = 'opticsify-update-notification';
        updateNotification.innerHTML = `
            <div class="update-content">
                <div class="update-icon">🔄</div>
                <div class="update-text">
                    <div class="update-title">${t('updateAvailable')}</div>
                    <div class="update-message">${t('updateMessage')}</div>
                    <div class="update-version"></div>
                </div>
                <div class="update-actions">
                    <button class="update-btn update-btn-secondary" id="update-later">${t('later')}</button>
                    <button class="update-btn update-btn-primary" id="update-download">${t('download')}</button>
                </div>
            </div>
            <div class="update-progress" style="display: none;">
                <div class="progress-bar">
                    <div class="progress-fill"></div>
                </div>
                <div class="progress-text">${t('downloadingUpdate')}</div>
            </div>
        `;
        
        // Add CSS styles
        const style = document.createElement('style');
        style.textContent = `
            #opticsify-update-notification {
                position: fixed !important;
                top: 20px !important;
                right: 20px !important;
                width: 350px !important;
                background: #ffffff !important;
                border: 1px solid #e0e0e0 !important;
                border-radius: 8px !important;
                box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15) !important;
                z-index: 999999 !important;
                font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif !important;
                font-size: 14px !important;
                color: #333 !important;
                animation: slideInRight 0.3s ease-out !important;
                direction: ltr !important;
            }
            
            #opticsify-update-notification[dir="rtl"] {
                direction: rtl !important;
                left: 20px !important;
                right: auto !important;
                animation: slideInLeft 0.3s ease-out !important;
            }
            
            @keyframes slideInRight {
                from {
                    transform: translateX(100%) !important;
                    opacity: 0 !important;
                }
                to {
                    transform: translateX(0) !important;
                    opacity: 1 !important;
                }
            }
            
            @keyframes slideInLeft {
                from {
                    transform: translateX(-100%) !important;
                    opacity: 0 !important;
                }
                to {
                    transform: translateX(0) !important;
                    opacity: 1 !important;
                }
            }
            
            .update-content {
                padding: 16px !important;
                display: flex !important;
                align-items: flex-start !important;
                gap: 12px !important;
            }
            
            .update-icon {
                font-size: 24px !important;
                flex-shrink: 0 !important;
            }
            
            .update-text {
                flex: 1 !important;
            }
            
            .update-title {
                font-weight: 600 !important;
                margin-bottom: 4px !important;
                color: #1a1a1a !important;
            }
            
            .update-message {
                color: #666 !important;
                margin-bottom: 8px !important;
                line-height: 1.4 !important;
            }
            
            .update-version {
                font-size: 12px !important;
                color: #888 !important;
            }
            
            .update-actions {
                display: flex !important;
                gap: 8px !important;
                margin-top: 12px !important;
            }
            
            .update-btn {
                padding: 6px 12px !important;
                border: none !important;
                border-radius: 4px !important;
                font-size: 12px !important;
                font-weight: 500 !important;
                cursor: pointer !important;
                transition: all 0.2s ease !important;
            }
            
            .update-btn-primary {
                background: #7367f0 !important;
                color: white !important;
            }
            
            .update-btn-primary:hover {
                background: #5e50ee !important;
            }
            
            .update-btn-secondary {
                background: #f8f9fa !important;
                color: #666 !important;
                border: 1px solid #e0e0e0 !important;
            }
            
            .update-btn-secondary:hover {
                background: #e9ecef !important;
            }
            
            .update-progress {
                padding: 16px !important;
                border-top: 1px solid #e0e0e0 !important;
            }
            
            .progress-bar {
                width: 100% !important;
                height: 8px !important;
                background: #f0f0f0 !important;
                border-radius: 4px !important;
                overflow: hidden !important;
                margin-bottom: 8px !important;
                border: 1px solid #e0e0e0 !important;
            }
            
            .progress-fill {
                height: 100% !important;
                background: linear-gradient(90deg, #7367f0 0%, #9e95f5 100%) !important;
                width: 0%;
                transition: width 0.2s linear !important;
                min-width: 2% !important;
            }
            
            .progress-text {
                font-size: 12px !important;
                color: #666 !important;
                text-align: center !important;
            }
            
            .download-info {
                margin-top: 8px !important;
            }
            
            .download-info small {
                font-size: 11px !important;
                color: #888 !important;
                word-break: break-all !important;
            }
        `;
        
        document.head.appendChild(style);
        
        // Set direction based on current language
        if (currentLanguage === 'ar') {
            updateNotification.setAttribute('dir', 'rtl');
        }
        
        document.body.appendChild(updateNotification);
        
        // Add event listeners
        document.getElementById('update-later').addEventListener('click', hideUpdateNotification);
        document.getElementById('update-download').addEventListener('click', downloadUpdate);
    }
    
    // Show update notification
    async function showUpdateNotification(info) {
        updateInfo = info;
        await createUpdateNotification();
        
        if (info.version) {
            document.querySelector('.update-version').textContent = `${t('version')} ${info.version}`;
        }
        
        updateNotification.style.display = 'block';
    }
    
    // Hide update notification
    function hideUpdateNotification() {
        if (updateNotification) {
            updateNotification.style.display = 'none';
        }
    }
    
    // Download update
    async function downloadUpdate() {
        if (isDownloading) return;
        
        isDownloading = true;
        const downloadBtn = updateNotification.querySelector('#update-download');
        const laterBtn = updateNotification.querySelector('#update-later');
        const progressDiv = updateNotification.querySelector('.update-progress');
        
        // Show progress
        downloadBtn.style.display = 'none';
        if (laterBtn) laterBtn.style.display = 'none';
        progressDiv.style.display = 'block';
        
        // Initialize progress bar
        const progressFill = updateNotification.querySelector('.progress-fill');
        const progressText = updateNotification.querySelector('.progress-text');
        if (progressFill && progressText) {
            progressFill.style.width = '0%';
            progressText.textContent = `${t('downloadingUpdate')} 0%`;
            console.log('Progress bar initialized');
        }
        
        try {
            const result = await window.electronAPI.downloadUpdate();
            console.log('Download result:', result);
            
            if (result.success && result.filePath) {
                // Store the downloaded file path
                downloadedFilePath = result.filePath;
                
                // Show "Install Directly" button
                await showInstallerReady(result);
            } else {
                throw new Error('Download failed: No file path returned');
            }
        } catch (error) {
            console.error('Download error:', error);
            
            // Show error in the notification
            progressDiv.innerHTML = `
                <div class="progress-text" style="color: #dc3545;">
                    ❌ ${error.message || 'Download failed'}
                </div>
            `;
            
            // Reset UI after 3 seconds
            setTimeout(() => {
                downloadBtn.style.display = 'block';
                if (laterBtn) laterBtn.style.display = 'block';
                progressDiv.style.display = 'none';
                isDownloading = false;
            }, 3000);
        }
    }
    
    // Show installer ready notification
    async function showInstallerReady(downloadResult) {
        await getCurrentLanguage();
        
        if (updateNotification) {
            updateNotification.innerHTML = `
                <div class="update-content">
                    <div class="update-icon">✅</div>
                    <div class="update-text">
                        <div class="update-title">${t('updateDownloaded')}</div>
                        <div class="update-message">${t('readyToInstall')}</div>
                        <div class="download-info">
                            <small>${downloadResult.fileName}</small>
                        </div>
                    </div>
                    <div class="update-actions">
                        <button class="update-btn update-btn-secondary" id="update-later-install">${t('later')}</button>
                        <button class="update-btn update-btn-primary" id="update-install-directly">${t('installDirectly')}</button>
                    </div>
                </div>
            `;
            
            document.getElementById('update-later-install').addEventListener('click', hideUpdateNotification);
            document.getElementById('update-install-directly').addEventListener('click', openInstaller);
        }
        
        isDownloading = false;
    }
    
    // Open installer directly
    async function openInstaller() {
        try {
            if (!downloadedFilePath) {
                throw new Error('No installer file path available');
            }
            
            await window.electronAPI.openInstaller(downloadedFilePath);
            
            // Hide notification
            hideUpdateNotification();
        } catch (error) {
            console.error('Error opening installer:', error);
            showError('Failed to open installer: ' + error.message);
        }
    }
    
    // Update download progress
    function updateDownloadProgress(progress) {
        if (!updateNotification) return;
        
        const progressFill = updateNotification.querySelector('.progress-fill');
        const progressText = updateNotification.querySelector('.progress-text');
        
        if (progressFill && progressText) {
            const percent = Math.round(progress.percent);
            
            // Use setProperty with important to override CSS
            progressFill.style.setProperty('width', percent + '%', 'important');
            progressText.textContent = `${t('downloadingUpdate')} ${percent}%`;
            
            console.log(`Download progress: ${percent}% - Bar width set to ${progressFill.style.width}`);
        } else {
            console.warn('Progress elements not found in notification');
        }
    }
    
    // Show update downloaded notification
    async function showUpdateDownloaded(info) {
        await getCurrentLanguage();
        
        if (updateNotification) {
            updateNotification.innerHTML = `
                <div class="update-content">
                    <div class="update-icon">✅</div>
                    <div class="update-text">
                        <div class="update-title">${t('updateDownloaded')}</div>
                        <div class="update-message">${t('downloadedMessage')}</div>
                    </div>
                    <div class="update-actions">
                        <button class="update-btn update-btn-secondary" id="update-later-install">${t('later')}</button>
                        <button class="update-btn update-btn-primary" id="update-install">${t('installRestart')}</button>
                    </div>
                </div>
            `;
            
            document.getElementById('update-later-install').addEventListener('click', hideUpdateNotification);
            document.getElementById('update-install').addEventListener('click', installUpdate);
        }
    }
    
    // Install update
    async function installUpdate() {
        try {
            await window.electronAPI.installUpdate();
        } catch (error) {
            showError('Failed to install update: ' + error.message);
        }
    }
    
    // Show error message
    function showError(message) {
        if (updateNotification) {
            updateNotification.innerHTML = `
                <div class="update-content">
                    <div class="update-icon">❌</div>
                    <div class="update-text">
                        <div class="update-title">Update Error</div>
                        <div class="update-message">${message}</div>
                    </div>
                    <div class="update-actions">
                        <button class="update-btn update-btn-secondary" id="update-close">Close</button>
                    </div>
                </div>
            `;
            
            document.getElementById('update-close').addEventListener('click', hideUpdateNotification);
        }
        
        isDownloading = false;
    }
    
    // Initialize update system
    async function initUpdateSystem() {
        console.log('Initializing update system...');
        
        // Get current language
        await getCurrentLanguage();
        
        if (window.electronAPI) {
            // Set up event listeners for update events
            window.electronAPI.onUpdateAvailable((info) => {
                console.log('Update available:', info);
                showUpdateNotification(info);
            });
            
            window.electronAPI.onUpdateNotAvailable(() => {
                console.log('No update available. App is up to date.');
                // Don't show notification - app is already up to date
            });
            
            window.electronAPI.onUpdateError((error) => {
                console.error('Update error:', error);
                // Show error notification
                showErrorNotification(error);
            });
            
            window.electronAPI.onUpdateDownloadProgress((progress) => {
                console.log('Update download progress (electron-updater):', progress);
                updateDownloadProgress(progress);
            });
            
            // Listen for download progress (for manual downloads)
            if (window.electronAPI.onDownloadProgress) {
                window.electronAPI.onDownloadProgress((progress) => {
                    console.log('Download progress (manual):', progress);
                    updateDownloadProgress(progress);
                });
            } else {
                console.warn('onDownloadProgress not available in electronAPI');
            }
            
            window.electronAPI.onUpdateDownloaded((info) => {
                console.log('Update downloaded:', info);
                showUpdateDownloaded(info);
            });
            
            // Check for updates on startup (after 5 seconds)
            setTimeout(() => {
                console.log('Checking for updates...');
                window.electronAPI.checkForUpdates();
            }, 5000);
        }
    }
    
    // Show error notification
    async function showErrorNotification(error) {
        await getCurrentLanguage();
        
        const notification = document.createElement('div');
        notification.id = 'opticsify-update-error';
        notification.innerHTML = `
            <div class="update-content">
                <div class="update-icon">❌</div>
                <div class="update-text">
                    <div class="update-title">${t('updateError')}</div>
                    <div class="update-message">${error.message || 'An error occurred while checking for updates.'}</div>
                </div>
                <div class="update-actions">
                    <button class="update-btn update-btn-primary" id="error-close">${t('close')}</button>
                </div>
            </div>
        `;
        
        document.body.appendChild(notification);
        
        // Add event listener
        const closeBtn = notification.querySelector('#error-close');
        closeBtn.addEventListener('click', () => {
            notification.remove();
        });
        
        // Show with animation
        setTimeout(() => {
            notification.classList.add('show');
        }, 100);
        
        // Auto-hide after 5 seconds
        setTimeout(() => {
            if (notification.parentNode) {
                notification.remove();
            }
        }, 5000);
    }
    
    // Initialize when DOM is ready
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', initUpdateSystem);
    } else {
        initUpdateSystem();
    }
})();