#!/bin/bash

echo "🧹 Performing aggressive DMG volume cleanup..."

# Kill any processes that might be using the DMG volumes
sudo pkill -f "Opticsify Desktop" 2>/dev/null || true
sudo pkill -f "hdiutil" 2>/dev/null || true

# Wait a moment for processes to die
sleep 1

# Find and unmount all Opticsify Desktop volumes
for volume in $(mount | grep "Opticsify Desktop" | awk '{print $3}' | tr '\n' ' '); do
    echo "🔧 Unmounting volume: $volume"
    sudo umount -f "$volume" 2>/dev/null || true
    sudo diskutil unmount force "$volume" 2>/dev/null || true
    sudo hdiutil detach "$volume" -force 2>/dev/null || true
done

# Force detach any remaining DMG attachments
for device in $(hdiutil info | grep "Opticsify Desktop" | awk '{print $1}' | tr '\n' ' '); do
    echo "🔧 Force detaching device: $device"
    sudo hdiutil detach "$device" -force 2>/dev/null || true
done

# Clean up any leftover mount points
sudo rm -rf "/Volumes/Opticsify Desktop"* 2>/dev/null || true

# Additional aggressive cleanup - kill any remaining hdiutil processes
sudo pkill -9 -f "hdiutil" 2>/dev/null || true

# Wait for cleanup to complete
sleep 2

echo "✅ DMG volume cleanup completed"
