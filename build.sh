#!/bin/bash

# opticsify Desktop App Deployment Script
# Generates distribution files with DMG, ZIP, and latest.yml files

# Get the project root directory (same directory as this script since it's in root)
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$SCRIPT_DIR"

# Change to project root
cd "$PROJECT_ROOT"

# Load environment variables from .env file if it exists
if [ -f ".env" ]; then
    echo "📋 Loading credentials from .env file..."
    export $(grep -v '^#' .env | xargs)
fi

# Parse command line arguments for help
HELP=false
for arg in "$@"; do
    if [[ "$arg" == "-h" || "$arg" == "--help" ]]; then
        HELP=true
        break
    fi
done

# Show help if requested
if [ "$HELP" = true ]; then
    echo "🚀 opticsify Desktop App Deployment Script"
    echo "========================================"
    echo ""
    echo "Usage: $0 [OPTIONS]"
    echo ""
    echo "Interactive mode (default):"
    echo "  Just run: $0"
    echo "  You'll be prompted to select:"
    echo "    1. Build mode (dev/prod)"
    echo "    2. Target platform (mac/win/both)"
    echo ""
    echo "Command line options:"
    echo "  -p, --platform PLATFORM    Target platform (mac, win, linux, all)"
    echo "  -m, --mode MODE            Build mode (dev, prod)"
    echo "  -h, --help                 Show this help message"
    echo ""
    echo "Build modes:"
    echo "  dev     - Development build (no code signing, faster)"
    echo "  prod    - Production build (with code signing for macOS)"
    echo ""
    echo "Platform builds:"
    echo "  mac     - macOS x64 + arm64 (two separate DMGs)"
    echo "  win     - Windows x64 + ia32 (two separate installers)"
    echo "  linux   - Linux AppImage + Debian (.AppImage + .deb files)"
    echo "  all     - All platforms"
    echo ""
    echo "Examples:"
    echo "  $0                         # Interactive mode"
    echo "  $0 -p mac -m dev           # Build macOS dev (no signing)"
    echo "  $0 -p mac -m prod          # Build macOS prod (with signing)"
    echo "  $0 -p all -m prod          # Build all platforms for production"
    echo ""
    exit 0
fi

# Check if running in interactive mode (no arguments)
if [ $# -eq 0 ]; then
    echo "🚀 opticsify Desktop App Build"
    echo "=============================="
    echo ""
    echo "Select build mode:"
    echo "  1 - Development (no signing, faster)"
    echo "  2 - Production (with signing)"
    echo ""
    read -p "Enter your choice (1-2): " mode_choice
    
    case $mode_choice in
        1)
            MODE="dev"
            ;;
        2)
            MODE="prod"
            ;;
        *)
            echo "❌ Invalid choice. Please enter 1 or 2."
            exit 1
            ;;
    esac
    
    echo ""
    echo "Selected mode: $MODE"
    echo ""
    echo "Select platform:"
    echo "  1 - macOS (x64 + arm64: two separate DMGs)"
    echo "  2 - Windows (x64 + ia32: two separate installers)"
    echo "  3 - Both (macOS + Windows)"
    echo ""
    read -p "Enter your choice (1-3): " platform_choice
    
    case $platform_choice in
        1)
            PLATFORM="mac"
            ;;
        2)
            PLATFORM="win"
            ;;
        3)
            PLATFORM="all"
            ;;
        *)
            echo "❌ Invalid choice. Please enter 1, 2, or 3."
            exit 1
            ;;
    esac
    
    echo ""
    echo "Selected platform: $PLATFORM"
    echo ""
else
    # Parse command line arguments
    PLATFORM=""
    MODE=""
    
    while [[ $# -gt 0 ]]; do
        case $1 in
            -p|--platform)
                PLATFORM="$2"
                shift 2
                ;;
            -m|--mode)
                MODE="$2"
                shift 2
                ;;
            *)
                echo "Unknown option $1"
                echo "Use -h or --help for usage information"
                exit 1
                ;;
        esac
    done
    
    # Set defaults if not provided
    if [ -z "$MODE" ]; then
        MODE="dev"
    fi
    if [ -z "$PLATFORM" ]; then
        PLATFORM="all"
    fi
fi

# Extract version from package.json
VERSION=$(node -p "require('./package.json').version")
if [ -z "$VERSION" ]; then
    echo "❌ Failed to extract version from package.json"
    exit 1
fi

echo "📦 Version: $VERSION"

# Validate mode
case $MODE in
    dev|prod)
        ;;
    *)
        echo "❌ Invalid mode: $MODE"
        echo "Valid modes: dev, prod"
        exit 1
        ;;
esac



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

echo "🚀 opticsify Desktop App Deployment"
echo "================================="
echo "🎯 Target Platform: $PLATFORM"
echo "🔧 Build Mode: $MODE"

case $PLATFORM in
    mac)
        echo "Building macOS files:"
        echo "   - Opticsify-Desktop-$VERSION-mac.dmg        (x64 / Intel)"
        echo "   - Opticsify-Desktop-$VERSION-arm64-mac.dmg  (arm64 / Apple Silicon)"
        ;;
    win)
        echo "Building Windows files:"
        echo "   - Opticsify-Desktop-Setup-$VERSION-x64.exe"
        echo "   - Opticsify-Desktop-Setup-$VERSION-ia32.exe"
        ;;
    linux)
        echo "Building Linux files:"
        echo "   - Linux AppImage"
        echo "   - Linux Debian (.deb)"
        ;;
    all)
        echo "Building distribution files:"
        echo "   - Opticsify-Desktop-$VERSION-mac.dmg        (macOS x64)"
        echo "   - Opticsify-Desktop-$VERSION-arm64-mac.dmg  (macOS arm64)"
        echo "   - Opticsify-Desktop-Setup-$VERSION-x64.exe  (Windows x64)"
        echo "   - Opticsify-Desktop-Setup-$VERSION-ia32.exe (Windows ia32)"
        ;;
esac

if [ "$MODE" = "prod" ]; then
    echo ""
    echo "🔐 Production mode: Code signing enabled for macOS"
else
    echo ""
    echo "⚡ Development mode: No code signing, faster builds"
fi
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
    for vol in "/Volumes/opticsify Desktop"*; do
        if [ -d "$vol" ]; then
            echo "   Force detaching: $vol"
            hdiutil detach "$vol" -force 2>/dev/null || true
        fi
    done
    
    # Kill any processes that might be using the volumes
    pkill -f "opticsify Desktop" 2>/dev/null || true
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

# Windows builds - produces separate x64 and ia32 installers
if [ "$PLATFORM" = "win" ] || [ "$PLATFORM" = "all" ]; then
    echo "📋 Building Windows x64 + ia32 (separate installers)..."
    CSC_IDENTITY_AUTO_DISCOVERY=false npx electron-builder --win --ia32 --x64 --publish=never
    if [ $? -ne 0 ]; then
        echo "❌ Windows build failed"
        BUILD_EXIT_CODE=1
    fi
fi

# macOS builds - two separate electron-builder calls (x64 then arm64).
# Building both in one call leaves the x64 DMG volume mounted, which causes
# hdiutil to fail when arm64 tries to create a volume with the same name.
# After both builds the two latest-mac.yml files are merged into one.
if [ "$PLATFORM" = "mac" ] || [ "$PLATFORM" = "all" ]; then

    # Helper: run electron-builder for one mac arch
    # Args: $1=arch  $2=artifact-name-template  $3=label  $4=unpacked-dir
    run_mac_build() {
        local ARCH="$1"
        local ARTIFACT="$2"
        local LABEL="$3"
        local UNPACK_DIR="$4"

        echo "📋 Building macOS $LABEL DMG..."

        # Array avoids eval so ${version}/${arch}/${ext} reach electron-builder unexpanded
        local ARGS=(--mac "--$ARCH"
            "--config.mac.artifactName=$ARTIFACT"
            --publish=never)

        if [ "$MODE" = "prod" ]; then
            echo "🔐 Production mode: Signing with Developer ID..."
            local DEV_ID
            DEV_ID=$(security find-identity -v -p codesigning \
                | grep "Developer ID Application" | head -1 \
                | grep -o '"[^"]*"' | sed 's/"//g')
            if [ -z "$DEV_ID" ]; then
                echo "⚠️  No Developer ID found. Building without signing..."
                CSC_IDENTITY_AUTO_DISCOVERY=false npx electron-builder "${ARGS[@]}"
            else
                echo "   Certificate: $DEV_ID"
                npx electron-builder "${ARGS[@]}"
            fi
        else
            echo "⚡ Development mode: Skipping code signing..."
            CSC_IDENTITY_AUTO_DISCOVERY=false npx electron-builder "${ARGS[@]}"
        fi

        if [ $? -ne 0 ]; then
            echo "❌ macOS $LABEL build failed"
            return 1
        fi

        echo "✅ macOS $LABEL build completed"

        if [ "$MODE" = "prod" ]; then
            local APP="dist/$UNPACK_DIR/Opticsify Desktop.app"
            if [ -d "$APP" ]; then
                echo "🔍 Verifying signature ($LABEL)..."
                codesign --verify --deep --strict -vvv "$APP" 2>&1 | head -3
                [ $? -eq 0 ] \
                    && echo "   ✅ Signed OK" \
                    || echo "   ⚠️  Signature warning (may still work)"
            fi
        fi
        return 0
    }

    # ── x64 (Intel) ─────────────────────────────────────────────────────────
    # Output: Opticsify-Desktop-<version>-mac.dmg
    run_mac_build "x64" \
        'Opticsify-Desktop-${version}-mac.${ext}' \
        "x64 (Intel)" "mac"
    if [ $? -ne 0 ]; then
        BUILD_EXIT_CODE=1
    else
        # Save x64 yml before the arm64 build overwrites it
        [ -f "dist/latest-mac.yml" ] && cp dist/latest-mac.yml dist/latest-mac-x64.yml
    fi

    # Detach any DMG volume left mounted by the x64 build before starting arm64
    echo "🧹 Cleaning up volumes between arch builds..."
    bash "$(dirname "$0")/cleanup-volumes.sh" 2>/dev/null || true
    sleep 2

    # ── arm64 (Apple Silicon) ────────────────────────────────────────────────
    # Output: Opticsify-Desktop-<version>-arm64-mac.dmg
    run_mac_build "arm64" \
        'Opticsify-Desktop-${version}-arm64-mac.${ext}' \
        "arm64 (Apple Silicon)" "mac-arm64"
    if [ $? -ne 0 ]; then
        BUILD_EXIT_CODE=1
    else
        [ -f "dist/latest-mac.yml" ] && cp dist/latest-mac.yml dist/latest-mac-arm64.yml
    fi

    # ── Merge latest-mac.yml ────────────────────────────────────────────────
    # Each arch build writes its own latest-mac.yml overwriting the previous.
    # Merge them so electron-updater can serve the right file for each arch.
    if [ -f "dist/latest-mac-x64.yml" ] && [ -f "dist/latest-mac-arm64.yml" ]; then
        echo "📝 Merging latest-mac.yml (x64 + arm64)..."
        node - dist/latest-mac-x64.yml dist/latest-mac-arm64.yml dist/latest-mac.yml << 'NODEEOF'
const fs = require('fs');
const [,, x64File, arm64File, outFile] = process.argv;

const parseFiles = (yml) => {
    const lines = yml.split('\n');
    const entries = [];
    let i = lines.findIndex(l => l === 'files:') + 1;
    while (i < lines.length && (lines[i].startsWith('  ') || lines[i] === '')) {
        entries.push(lines[i]); i++;
    }
    // Trim trailing blank lines inside the block
    while (entries.length && entries[entries.length - 1] === '') entries.pop();
    return entries;
};

const x64yml  = fs.readFileSync(x64File,  'utf8');
const arm64yml = fs.readFileSync(arm64File, 'utf8');

const x64entries   = parseFiles(x64yml);
const arm64entries = parseFiles(arm64yml);

// Build merged yml: x64 base with arm64 file entries appended inside 'files:'
const lines = x64yml.split('\n');
const filesEnd = (() => {
    let idx = lines.findIndex(l => l === 'files:') + 1;
    while (idx < lines.length && (lines[idx].startsWith('  ') || lines[idx] === '')) idx++;
    return idx;
})();

const merged = [
    ...lines.slice(0, filesEnd),
    ...arm64entries,
    ...lines.slice(filesEnd)
].join('\n');

fs.writeFileSync(outFile, merged);
console.log('   ✅ latest-mac.yml merged (x64 + arm64)');
NODEEOF
        rm -f dist/latest-mac-x64.yml dist/latest-mac-arm64.yml
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

# Clean up temporary build folders
echo "🧹 Cleaning up temporary build folders..."
if [ "$PLATFORM" = "mac" ] || [ "$PLATFORM" = "all" ]; then
    rm -rf dist/mac dist/mac-arm64
    rm -rf dist/.icon-icns dist/.icon-ico
fi
if [ "$PLATFORM" = "win" ] || [ "$PLATFORM" = "all" ]; then
    rm -rf dist/win-unpacked dist/win-ia32-unpacked
fi
if [ "$PLATFORM" = "linux" ] || [ "$PLATFORM" = "all" ]; then
    rm -rf dist/linux-arm64-unpacked dist/linux-unpacked
fi

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
        win)
            echo "✅ Windows build completed successfully!"
            echo ""
            echo "📁 Distribution files created:"
            ls -lh dist/*.exe 2>/dev/null | grep -v "blockmap" || echo "   No installer file found"
            echo ""
            echo "🎉 Windows build is ready for S3 upload!"
            ;;
        mac)
            echo "✅ macOS build completed successfully!"
            echo ""
            echo "📁 Distribution files created:"
            ls -lh dist/*.dmg 2>/dev/null | grep -v "blockmap" || echo "   No DMG file found"
            echo ""
            if [ "$MODE" = "prod" ]; then
                echo "🎉 macOS build is code-signed and ready for S3 upload!"
            else
                echo "🎉 macOS dev build is ready for testing!"
            fi
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
            
            echo "Windows build:"
            ls -lh dist/*.exe 2>/dev/null | grep -v "blockmap" || echo "   No Windows file found"
            echo ""
            
            echo "macOS build:"
            ls -lh dist/*.dmg 2>/dev/null | grep -v "blockmap" || echo "   No DMG file found"
            echo ""
            
            echo "Linux builds:"
            ls -lh dist/*.AppImage dist/*.deb 2>/dev/null | grep -v "blockmap" || echo "   No Linux files found"
            echo ""
            
            echo "Auto-updater configs:"
            ls -lh dist/latest*.yml 2>/dev/null || echo "   No config files found"
            
            echo ""
            if [ "$MODE" = "prod" ]; then
                echo "🎉 All production builds are ready for deployment!"
            else
                echo "🎉 All dev builds are ready for testing!"
            fi
            ;;
    esac
    echo ""
    echo "📋 Next steps:"
    if [ "$MODE" = "prod" ]; then
        echo "   1. Run create-release.sh to upload files to S3"
        echo "   2. Files are signed and configured for auto-updater"
    else
        echo "   1. Test the builds locally"
        echo "   2. Use -m prod for production builds with signing"
    fi
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
