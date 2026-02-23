#!/bin/bash

# Opticsify Desktop App Deployment Script
# Generates distribution files with DMG, ZIP, and latest.yml files

# Parse command line arguments
PLATFORM="all"
HELP=false

while [[ $# -gt 0 ]]; do
    case $1 in
        -p|--platform)
            PLATFORM="$2"
            shift 2
            ;;
        -h|--help)
            HELP=true
            shift
            ;;
        *)
            echo "Unknown option $1"
            exit 1
            ;;
    esac
done

# Show help if requested
if [ "$HELP" = true ]; then
    echo "🚀 Opticsify Desktop App Deployment Script"
    echo "========================================"
    echo ""
    echo "Usage: $0 [OPTIONS]"
    echo ""
    echo "Options:"
    echo "  -p, --platform PLATFORM    Target platform (mac, win, linux, all)"
    echo "  -h, --help                 Show this help message"
    echo ""
    echo "Platform builds:"
    echo "  mac     - macOS ARM64 + Intel (DMG + ZIP files)"
    echo "  win     - Windows 32-bit + 64-bit (.exe files)"
    echo "  linux   - Linux AppImage + Debian (.AppImage + .deb files)"
    echo "  all     - All platforms (default)"
    echo ""
    echo "Examples:"
    echo "  $0                         # Build all platforms (default)"
    echo "  $0 -p mac                  # Build macOS files only"
    echo "  $0 -p win                  # Build Windows files only"
    echo "  $0 -p linux                # Build Linux files only"
    echo "  $0 -p all                  # Build all platforms"
    echo ""
    exit 0
fi

# Extract version from package.json
VERSION=$(node -p "require('./package.json').version")
if [ -z "$VERSION" ]; then
    echo "❌ Failed to extract version from package.json"
    exit 1
fi

echo "📦 Version: $VERSION"



# Validate platform
case $PLATFORM in
    mac|win|linux|all)
        ;;
    *)
        echo "❌ Invalid platform: $PLATFORM"
        echo "Valid platforms: mac, win, linux, all"
        exit 1
        ;;
esac

echo "🚀 Opticsify Desktop App Deployment"
echo "================================="
echo "🎯 Target Platform: $PLATFORM"

case $PLATFORM in
    mac)
        echo "Building macOS files:"
        echo "   1. macOS ARM64 (.app)"
        echo "   2. macOS Intel (.app)"
        ;;
    win)
        echo "Building Windows files:"
        echo "   1. Windows 32-bit (.exe)"
        echo "   2. Windows 64-bit (.exe)"
        ;;
    linux)
        echo "Building Linux files:"
        echo "   1. Linux AppImage"
        echo "   2. Linux Debian (.deb)"
        ;;
    all)
        echo "Building all 6 distribution files:"
        echo "   1. Windows 32-bit (.exe)"
        echo "   2. Windows 64-bit (.exe)" 
        echo "   3. macOS ARM64 (.app)"
        echo "   4. macOS Intel (.app)"
        echo "   5. Linux AppImage"
        echo "   6. Linux Debian (.deb)"
        ;;
esac
echo ""

# Check if Docker is running
if ! docker info > /dev/null 2>&1; then
    echo "❌ Docker is not running. Please start Docker first."
    exit 1
fi

# Install dependencies if needed
if [ ! -d "node_modules" ]; then
    echo "📦 Installing dependencies..."
    npm install
fi

# Cleanup function to handle mounted volumes
cleanup_mounted_volumes() {
    echo "🧹 Cleaning up any mounted opticsify volumes..."
    # Find and detach any mounted opticsify volumes
    mount | grep "opticsify" | while read line; do
        volume_path=$(echo "$line" | sed 's/.*on \(\/Volumes\/[^(]*\).*/\1/' | sed 's/ *$//')
        if [ -n "$volume_path" ]; then
            echo "   Detaching: $volume_path"
            hdiutil detach "$volume_path" -force 2>/dev/null || true
        fi
    done
    
    # Also try to detach any volumes that might be stuck
    for vol in "/Volumes/Opticsify Desktop"*; do
        if [ -d "$vol" ]; then
            echo "   Force detaching: $vol"
            hdiutil detach "$vol" -force 2>/dev/null || true
        fi
    done
    
    # Kill any processes that might be using the volumes
    pkill -f "Opticsify Desktop" 2>/dev/null || true
    sleep 1
}

# Clean up any existing build artifacts and mounted volumes
echo "🧹 Cleaning up previous build artifacts..."
cleanup_mounted_volumes
rm -rf dist

# Build the application
echo "🔨 Building desktop application for platform: $PLATFORM..."

# Build specific files based on platform
BUILD_EXIT_CODE=0

# Windows builds
if [ "$PLATFORM" = "win" ] || [ "$PLATFORM" = "all" ]; then
    echo "📋 Building Windows 32-bit (.exe)..."
    CSC_IDENTITY_AUTO_DISCOVERY=false npx electron-builder --win nsis --ia32 --publish=never
    if [ $? -ne 0 ]; then
        echo "❌ Windows 32-bit build failed"
        BUILD_EXIT_CODE=1
    fi

    echo "📋 Building Windows 64-bit (.exe)..."
    CSC_IDENTITY_AUTO_DISCOVERY=false npx electron-builder --win nsis --x64 --publish=never
    if [ $? -ne 0 ]; then
        echo "❌ Windows 64-bit build failed"
        BUILD_EXIT_CODE=1
    fi
fi

# macOS builds - Build both architectures in parallel for speed
if [ "$PLATFORM" = "mac" ] || [ "$PLATFORM" = "all" ]; then
    echo "📋 Building macOS (ARM64 + Intel) with DMG and ZIP..."
    echo "🔐 Using ad-hoc code signing (via afterSign hook)..."
    # Build both architectures at once for faster builds
    # The afterSign hook in scripts/notarize.js will sign each app before packaging
    CSC_IDENTITY_AUTO_DISCOVERY=false npx electron-builder --mac dmg zip --x64 --arm64 --publish=never
    if [ $? -ne 0 ]; then
        echo "❌ macOS build failed"
        BUILD_EXIT_CODE=1
    else
        echo ""
        echo "✅ macOS builds completed"
        echo ""
        
        # Verify apps inside DMG files
        echo "🔍 Verifying signatures in packaged DMG files..."
        for dmg in dist/*.dmg; do
            if [ -f "$dmg" ]; then
                dmg_name=$(basename "$dmg")
                echo "   📀 Checking: $dmg_name"
                # Mount DMG and check signature
                hdiutil attach "$dmg" -nobrowse -quiet 2>/dev/null
                sleep 1
                if [ -d "/Volumes/Opticsify Desktop/Opticsify Desktop.app" ]; then
    codesign --verify --deep --strict "/Volumes/Opticsify Desktop/Opticsify Desktop.app" 2>/dev/null
                    if [ $? -eq 0 ]; then
                        echo "      ✅ App inside DMG is properly signed"
                        # Show signature details
                        codesign -dvvv "/Volumes/Opticsify Desktop/Opticsify Desktop.app" 2>&1 | grep "Authority\|Signature\|Identifier" | head -3
                    else
                        echo "      ❌ App inside DMG is NOT signed properly"
                    fi
                    hdiutil detach "/Volumes/Opticsify Desktop" -force -quiet 2>/dev/null
                else
                    echo "      ⚠️  Could not find app in mounted DMG"
                    hdiutil detach "/Volumes/Opticsify Desktop" -force -quiet 2>/dev/null
                fi
            fi
        done
        
        echo ""
        echo "🔍 Verifying signatures in ZIP files..."
        for zip_file in dist/*.zip; do
            if [ -f "$zip_file" ]; then
                zip_name=$(basename "$zip_file")
                echo "   📦 Checking: $zip_name"
                # Create temp directory
                temp_dir=$(mktemp -d)
                # Extract zip
                unzip -q "$zip_file" -d "$temp_dir"
                if [ -d "$temp_dir/Opticsify Desktop.app" ]; then
                codesign --verify --deep --strict "$temp_dir/Opticsify Desktop.app" 2>/dev/null
                    if [ $? -eq 0 ]; then
                        echo "      ✅ App inside ZIP is properly signed"
                    else
                        echo "      ❌ App inside ZIP is NOT signed properly"
                    fi
                else
                    echo "      ⚠️  Could not find app in extracted ZIP"
                fi
                # Clean up
                rm -rf "$temp_dir"
            fi
        done
    fi
fi

# Linux builds
if [ "$PLATFORM" = "linux" ] || [ "$PLATFORM" = "all" ]; then
    echo "📋 Building Linux AppImage..."
    npx electron-builder --linux AppImage --publish=never
    if [ $? -ne 0 ]; then
        echo "❌ Linux AppImage build failed"
        BUILD_EXIT_CODE=1
    fi

    echo "📋 Building Linux Debian (.deb)..."
    npx electron-builder --linux deb --publish=never
    if [ $? -ne 0 ]; then
        echo "❌ Linux Debian build failed"
        BUILD_EXIT_CODE=1
    fi
fi

# Clean up any volumes that might have been left mounted after build
cleanup_mounted_volumes

# Generate latest.yml files for auto-updater
if [ $BUILD_EXIT_CODE -eq 0 ]; then
    echo ""
    echo "📝 Generating auto-updater configuration files..."
    
    # The latest.yml files are automatically generated by electron-builder
    # We just need to verify they exist
    if [ -f "dist/latest-mac.yml" ]; then
        echo "✅ latest-mac.yml generated"
    fi
    if [ -f "dist/latest.yml" ]; then
        echo "✅ latest.yml generated"
    fi
    if [ -f "dist/latest-linux.yml" ]; then
        echo "✅ latest-linux.yml generated"
    fi
fi

# Check if build was successful
if [ $BUILD_EXIT_CODE -eq 0 ]; then
    echo ""
    case $PLATFORM in
        mac)
            echo "✅ macOS builds completed successfully!"
            echo ""
            echo "📁 Distribution files created:"
            echo "macOS DMG files:"
            ls -lh dist/*.dmg 2>/dev/null || echo "   No DMG files found"
            echo "macOS ZIP files:"
            ls -lh dist/*.zip 2>/dev/null || echo "   No ZIP files found"
            echo "macOS Apps:"
            ls -ld dist/mac*/*.app 2>/dev/null || echo "   No app files found"
            echo ""
            echo "🎉 macOS builds are code-signed and ready for S3 upload!"
            ;;
        win)
            echo "✅ Windows builds completed successfully!"
            echo ""
            echo "📁 Distribution files created:"
            echo "Windows installers:"
            ls -lh dist/*Setup*.exe 2>/dev/null || echo "   No installer files found"
            echo "Windows portables:"
            ls -lh dist/*Portable*.exe 2>/dev/null || echo "   No portable files found"
            echo ""
            echo "🎉 Windows builds are ready for S3 upload!"
            ;;
        linux)
            echo "✅ Linux builds completed successfully!"
            echo ""
            echo "📁 Distribution files created:"
            echo "Linux AppImage:"
            ls -lh dist/*.AppImage 2>/dev/null || echo "   No AppImage files found"
            echo "Linux Debian:"
            ls -lh dist/*.deb 2>/dev/null || echo "   No deb files found"
            echo ""
            echo "🎉 Linux builds are ready for S3 upload!"
            ;;
        all)
            echo "✅ All builds completed successfully!"
            echo ""
            echo "📁 Distribution files created:"
            
            echo "Windows builds:"
            ls -lh dist/*Setup*.exe dist/*Portable*.exe 2>/dev/null || echo "   No Windows files found"
            echo ""
            
            echo "macOS builds:"
            echo "  DMG files:"
            ls -lh dist/*.dmg 2>/dev/null || echo "     No DMG files found"
            echo "  ZIP files:"
            ls -lh dist/*-mac.zip dist/*-arm64-mac.zip 2>/dev/null || echo "     No ZIP files found"
            echo ""
            
            echo "Linux builds:"
            ls -lh dist/*.AppImage dist/*.deb 2>/dev/null || echo "   No Linux files found"
            echo ""
            
            echo "Auto-updater configs:"
            ls -lh dist/latest*.yml 2>/dev/null || echo "   No config files found"
            
            echo ""
            echo "🎉 All builds with DMG, ZIP, and latest.yml files are ready!"
            ;;
    esac
    echo ""
    echo "📋 Next steps:"
    echo "   1. Run create-release.sh to upload files to S3"
    echo "   2. Files are already signed, zipped, and configured for auto-updater"
    echo ""
else
    echo "❌ One or more builds failed for platform: $PLATFORM"
    echo "Please check the error messages above."
    echo ""
    echo "💡 Troubleshooting tips:"
    echo "   - Windows builds on macOS require Wine or cross-compilation"
    echo "   - Install Wine: brew install --cask wine-stable"
    echo "   - Or use GitHub Actions for Windows builds"
    echo "   - Linux builds should work on macOS with electron-builder"
    echo "   - Ensure all dependencies are installed"
    exit 1
fi
