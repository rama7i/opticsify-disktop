#!/bin/bash

# Create S3 Release Script
# This script uploads pre-built release files to S3 bucket for auto-updater

# Extract version from package.json dynamically
VERSION=$(node -p "require('./package.json').version")
if [ -z "$VERSION" ]; then
    echo "❌ Failed to extract version from package.json"
    exit 1
fi

S3_BUCKET="opticsify"
S3_REGION="me-south-1"
S3_PATH="disktop/apps/releases"
S3_ENDPOINT="https://s3.me-south-1.amazonaws.com"

echo "🚀 Uploading release files to S3..."
echo "📦 Version: $VERSION"
echo "🪣 Bucket: $S3_BUCKET"
echo "🌍 Region: $S3_REGION"
echo "📁 Path: $S3_PATH"
echo ""

# Check if dist directory exists
if [ ! -d "dist" ]; then
    echo "❌ Error: dist directory not found. Please run deploy.sh first to build the application."
    exit 1
fi

# Check if AWS CLI is installed
if ! command -v aws &> /dev/null; then
    echo "❌ Error: AWS CLI is not installed. Please install it first."
    echo "Visit: https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html"
    exit 1
fi

# Check if AWS credentials are configured
if ! aws sts get-caller-identity &> /dev/null; then
    echo "❌ Error: AWS credentials not configured. Please run 'aws configure' first."
    exit 1
fi

# Function to upload file to S3
upload_to_s3() {
    local file_path="$1"
    local s3_key="$2"
    local content_type="$3"
    
    if [ -f "$file_path" ]; then
        local file_size=$(du -h "$file_path" | cut -f1)
        echo "⬆️  Uploading $s3_key ($file_size)..."
        aws s3 cp "$file_path" "s3://$S3_BUCKET/$S3_PATH/$s3_key" \
            --region "$S3_REGION" \
            --content-type "$content_type" \
            --acl public-read
        
        if [ $? -eq 0 ]; then
            echo "✅ Successfully uploaded $s3_key"
        else
            echo "❌ Failed to upload $s3_key"
            return 1
        fi
    else
        echo "⚠️  File not found: $file_path (skipping)"
    fi
}

echo ""
echo "📤 Uploading pre-built files to S3..."
echo ""

# Count successful uploads
UPLOAD_COUNT=0
FAILED_COUNT=0

# Upload Windows executables
echo "🪟 Uploading Windows files..."
upload_to_s3 "dist/Opticsify Desktop Setup ${VERSION}-ia32.exe" "opticsify-Desktop-Setup-${VERSION}-ia32.exe" "application/octet-stream" && ((UPLOAD_COUNT++)) || ((FAILED_COUNT++))
upload_to_s3 "dist/Opticsify Desktop Setup ${VERSION}-x64.exe" "opticsify-Desktop-Setup-${VERSION}-x64.exe" "application/octet-stream" && ((UPLOAD_COUNT++)) || ((FAILED_COUNT++))
upload_to_s3 "dist/Opticsify Desktop ${VERSION}-ia32.exe" "opticsify-Desktop-Portable-${VERSION}-ia32.exe" "application/octet-stream" && ((UPLOAD_COUNT++)) || ((FAILED_COUNT++))
upload_to_s3 "dist/Opticsify Desktop ${VERSION}-x64.exe" "opticsify-Desktop-Portable-${VERSION}-x64.exe" "application/octet-stream" && ((UPLOAD_COUNT++)) || ((FAILED_COUNT++))
echo ""

# Upload macOS files (DMG and ZIP - already built by electron-builder)
echo "🍎 Uploading macOS files..."
upload_to_s3 "dist/Opticsify Desktop-${VERSION}-arm64.dmg" "opticsify-Desktop-${VERSION}-arm64-mac.dmg" "application/octet-stream" && ((UPLOAD_COUNT++)) || ((FAILED_COUNT++))
upload_to_s3 "dist/Opticsify Desktop-${VERSION}-arm64-mac.zip" "opticsify-Desktop-${VERSION}-arm64-mac.zip" "application/zip" && ((UPLOAD_COUNT++)) || ((FAILED_COUNT++))
upload_to_s3 "dist/Opticsify Desktop-${VERSION}.dmg" "opticsify-Desktop-${VERSION}-mac.dmg" "application/octet-stream" && ((UPLOAD_COUNT++)) || ((FAILED_COUNT++))
upload_to_s3 "dist/Opticsify Desktop-${VERSION}-mac.zip" "opticsify-Desktop-${VERSION}-mac.zip" "application/zip" && ((UPLOAD_COUNT++)) || ((FAILED_COUNT++))
echo ""

# Upload Linux files
echo "🐧 Uploading Linux files..."
upload_to_s3 "dist/Opticsify Desktop-${VERSION}.AppImage" "opticsify-Desktop-${VERSION}.AppImage" "application/octet-stream" && ((UPLOAD_COUNT++)) || ((FAILED_COUNT++))
upload_to_s3 "dist/opticsify-desktop_${VERSION}_amd64.deb" "opticsify-desktop_${VERSION}_amd64.deb" "application/octet-stream" && ((UPLOAD_COUNT++)) || ((FAILED_COUNT++))
echo ""

# Upload blockmap files for auto-updater (if they exist)
echo "📋 Uploading blockmap files..."
upload_to_s3 "dist/Opticsify Desktop Setup ${VERSION}-ia32.exe.blockmap" "opticsify-Desktop-Setup-${VERSION}-ia32.exe.blockmap" "application/octet-stream" && ((UPLOAD_COUNT++))
upload_to_s3 "dist/Opticsify Desktop Setup ${VERSION}-x64.exe.blockmap" "opticsify-Desktop-Setup-${VERSION}-x64.exe.blockmap" "application/octet-stream" && ((UPLOAD_COUNT++))
upload_to_s3 "dist/Opticsify Desktop-${VERSION}-arm64.dmg.blockmap" "opticsify-Desktop-${VERSION}-arm64-mac.dmg.blockmap" "application/octet-stream" && ((UPLOAD_COUNT++))
upload_to_s3 "dist/Opticsify Desktop-${VERSION}-arm64-mac.zip.blockmap" "opticsify-Desktop-${VERSION}-arm64-mac.zip.blockmap" "application/octet-stream" && ((UPLOAD_COUNT++))
upload_to_s3 "dist/Opticsify Desktop-${VERSION}.dmg.blockmap" "opticsify-Desktop-${VERSION}-mac.dmg.blockmap" "application/octet-stream" && ((UPLOAD_COUNT++))
upload_to_s3 "dist/Opticsify Desktop-${VERSION}-mac.zip.blockmap" "opticsify-Desktop-${VERSION}-mac.zip.blockmap" "application/octet-stream" && ((UPLOAD_COUNT++))
echo ""

# Upload latest.yml files for auto-updater (CRITICAL for electron-updater)
echo "⚙️  Uploading auto-updater configuration files..."
upload_to_s3 "dist/latest.yml" "latest.yml" "application/x-yaml" && ((UPLOAD_COUNT++)) || ((FAILED_COUNT++))
upload_to_s3 "dist/latest-mac.yml" "latest-mac.yml" "application/x-yaml" && ((UPLOAD_COUNT++)) || ((FAILED_COUNT++))
upload_to_s3 "dist/latest-linux.yml" "latest-linux.yml" "application/x-yaml" && ((UPLOAD_COUNT++)) || ((FAILED_COUNT++))

echo ""
echo "✅ Release upload completed!"
echo ""
echo "📊 Upload Summary:"
echo "   ✅ Successfully uploaded: $UPLOAD_COUNT files"
if [ $FAILED_COUNT -gt 0 ]; then
    echo "   ⚠️  Failed/Skipped: $FAILED_COUNT files"
fi
echo ""
echo "📦 Version: $VERSION"
echo ""
echo "🌐 Files are now available at:"
echo "   Base URL: $S3_ENDPOINT/$S3_BUCKET/$S3_PATH/"
echo ""
echo "🔄 Auto-updater will check for updates at:"
echo "   • Windows: $S3_ENDPOINT/$S3_BUCKET/$S3_PATH/latest.yml"
echo "   • macOS:   $S3_ENDPOINT/$S3_BUCKET/$S3_PATH/latest-mac.yml"
echo "   • Linux:   $S3_ENDPOINT/$S3_BUCKET/$S3_PATH/latest-linux.yml"
echo ""
echo "✨ Your app is now ready for distribution!"