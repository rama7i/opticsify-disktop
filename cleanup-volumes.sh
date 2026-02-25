#!/bin/bash
# Detaches any stuck "Opticsify Desktop" DMG volumes left over from a previous build.
# Run this manually if a build fails mid-way, or call it from build.sh between arch builds.

echo "🧹 Cleaning up stuck Opticsify Desktop DMG volumes..."

# Kill any processes locking the volumes
pkill -f "Opticsify Desktop" 2>/dev/null || true
pkill -f "hdiutil"          2>/dev/null || true
sleep 1

# Detach by mount path (covers both HFS+ and APFS mounts)
while IFS= read -r mount_path; do
    [ -z "$mount_path" ] && continue
    echo "   Detaching mount: $mount_path"
    hdiutil detach "$mount_path" -force 2>/dev/null || \
    diskutil unmount force "$mount_path" 2>/dev/null || true
done < <(mount | grep -i "Opticsify Desktop" | awk '{print $3}')

# Detach by /dev device node (hdiutil info is more thorough than mount)
while IFS= read -r dev_node; do
    [ -z "$dev_node" ] && continue
    echo "   Detaching device: $dev_node"
    hdiutil detach "$dev_node" -force 2>/dev/null || true
done < <(hdiutil info 2>/dev/null | grep -i "opticsify" -B 10 | grep "^/dev/" | awk '{print $1}')

# Remove any leftover /Volumes/Opticsify* mount-point directories
for vol in "/Volumes/Opticsify Desktop"*; do
    [ -e "$vol" ] || continue
    echo "   Removing stale mount point: $vol"
    hdiutil detach "$vol" -force 2>/dev/null || true
    rm -rf "$vol" 2>/dev/null || true
done

# Final sweep for any remaining hdiutil processes
sleep 1
pkill -9 -f "hdiutil" 2>/dev/null || true

echo "✅ Volume cleanup complete"
