#!/system/bin/sh
# uninstall.sh — Cleanup on module removal
# Called when the module is removed. Runs as root.

# Kill any running benchmark processes
pkill -f zram-bench 2>/dev/null

# Restore zram settings to defaults if possible
if [ -w /sys/block/zram0/comp_algorithm ]; then
    echo "lz4" > /sys/block/zram0/comp_algorithm 2>/dev/null
fi

if [ -w /sys/block/zram0/disksize ]; then
    # Reset to 0 lets the kernel choose the default
    # Do NOT modify disksize - system manages zram
fi

# Remove benchmark results
rm -f /sdcard/zram_results.json 2>/dev/null

# Remove temporary test data
rm -rf /data/local/tmp/zram-bench 2>/dev/null

echo "ZRAM Benchmark module removed."
