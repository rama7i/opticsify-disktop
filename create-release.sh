#!/bin/bash

# Create S3 Release Script
# Uploads pre-built release files from dist/ to S3 for the auto-updater.
#
# Expected dist/ files:
#   Opticsify-Desktop-Setup-<v>-x64.exe         Windows x64 installer
#   Opticsify-Desktop-Setup-<v>-ia32.exe        Windows ia32 installer
#   Opticsify-Desktop-<v>-mac.dmg               macOS x64 (Intel)
#   Opticsify-Desktop-<v>-arm64-mac.dmg         macOS arm64 (Apple Silicon)
#   Opticsify-Desktop-<v>.AppImage              Linux AppImage
#   opticsify-desktop_<v>_amd64.deb             Linux Debian
#   latest.yml / latest-mac.yml / latest-linux.yml   auto-updater configs

VERSION=$(node -p "require('./package.json').version")
if [ -z "$VERSION" ]; then
    echo "❌ Failed to extract version from package.json"
    exit 1
fi

S3_BUCKET="opticsify"
S3_REGION="me-central-1"
S3_PATH="disktop/apps/releases"
S3_ENDPOINT="https://s3.me-central-1.amazonaws.com"

echo "🚀 Uploading release files to S3..."
echo "📦 Version: $VERSION"
echo "🪣 Bucket:  $S3_BUCKET"
echo "🌍 Region:  $S3_REGION"
echo "📁 Path:    $S3_PATH"
echo ""

if [ ! -d "dist" ]; then
    echo "❌ dist/ not found. Run build.sh first."
    exit 1
fi

if ! command -v aws &> /dev/null; then
    echo "❌ AWS CLI not installed."
    echo "   https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html"
    exit 1
fi

if ! aws sts get-caller-identity &> /dev/null; then
    echo "❌ AWS credentials not configured. Run: aws configure"
    exit 1
fi

# Upload a single file to S3.
# Usage: upload_to_s3 <local-path> <s3-key> <content-type>
upload_to_s3() {
    local file_path="$1"
    local s3_key="$2"
    local content_type="$3"

    if [ ! -f "$file_path" ]; then
        echo "⚠️  Skipping (not found): $file_path"
        return 0   # not a hard failure — file may not exist for partial builds
    fi

    local file_size
    file_size=$(du -h "$file_path" | cut -f1)
    echo "⬆️  $s3_key  ($file_size)"
    aws s3 cp "$file_path" "s3://$S3_BUCKET/$S3_PATH/$s3_key" \
        --region "$S3_REGION" \
        --content-type "$content_type" \
        --acl public-read

    if [ $? -eq 0 ]; then
        echo "   ✅ OK"
        return 0
    else
        echo "   ❌ Failed"
        return 1
    fi
}

UPLOAD_COUNT=0
FAILED_COUNT=0

ok()   { ((UPLOAD_COUNT++)); }
fail() { ((FAILED_COUNT++)); }

# ── Windows ─────────────────────────────────────────────────────────────────
echo "🪟 Windows installers..."
upload_to_s3 \
    "dist/Opticsify-Desktop-Setup-${VERSION}-x64.exe" \
    "Opticsify-Desktop-Setup-${VERSION}-x64.exe" \
    "application/octet-stream"  && ok || fail

upload_to_s3 \
    "dist/Opticsify-Desktop-Setup-${VERSION}-ia32.exe" \
    "Opticsify-Desktop-Setup-${VERSION}-ia32.exe" \
    "application/octet-stream"  && ok || fail

upload_to_s3 \
    "dist/Opticsify-Desktop-Setup-${VERSION}-x64.exe.blockmap" \
    "Opticsify-Desktop-Setup-${VERSION}-x64.exe.blockmap" \
    "application/octet-stream"  && ok

upload_to_s3 \
    "dist/Opticsify-Desktop-Setup-${VERSION}-ia32.exe.blockmap" \
    "Opticsify-Desktop-Setup-${VERSION}-ia32.exe.blockmap" \
    "application/octet-stream"  && ok

echo ""

# ── macOS ────────────────────────────────────────────────────────────────────
echo "🍎 macOS DMGs..."
upload_to_s3 \
    "dist/Opticsify-Desktop-${VERSION}-mac.dmg" \
    "Opticsify-Desktop-${VERSION}-mac.dmg" \
    "application/octet-stream"  && ok || fail

upload_to_s3 \
    "dist/Opticsify-Desktop-${VERSION}-arm64-mac.dmg" \
    "Opticsify-Desktop-${VERSION}-arm64-mac.dmg" \
    "application/octet-stream"  && ok || fail

upload_to_s3 \
    "dist/Opticsify-Desktop-${VERSION}-mac.dmg.blockmap" \
    "Opticsify-Desktop-${VERSION}-mac.dmg.blockmap" \
    "application/octet-stream"  && ok

upload_to_s3 \
    "dist/Opticsify-Desktop-${VERSION}-arm64-mac.dmg.blockmap" \
    "Opticsify-Desktop-${VERSION}-arm64-mac.dmg.blockmap" \
    "application/octet-stream"  && ok

echo ""

# ── Linux ────────────────────────────────────────────────────────────────────
echo "🐧 Linux packages..."
upload_to_s3 \
    "dist/Opticsify-Desktop-${VERSION}.AppImage" \
    "Opticsify-Desktop-${VERSION}.AppImage" \
    "application/octet-stream"  && ok || fail

upload_to_s3 \
    "dist/opticsify-desktop_${VERSION}_amd64.deb" \
    "opticsify-desktop_${VERSION}_amd64.deb" \
    "application/octet-stream"  && ok || fail

echo ""

# ── Auto-updater YMLs (critical — must match S3_PATH in app-update.yml) ─────
echo "⚙️  Auto-updater configs..."
upload_to_s3 "dist/latest.yml"       "latest.yml"       "application/x-yaml" && ok || fail
upload_to_s3 "dist/latest-mac.yml"   "latest-mac.yml"   "application/x-yaml" && ok || fail
upload_to_s3 "dist/latest-linux.yml" "latest-linux.yml" "application/x-yaml" && ok || fail

echo ""
echo "✅ Upload complete!"
echo ""
echo "📊 Summary:  ✅ $UPLOAD_COUNT uploaded   ⚠️  $FAILED_COUNT failed/skipped"
echo "📦 Version:  $VERSION"
echo ""
echo "🌐 Base URL: $S3_ENDPOINT/$S3_BUCKET/$S3_PATH/"
echo ""
echo "🔄 Auto-updater endpoints:"
echo "   Windows : $S3_ENDPOINT/$S3_BUCKET/$S3_PATH/latest.yml"
echo "   macOS   : $S3_ENDPOINT/$S3_BUCKET/$S3_PATH/latest-mac.yml"
echo "   Linux   : $S3_ENDPOINT/$S3_BUCKET/$S3_PATH/latest-linux.yml"
echo ""
echo "✨ Release is live!"
