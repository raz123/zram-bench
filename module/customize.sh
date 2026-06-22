#!/system/bin/sh
# customize.sh — KernelSU Module Installer
# Runs during module install/update. Extracts and sets up files.

SKIPUNZIP=1

ui_print "────────────────────────────────────────"
ui_print "  ZRAM Benchmark Module Installer"
ui_print "────────────────────────────────────────"
ui_print ""

# ── Extract module files ──────────────────────────────────────
ui_print "- Extracting module files"
unzip -o "$ZIPFILE" -d "$MODPATH" >&2

# ── Set permissions on CLI wrapper ────────────────────────────
ui_print "- Setting permissions on CLI wrapper"
set_perm_recursive "$MODPATH/system/bin" 0 0 0755 0755
set_perm "$MODPATH/system/bin/zram-bench" 0 0 0755

# ── Set permissions on benchmark script ───────────────────────
ui_print "- Setting permissions on benchmark script"
set_perm "$MODPATH/zram_bench.sh" 0 0 0755 2>/dev/null

# ── Set permissions on webroot (if present) ───────────────────
if [ -d "$MODPATH/webroot" ]; then
    ui_print "- Setting permissions on webroot"
    set_perm_recursive "$MODPATH/webroot" 0 0 0644 0644
fi

# ── Done ──────────────────────────────────────────────────────
ui_print ""
ui_print "────────────────────────────────────────"
ui_print "  Installation complete!"
ui_print "────────────────────────────────────────"
ui_print ""
ui_print "Usage:"
ui_print "  Quick test:  zram-bench --quick"
ui_print "  Full test:   zram-bench --full"
ui_print "  Help:        zram-bench --help"
ui_print ""
