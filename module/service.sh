#!/system/bin/sh
# service.sh — Late boot script (optional)
# Runs after boot completed. Use for daemons or post-boot tasks.

MODDIR="$(cd "$(dirname "$0")" && pwd)"
ZRAM_CONFIG="$MODDIR/zram_config.json"

# Apply persisted ZRAM config if it exists
if [ -f "$ZRAM_CONFIG" ] && command -v jq >/dev/null 2>&1; then
    ALGO=$(jq -r '.algo // empty' "$ZRAM_CONFIG" 2>/dev/null)
    DISKSIZE=$(jq -r '.disksize // empty' "$ZRAM_CONFIG" 2>/dev/null)
    STREAMS=$(jq -r '.streams // empty' "$ZRAM_CONFIG" 2>/dev/null)

    # Skip if no valid config
    if [ -z "$ALGO" ] && [ -z "$DISKSIZE" ] && [ -z "$STREAMS" ]; then
        exit 0
    fi

    ZRAM_DEV="/sys/block/zram0"

    # Disable swap on zram0 first
    swapoff /dev/block/zram0 2>/dev/null

    # Reset zram device
    echo 1 > "$ZRAM_DEV/reset"

    # Apply algorithm
    if [ -n "$ALGO" ]; then
        echo "$ALGO" > "$ZRAM_DEV/comp_algorithm" 2>/dev/null
    fi

    # Apply max compression streams
    if [ -n "$STREAMS" ]; then
        echo "$STREAMS" > "$ZRAM_DEV/max_comp_streams" 2>/dev/null
    fi

    # Apply disk size
    if [ -n "$DISKSIZE" ] && [ "$DISKSIZE" -gt 0 ] 2>/dev/null; then
        echo "$DISKSIZE" > "$ZRAM_DEV/disksize" 2>/dev/null
    fi

    # Re-enable swap
    mkswap /dev/block/zram0 2>/dev/null
    swapon /dev/block/zram0 2>/dev/null
fi

exit 0

