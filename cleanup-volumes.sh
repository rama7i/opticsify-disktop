#!/bin/bash
# Script to clean up stuck DMG volumes before building

echo "🧹 Cleaning up stuck DMG volumes..."

# Find and unmount any Opticsify Desktop volumes
while IFS= read -r volume; do
    if [ ! -z "$volume" ]; then
        echo "Unmounting: $volume"
        hdiutil detach "$volume" -force 2>/dev/null || true
    fi
done < <(df -h | grep "Opticsify Desktop" | awk '{print $NF}')

# Also check hdiutil info
while IFS= read -r device; do
    if [ ! -z "$device" ]; then
        echo "Detaching device: $device"
        hdiutil detach "$device" -force 2>/dev/null || true
    fi
done < <(hdiutil info | grep "/Volumes/Opticsify" -B 5 | grep "^/dev/" | awk '{print $1}')

echo "✅ Cleanup complete! You can now run npm run build"
