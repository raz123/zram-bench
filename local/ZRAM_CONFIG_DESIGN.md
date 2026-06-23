# ZRAM Configuration Screen — Design Document

## Overview

A ZRAM configuration panel that lets users view and modify live zram settings (disksize, algorithm, max_comp_streams) from the WebUI, with persistence across reboots and safety guardrails.

---

## 1. Placement: Collapsible Section

**Decision**: New collapsible section titled **"ZRAM Settings"** placed between the Benchmark Options section and the Controls section (buttons).

**Rationale**:
- The app is a single-page vertical-scroll layout — no tabs, no routing. A modal would obscure the device info card that shows current zram state. A separate page would break the single-file architecture.
- The existing `.collapsible` pattern (used for "Advanced Options") is a proven, accessible, CSS-animated component that fits perfectly.
- Placing it above the benchmark buttons keeps the flow logical: *configure zram → configure benchmark → run*.
- The "Advanced Options" collapsible is for **benchmark** parameters (test patterns, data size, iterations, streams). The new "ZRAM Settings" collapsible is for **device** parameters. They serve different purposes and must not be conflated.

**Visual position in the page**:

```
┌─────────────────────────────────────┐
│  ZRAM Benchmark            v1.0     │
│  ┌─────────────────────────────┐    │
│  │ Model: SM8250               │    │
│  │ Kernel: 5.10.x  | Algo: lz4│    │
│  │ ZRAM Size: 8192 MB          │    │
│  └─────────────────────────────┘    │
│                                     │
│  ┌─ Benchmark Options ───────────┐  │
│  │ Algorithms: ☑lz4 ☑zstd ...   │  │
│  │ ▼ Advanced Options            │  │
│  └───────────────────────────────┘  │
│                                     │
│  ┌─ ZRAM Settings ───────────────┐  │  ← NEW
│  │ ▼ ZRAM Settings          ▲    │  │
│  │ ┌─ Edit fields, buttons ───┐  │  │
│  │ │                          │  │  │
│  │ └──────────────────────────┘  │  │
│  └───────────────────────────────┘  │
│                                     │
│  [Quick Test]  [Full Benchmark]     │
│                                     │
│  ... results, history ...           │
└─────────────────────────────────────┘
```

---

## 2. Wireframe — Expanded State

```
┌─ ZRAM Settings ──────────────────────────────────────┐
│                                                       │
│  ⚠ ZRAM settings affect system swap. Changing them   │
│  while swap is active may cause instability.          │
│  These changes persist across reboots.                │
│                                                       │
│  ┌─────────────────────────────────────────────────┐  │
│  │ Compression Algorithm                           │  │
│  │ ┌─────────────────────────────────────────────┐  │  │
│  │ │  lz4  ▼                                     │  │  │
│  │ └─────────────────────────────────────────────┘  │  │
│  │ Available: lz4, zstd, lzo-rle, lzo              │  │
│  │ Current: lz4  •  Default: lz4                    │  │
│  └─────────────────────────────────────────────────┘  │
│                                                       │
│  ┌─────────────────────────────────────────────────┐  │
│  │ Disk Size                                       │  │
│  │ ┌───────────────────────┐ ┌──────────────────┐  │  │
│  │ │  8192                 │ │  MB          ▼   │  │  │
│  │ └───────────────────────┘ └──────────────────┘  │  │
│  │ Current: 8192 MB  •  Default: (kernel default)  │  │
│  └─────────────────────────────────────────────────┘  │
│                                                       │
│  ┌─────────────────────────────────────────────────┐  │
│  │ Max Compression Streams                         │  │
│  │ ┌─────────────────────────────────────────────┐  │  │
│  │ │  8                                            │  │  │
│  │ └─────────────────────────────────────────────┘  │  │
│  │ Range: 1 – 8 (CPU cores)                        │  │
│  │ Current: 8  •  Default: 8                        │  │
│  └─────────────────────────────────────────────────┘  │
│                                                       │
│  ┌──────────────┐  ┌──────────────┐  ┌────────────┐  │
│  │ Apply Changes │  │ Reset to     │  │ Cancel     │  │
│  │   (primary)   │  │ Defaults     │  │            │  │
│  └──────────────┘  └──────────────┘  └────────────┘  │
│                                                       │
│  Status: ● Applied — all changes active               │
└───────────────────────────────────────────────────────┘
```

---

## 3. Controls — Per Setting

### 3.1 Compression Algorithm (`comp_algorithm`)

| Property | Value |
|----------|-------|
| **sysfs path** | `/sys/block/zram0/comp_algorithm` |
| **Read format** | `lzo lzo-rle [lz4] lz4hc lz4k deflate 842 zstd` — brackets mark active |
| **Write constraint** | Must be set BEFORE disksize on SM8250 |
| **UI control** | `<select>` dropdown |
| **Options** | Dynamically populated from the bracket-parsed list (reuse existing `loadDeviceInfo` parsing logic) |
| **Default** | `lz4` |
| **Validation** | Must be one of the available algorithms from the device |
| **Safety** | ⚠ MEDIUM — Changing algo alone is safe, but may require zram reset on some kernels |

### 3.2 Disk Size (`disksize`)

| Property | Value |
|----------|-------|
| **sysfs path** | `/sys/block/zram0/disksize` |
| **Read format** | Raw bytes (e.g., `8589934592` for 8 GB) |
| **Write constraint** | Must be set AFTER algorithm; requires zram reset first; swap must be off |
| **UI control** | `<input type="number">` + `<select>` unit (MB / GB) |
| **Default** | Kernel default (device-specific, shown as "—" if unknown) |
| **Validation** | Min: 4 MB, Max: 50% of RAM (read from `/proc/meminfo`), step: 64 MB |
| **Safety** | 🔴 HIGH — Changing disksize resets the zram device, evicts all compressed data, and may break active swap. Requires explicit confirmation dialog. |
| **Additional UX** | Show "50% of RAM = X MB" hint. Disabled input with "Swap active" label if swap is on zram0. |

### 3.3 Max Compression Streams (`max_comp_streams`)

| Property | Value |
|----------|-------|
| **sysfs path** | `/sys/block/zram0/max_comp_streams` |
| **Read format** | Integer (e.g., `8`) |
| **Write constraint** | Can be changed on active device; kernel may clamp |
| **UI control** | `<input type="number">` with min/max |
| **Default** | Device CPU core count |
| **Validation** | Min: 1, Max: CPU cores (`nproc` or `/sys/devices/system/cpu/possible`) |
| **Safety** | 🟢 LOW — Generally safe; kernel silently adjusts if out of range |

---

## 4. Data Flow

### 4.1 Load Current Settings

```
init()
  → loadZramSettings()  [parallel with loadDeviceInfo()]
      → shell('cat /sys/block/zram0/comp_algorithm')
          → parse [active] format → state.zram.algo
      → shell('cat /sys/block/zram0/disksize')
          → bytes → MB → state.zram.disksize
      → shell('cat /sys/block/zram0/max_comp_streams')
          → integer → state.zram.streams
      → shell('cat /proc/meminfo | grep MemTotal')
          → bytes → MB → state.zram.totalRam (for validation)
      → shell('swapon --show | grep zram0')
          → check if swap active → state.zram.swapActive
      → shell('nproc')
          → CPU count → state.zram.cpuCount (for max_streams validation)
  → populateZramControls()  [render current values into UI]
  → loadZramConfig()  [load persisted user config from JSON]
      → shell('cat /data/adb/modules/zram_bench/zram_config.json')
          → merge with current live values
          → show "modified from default" badge if different
```

### 4.2 Apply Changes

```
applyZramChanges()
  1. Validate all inputs
  2. If disksize changed AND swap is active → BLOCK with dialog:
     "ZRAM swap is currently active. Changing disksize will reset the
      compressed swap device and may cause app crashes or OOM kills.
      Turn off swap first, or cancel."
  3. Read current "original" settings (first-load snapshot)
  4. Show confirmation dialog for any change
  5. Execute in strict order:
     a. echo 1 > /sys/block/zram0/reset          (reset device)
     b. echo <algo> > /sys/block/zram0/comp_algorithm
     c. echo <streams> > /sys/block/zram0/max_comp_streams
     d. echo <disksize_bytes> > /sys/block/zram0/disksize
  6. Verify each write by reading back
  7. If swap was active → warn user to re-enable swap
  8. Save to /data/adb/modules/zram_bench/zram_config.json
  9. Show toast: "ZRAM settings applied" or "Failed: <reason>"
  10. Update device-info card in header
```

### 4.3 Reset to Defaults

```
resetZramDefaults()
  1. Confirmation dialog: "Reset all ZRAM settings to device defaults?"
  2. Execute (same order as apply):
     a. echo 1 > /sys/block/zram0/reset
     b. echo lz4 > /sys/block/zram0/comp_algorithm
     c. (remove max_comp_streams override — let kernel decide)
     d. (remove disksize override — let kernel decide)
  3. Delete /data/adb/modules/zram_bench/zram_config.json
  4. Refresh UI with live values
  5. Toast: "ZRAM settings reset to defaults"
```

### 4.4 Cancel

```
cancelZramEdits()
  1. Revert all form fields to last-known-good values (state.zram.*)
  2. Clear any unsaved changes
  3. Collapse the section
```

---

## 5. Persistence Across Reboots

### 5.1 Config File Format

File: `/data/adb/modules/zram_bench/zram_config.json`

```json
{
  "version": 1,
  "algorithm": "zstd",
  "disksize_mb": 4096,
  "max_comp_streams": 4,
  "applied_at": "2026-06-23T12:00:00Z"
}
```

### 5.2 Boot-time Application

Modify `module/service.sh` (currently a no-op):

```sh
#!/system/bin/sh
# Apply saved ZRAM configuration on boot

CONFIG="/data/adb/modules/zram_bench/zram_config.json"
SYS_ZRAM="/sys/block/zram0"

[ -f "$CONFIG" ] || exit 0

# Parse JSON with grep/sed (no jq dependency on Android)
algo=$(grep '"algorithm"' "$CONFIG" | sed 's/.*: *"//;s/".*//')
disksize_mb=$(grep '"disksize_mb"' "$CONFIG" | sed 's/.*: *//;s/[^0-9].*//')
streams=$(grep '"max_comp_streams"' "$CONFIG" | sed 's/.*: *//;s/[^0-9].*//')

[ -z "$algo" ] && [ -z "$disksize_mb" ] && [ -z "$streams" ] && exit 0

# Reset, apply in order
echo 1 > "$SYS_ZRAM/reset" 2>/dev/null
[ -n "$algo" ] && echo "$algo" > "$SYS_ZRAM/comp_algorithm" 2>/dev/null
[ -n "$streams" ] && echo "$streams" > "$SYS_ZRAM/max_comp_streams" 2>/dev/null
[ -n "$disksize_mb" ] && {
    disksize_bytes=$((disksize_mb * 1048576))
    echo "$disksize_bytes" > "$SYS_ZRAM/disksize" 2>/dev/null
}
```

### 5.3 Module Uninstall Cleanup

Modify `module/uninstall.sh` — add config file removal:

```sh
rm -f /data/adb/modules/zram_bench/zram_config.json 2>/dev/null
```

The existing uninstall already resets algorithm to `lz4`.

---

## 6. Safety Guardrails

### 6.1 Disksize Danger Zone

When user modifies disksize, show an inline warning panel:

```
┌─ ⚠ Disk Size Change ───────────────────────────────┐
│ Changing disksize requires resetting the ZRAM        │
│ device. This will:                                   │
│ • Evict all compressed data from swap                │
│ • May cause app crashes if swap is in active use     │
│ • Require re-enabling swap after the change          │
│                                                      │
│ Device RAM: 16384 MB — Safe max: 8192 MB (50%)     │
│ Current:    8192 MB → New: 4096 MB                  │
└──────────────────────────────────────────────────────┘
```

### 6.2 Swap Active Block

If swap is active on zram0 when user tries to change disksize:
- **Block the operation** — don't just warn. Disksize cannot be changed while swap is active (the write will fail or cause kernel panic on some devices).
- Show modal: "Swap is active on ZRAM. Please disable swap first (e.g., `swapoff /dev/block/zram0`) before changing disksize."

### 6.3 Algorithm Change During Benchmark

If a benchmark is running (`state.running === true`):
- Disable the Apply button
- Show tooltip: "Stop the running benchmark before changing ZRAM settings"

### 6.4 Values Out of Range

| Setting | Condition | Response |
|---------|-----------|----------|
| disksize | > 50% RAM | Inline error: "Exceeds safe maximum (50% of RAM)" |
| disksize | < 4 MB | Inline error: "Minimum is 4 MB" |
| disksize | Not multiple of 4096 | Warning: "Should be page-aligned (multiple of 4 KB)" |
| streams | > CPU cores | Warning: "Kernel will clamp to CPU count (N)" |
| streams | < 1 | Inline error: "Minimum is 1" |
| algo | Not in available list | Disabled (dropdown only shows available) |

### 6.5 Original Settings Snapshot

On first load, snapshot the **device's original** (boot-default) zram settings into a hidden variable:

```
state.zram.defaults = {
    algorithm: <current at boot>,
    disksize: <current at boot>,
    streams: <current at boot>
}
```

This is the "Reset to Defaults" target — NOT necessarily `lz4` / 0 / kernel-default. It's what the device had before the user started changing things. Persist this snapshot to `/data/adb/modules/zram_bench/zram_defaults.json` on first read.

---

## 7. Visual Feedback

### 7.1 Status Line

Below the buttons, a persistent status indicator:

```
Status: ● Applied — all changes active
Status: ● Defaults — no custom configuration
Status: ● Modified — changes pending (not yet applied)
```

- **Green dot** = applied and verified
- **Yellow dot** = modified but not applied
- **Gray dot** = defaults (no config file)

### 7.2 Change Indicators

When a value differs from current live value:
- Input field gets a subtle left border accent (`var(--accent)`)
- Small "changed" badge next to the label

### 7.3 Apply Animation

During apply:
1. Buttons disabled
2. Status shows "Applying..." with spinner
3. Each step verified — status updates: "Resetting device..." → "Setting algorithm..." → "Setting streams..." → "Setting disksize..." → "Verifying..."
4. On success: toast + green status + refresh device info card
5. On failure: toast with error + red status + details expandable

### 7.4 Toast Messages

Reuse existing `toast()` function:
- ✅ `toast("ZRAM settings applied successfully", "success")`
- ❌ `toast("Failed to set algorithm: permission denied", "error")`
- ⚠️ `toast("Disksize clamped by kernel to 7168 MB", "")` (default = warning-like)

---

## 8. CSS Additions

All new classes use existing CSS custom properties. No new variables needed.

```css
/* ── ZRAM Settings Section ─────────────────────────────────── */
.zram-settings {
    /* Reuse .options pattern exactly */
    background: var(--card-bg);
    border-radius: 12px;
    padding: 16px;
    margin-bottom: 16px;
}

.zram-settings-title {
    /* Same as .options-title */
    font-size: 14px;
    font-weight: 600;
    color: var(--text-secondary);
    margin-bottom: 12px;
    text-transform: uppercase;
    letter-spacing: 0.5px;
}

.zram-warning-banner {
    background: rgba(251, 191, 36, 0.1);
    border: 1px solid var(--warning);
    border-radius: 6px;
    padding: 10px 12px;
    margin-bottom: 16px;
    font-size: 13px;
    color: var(--warning);
    line-height: 1.5;
}

.zram-setting-group {
    margin-bottom: 16px;
    padding: 12px;
    background: var(--surface-bg);
    border-radius: 8px;
    border: 1px solid var(--border-color);
}

.zram-setting-group.modified {
    border-left: 3px solid var(--accent);
}

.zram-setting-label {
    font-size: 14px;
    font-weight: 500;
    color: var(--text-primary);
    margin-bottom: 6px;
}

.zram-setting-hint {
    font-size: 12px;
    color: var(--text-muted);
    margin-top: 6px;
}

.zram-setting-meta {
    display: flex;
    gap: 12px;
    font-size: 11px;
    color: var(--text-muted);
    margin-top: 6px;
}

.zram-input-row {
    display: flex;
    gap: 8px;
    align-items: center;
}

.zram-input {
    width: 100%;
    padding: 8px 12px;
    font-size: 14px;
    background: var(--bg-input);
    color: var(--text-primary);
    border: 1px solid var(--border-color);
    border-radius: 6px;
    outline: none;
}

.zram-input:focus {
    border-color: var(--primary-color);
}

.zram-input:disabled {
    opacity: 0.5;
    cursor: not-allowed;
}

.zram-input.error {
    border-color: var(--danger);
}

.zram-input-select {
    width: auto;
    min-width: 80px;
}

.zram-danger-banner {
    background: rgba(248, 113, 113, 0.1);
    border: 1px solid var(--danger);
    border-radius: 6px;
    padding: 10px 12px;
    margin-top: 8px;
    font-size: 12px;
    color: var(--danger);
    line-height: 1.5;
}

.zram-button-row {
    display: flex;
    gap: 8px;
    margin-top: 16px;
}

.zram-status {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 12px;
    color: var(--text-muted);
    margin-top: 12px;
}

.zram-status-dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    display: inline-block;
}

.zram-status-dot.applied { background: var(--success); }
.zram-status-dot.pending { background: var(--warning); }
.zram-status-dot.defaults { background: var(--text-muted); }
.zram-status-dot.error   { background: var(--danger); }

.changed-badge {
    font-size: 10px;
    padding: 1px 6px;
    border-radius: 4px;
    background: var(--accent-dim);
    color: var(--accent);
    margin-left: 6px;
}

/* Confirmation dialog (inline, not browser confirm()) */
.zram-confirm-overlay {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.6);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 1000;
}

.zram-confirm-box {
    background: var(--bg-secondary);
    border: 1px solid var(--border-color);
    border-radius: var(--radius-lg);
    padding: 20px;
    max-width: 360px;
    width: 90%;
}

.zram-confirm-title {
    font-size: 16px;
    font-weight: 600;
    color: var(--text-primary);
    margin-bottom: 8px;
}

.zram-confirm-body {
    font-size: 14px;
    color: var(--text-secondary);
    margin-bottom: 16px;
    line-height: 1.5;
}

.zram-confirm-actions {
    display: flex;
    gap: 8px;
    justify-content: flex-end;
}
```

---

## 9. JavaScript Implementation

### 9.1 State Extensions

Add to existing `state` object:

```js
const state = {
    running: false,
    results: null,
    history: [],
    activeHistoryIdx: null,
    // NEW
    zram: {
        algo: '',              // current live algo
        disksize: '',          // current live disksize in MB
        streams: '',           // current live streams
        totalRam: 0,           // device RAM in MB
        cpuCount: 0,           // CPU core count
        swapActive: false,     // is swap on zram0?
        defaults: null,        // boot-time original values
        configLoaded: false,   // has user config been loaded?
    },
};
```

### 9.2 Key Functions

```js
// ── ZRAM Settings ──────────────────────────────────────

const ZRAM_CONFIG_PATH = '/data/adb/modules/zram_bench/zram_config.json';
const ZRAM_DEFAULTS_PATH = '/data/adb/modules/zram_bench/zram_defaults.json';
const SYS_ZRAM = '/sys/block/zram0';

async function loadZramSettings() {
    // Read all live values in parallel
    const [algoRaw, disksizeRaw, streamsRaw, memInfo, cpuRaw, swapRaw] =
        await Promise.all([
            shell(`cat ${SYS_ZRAM}/comp_algorithm 2>/dev/null`).catch(() => ''),
            shell(`cat ${SYS_ZRAM}/disksize 2>/dev/null`).catch(() => '0'),
            shell(`cat ${SYS_ZRAM}/max_comp_streams 2>/dev/null`).catch(() => '0'),
            shell(`awk '/MemTotal/{print $2}' /proc/meminfo`).catch(() => '0'),
            shell(`nproc 2>/dev/null || cat /sys/devices/system/cpu/possible | awk -F- '{print $2+1}'`).catch(() => '8'),
            shell(`swapon --show 2>/dev/null | grep zram0 || echo ""`).catch(() => ''),
        ]);

    // Parse algorithm
    const algoMatch = algoRaw.match(/\[([^\]]+)\]/);
    state.zram.algo = algoMatch ? algoMatch[1] : 'lz4';

    // Parse disksize: bytes → MB
    const disksizeBytes = parseInt(disksizeRaw.trim(), 10) || 0;
    state.zram.disksize = disksizeBytes > 0 ? Math.round(disksizeBytes / 1048576) : 0;

    // Parse streams
    state.zram.streams = parseInt(streamsRaw.trim(), 10) || 1;

    // Parse total RAM: kB → MB
    state.zram.totalRam = parseInt(memInfo.trim(), 10) / 1024 || 0;

    // Parse CPU count
    state.zram.cpuCount = parseInt(cpuRaw.trim(), 10) || 8;

    // Check swap
    state.zram.swapActive = swapRaw.trim().length > 0;

    // Populate UI
    populateZramControls();

    // Load persisted config (may override display values)
    await loadZramConfig();
}

function populateZramControls() {
    // Algorithm dropdown
    const algoSelect = $('#zram-algo');
    if (algoSelect) {
        // Options already populated by loadDeviceInfo() reusing same parse
        algoSelect.value = state.zram.algo;
    }

    // Disksize input
    const diskInput = $('#zram-disksize');
    if (diskInput) {
        diskInput.value = state.zram.disksize || '';
        diskInput.max = Math.floor(state.zram.totalRam * 0.5);
    }

    // Streams input
    const streamsInput = $('#zram-streams');
    if (streamsInput) {
        streamsInput.value = state.zram.streams;
        streamsInput.max = state.zram.cpuCount;
    }

    // Swap warning
    const swapWarn = $('#zram-swap-warning');
    if (swapWarn) {
        swapWarn.style.display = state.zram.swapActive ? '' : 'none';
    }

    // Update status dot
    updateZramStatus();
}

async function loadZramConfig() {
    try {
        const json = await shell(`cat ${ZRAM_CONFIG_PATH} 2>/dev/null`);
        if (!json || !json.trim()) return;
        const config = JSON.parse(json.trim());
        state.zram.configLoaded = true;

        // Populate form fields with saved config (may differ from live)
        if (config.algorithm) {
            $('#zram-algo').value = config.algorithm;
        }
        if (config.disksize_mb) {
            $('#zram-disksize').value = config.disksize_mb;
        }
        if (config.max_comp_streams) {
            $('#zram-streams').value = config.max_comp_streams;
        }

        updateZramStatus();
    } catch (e) {
        // Config file doesn't exist or invalid — that's fine
        if (DEBUG) console.log('[zram-bench] No saved config:', e.message);
    }
}

async function loadZramDefaults() {
    // Snapshot current values as "defaults" if no defaults file exists
    try {
        const json = await shell(`cat ${ZRAM_DEFAULTS_PATH} 2>/dev/null`);
        if (json && json.trim()) {
            state.zram.defaults = JSON.parse(json.trim());
            return;
        }
    } catch (_) {}

    // First run: save current as defaults
    state.zram.defaults = {
        algorithm: state.zram.algo,
        disksize_mb: state.zram.disksize,
        max_comp_streams: state.zram.streams,
    };
    await shell(`cat > ${ZRAM_DEFAULTS_PATH} << 'EOF'
${JSON.stringify(state.zram.defaults, null, 2)}
EOF`);
}

async function applyZramChanges() {
    if (state.running) {
        toast('Stop the running benchmark first', 'error');
        return;
    }

    // Gather form values
    const newAlgo = $('#zram-algo').value;
    const newDisksizeMB = parseInt($('#zram-disksize').value, 10);
    const newStreams = parseInt($('#zram-streams').value, 10);

    // Validate
    const errors = validateZramInputs(newAlgo, newDisksizeMB, newStreams);
    if (errors.length > 0) {
        errors.forEach(e => toast(e, 'error'));
        return;
    }

    // Disksize safety check
    if (newDisksizeMB !== state.zram.disksize && state.zram.swapActive) {
        showZramConfirmDialog(
            '⚠ Swap is Active',
            'ZRAM swap is currently active. Changing disksize will reset the compressed device and may cause app crashes or OOM kills.\n\nPlease disable swap first:\nswapoff /dev/block/zram0',
            [{ label: 'OK', primary: true }]
        );
        return;
    }

    // Confirmation for any change
    const changes = describeChanges(newAlgo, newDisksizeMB, newStreams);
    if (changes.length === 0) {
        toast('No changes to apply', '');
        return;
    }

    const confirmed = await showZramConfirmDialog(
        'Apply ZRAM Changes',
        changes.join('\n'),
        [
            { label: 'Cancel', primary: false },
            { label: 'Apply', primary: true },
        ]
    );
    if (!confirmed) return;

    // Execute changes
    updateZramStatus('applying');

    try {
        // Step 1: Reset device
        updateZramStatus('applying', 'Resetting device...');
        await shell(`echo 1 > ${SYS_ZRAM}/reset`);
        await new Promise(r => setTimeout(r, 200)); // brief settle

        // Step 2: Set algorithm (must be before disksize)
        updateZramStatus('applying', 'Setting algorithm...');
        await shell(`echo ${newAlgo} > ${SYS_ZRAM}/comp_algorithm`);
        await new Promise(r => setTimeout(r, 100));

        // Step 3: Set streams
        updateZramStatus('applying', 'Setting streams...');
        await shell(`echo ${newStreams} > ${SYS_ZRAM}/max_comp_streams`);
        await new Promise(r => setTimeout(r, 100));

        // Step 4: Set disksize (must be last)
        if (newDisksizeMB > 0) {
            updateZramStatus('applying', 'Setting disksize...');
            const disksizeBytes = newDisksizeMB * 1048576;
            await shell(`echo ${disksizeBytes} > ${SYS_ZRAM}/disksize`);
            await new Promise(r => setTimeout(r, 200));
        }

        // Step 5: Verify
        updateZramStatus('applying', 'Verifying...');
        const verifyAlgo = (await shell(`cat ${SYS_ZRAM}/comp_algorithm`)).match(/\[([^\]]+)\]/)?.[1];
        const verifyDisksize = Math.round(parseInt(await shell(`cat ${SYS_ZRAM}/disksize`), 10) / 1048576);
        const verifyStreams = parseInt(await shell(`cat ${SYS_ZRAM}/max_comp_streams`), 10);

        // Update live state
        state.zram.algo = verifyAlgo || newAlgo;
        state.zram.disksize = verifyDisksize || newDisksizeMB;
        state.zram.streams = verifyStreams || newStreams;

        // Persist config
        await saveZramConfig(newAlgo, newDisksizeMB, newStreams);

        // Update header device info
        dom.deviceAlgo.textContent = state.zram.algo;
        dom.deviceDisksize.textContent = state.zram.disksize + ' MB';

        // Sync form fields back to actual values
        populateZramControls();
        markAllClean();

        updateZramStatus('applied');
        toast('ZRAM settings applied successfully', 'success');

    } catch (e) {
        updateZramStatus('error', e.message);
        toast('Failed to apply ZRAM settings: ' + e.message, 'error');
        // Reload live values
        await loadZramSettings();
    }
}

function validateZramInputs(algo, disksizeMB, streams) {
    const errors = [];
    if (!algo) errors.push('Algorithm is required');
    if (disksizeMB < 0) errors.push('Disksize cannot be negative');
    if (disksizeMB > 0 && disksizeMB < 4) errors.push('Disksize minimum is 4 MB');
    if (disksizeMB > state.zram.totalRam * 0.5) {
        errors.push(`Disksize exceeds safe maximum (${Math.floor(state.zram.totalRam * 0.5)} MB = 50% of RAM)`);
    }
    if (streams < 1) errors.push('Streams minimum is 1');
    if (streams > state.zram.cpuCount * 2) {
        // Allow up to 2× CPU count but warn
    }
    return errors;
}

function describeChanges(newAlgo, newDisksizeMB, newStreams) {
    const changes = [];
    // Compare against CURRENT form values (what user started editing from)
    const currentAlgo = state.zram.algo;
    const currentDisksize = state.zram.disksize;
    const currentStreams = state.zram.streams;

    if (newAlgo !== currentAlgo) {
        changes.push(`Algorithm: ${currentAlgo} → ${newAlgo}`);
    }
    if (newDisksizeMB !== currentDisksize && newDisksizeMB > 0) {
        changes.push(`Disksize: ${currentDisksize} MB → ${newDisksizeMB} MB`);
    }
    if (newStreams !== currentStreams) {
        changes.push(`Streams: ${currentStreams} → ${newStreams}`);
    }
    return changes;
}

async function saveZramConfig(algo, disksizeMB, streams) {
    const config = {
        version: 1,
        algorithm: algo,
        disksize_mb: disksizeMB,
        max_comp_streams: streams,
        applied_at: new Date().toISOString(),
    };
    await shell(`cat > ${ZRAM_CONFIG_PATH} << 'ENDCONF'
${JSON.stringify(config, null, 2)}
ENDCONF`);
}

async function resetZramDefaults() {
    if (state.running) {
        toast('Stop the running benchmark first', 'error');
        return;
    }

    const defaults = state.zram.defaults || { algorithm: 'lz4', disksize_mb: 0, max_comp_streams: state.zram.cpuCount };

    const confirmed = await showZramConfirmDialog(
        'Reset to Defaults',
        `Reset ZRAM settings to device defaults?\n\nAlgorithm: ${defaults.algorithm}\nDisksize: ${defaults.disksize_mb || 'kernel default'} MB\nStreams: ${defaults.max_comp_streams}`,
        [
            { label: 'Cancel', primary: false },
            { label: 'Reset', primary: true },
        ]
    );
    if (!confirmed) return;

    try {
        await shell(`echo 1 > ${SYS_ZRAM}/reset`);
        await new Promise(r => setTimeout(r, 200));
        await shell(`echo ${defaults.algorithm} > ${SYS_ZRAM}/comp_algorithm`);
        if (defaults.disksize_mb > 0) {
            await shell(`echo $((defaults.disksize_mb * 1048576)) > ${SYS_ZRAM}/disksize`);
        }
        await shell(`rm -f ${ZRAM_CONFIG_PATH}`);
        state.zram.configLoaded = false;
        await loadZramSettings();
        loadZramDefaults(); // re-save defaults
        toast('ZRAM settings reset to defaults', 'success');
    } catch (e) {
        toast('Reset failed: ' + e.message, 'error');
    }
}
```

---

## 10. HTML Additions

Insert after the closing `</section>` of `#options-section` (line 103 in current HTML):

```html
<!-- ZRAM Settings Section -->
<section class="zram-settings" id="zram-section">
    <div class="zram-warning-banner" id="zram-swap-warning" style="display:none;">
        ⚠ ZRAM swap is active. Disksize changes are blocked until swap is disabled.
    </div>

    <div class="collapsible">
        <button class="collapsible-toggle" id="zram-toggle" aria-expanded="false" aria-controls="zram-content">
            ZRAM Settings <span class="chevron">&#9662;</span>
        </button>
        <div class="collapsible-content" id="zram-content">
            <div>
                <!-- Algorithm -->
                <div class="zram-setting-group" id="zram-group-algo">
                    <label class="zram-setting-label">Compression Algorithm</label>
                    <select id="zram-algo" class="select-input"></select>
                    <div class="zram-setting-meta">
                        <span>Current: <strong id="zram-algo-current">—</strong></span>
                        <span>Default: <strong id="zram-algo-default">—</strong></span>
                    </div>
                </div>

                <!-- Disksize -->
                <div class="zram-setting-group" id="zram-group-disk">
                    <label class="zram-setting-label">Disk Size</label>
                    <div class="zram-input-row">
                        <input type="number" id="zram-disksize" class="zram-input"
                               min="0" step="64" placeholder="0 = kernel default">
                        <select id="zram-disksize-unit" class="select-input zram-input-select">
                            <option value="1">MB</option>
                            <option value="1024">GB</option>
                        </select>
                    </div>
                    <div class="zram-setting-meta">
                        <span>Current: <strong id="zram-disk-current">—</strong></span>
                        <span>RAM: <strong id="zram-ram-info">—</strong></span>
                    </div>
                    <div class="zram-danger-banner" id="zram-disk-danger" style="display:none;"></div>
                </div>

                <!-- Max Comp Streams -->
                <div class="zram-setting-group" id="zram-group-streams">
                    <label class="zram-setting-label">Max Compression Streams</label>
                    <input type="number" id="zram-streams" class="zram-input"
                           min="1" step="1" placeholder="1">
                    <div class="zram-setting-meta">
                        <span>Current: <strong id="zram-streams-current">—</strong></span>
                        <span>CPU cores: <strong id="zram-cpu-count">—</strong></span>
                    </div>
                </div>

                <!-- Actions -->
                <div class="zram-button-row">
                    <button id="zram-apply" class="btn btn-primary" style="flex:2;">
                        Apply Changes
                    </button>
                    <button id="zram-reset" class="btn btn-secondary">
                        Reset
                    </button>
                    <button id="zram-cancel" class="btn btn-text">
                        Cancel
                    </button>
                </div>

                <!-- Status -->
                <div class="zram-status" id="zram-status">
                    <span class="zram-status-dot defaults" id="zram-status-dot"></span>
                    <span id="zram-status-text">Loading...</span>
                </div>
            </div>
        </div>
    </div>
</section>
```

---

## 11. Implementation Plan

### Phase 1: HTML + CSS (UI Shell)
1. Add the ZRAM Settings section to `index.html` after `#options-section`
2. Add all new CSS classes to `style.css`
3. Wire up the collapsible toggle (reusing existing `.collapsible` pattern)
4. **Files**: `module/webroot/index.html`, `module/webroot/style.css`

### Phase 2: JavaScript — Read & Display
1. Add `state.zram` object
2. Implement `loadZramSettings()` — read sysfs values
3. Implement `populateZramControls()` — fill form fields
4. Implement `updateZramStatus()` — status dot logic
5. Add `loadZramSettings()` call to `init()` (parallel with existing `loadDeviceInfo`)
6. Sync algorithm dropdown with device-info algorithm parsing
7. **File**: `module/webroot/script.js`

### Phase 3: JavaScript — Apply & Validate
1. Implement `validateZramInputs()`
2. Implement `describeChanges()` — diff current vs new
3. Implement `applyZramChanges()` — reset → algo → streams → disksize
4. Implement inline confirmation dialog (custom, not `window.confirm()`)
5. Implement swap-active blocking for disksize
6. **File**: `module/webroot/script.js`

### Phase 4: JavaScript — Reset & Cancel
1. Implement `resetZramDefaults()`
2. Implement `cancelZramEdits()` — revert form fields
3. Implement `loadZramDefaults()` — snapshot on first run
4. **File**: `module/webroot/script.js`

### Phase 5: Persistence — Service Script
1. Write `module/service.sh` to apply saved config on boot
2. Implement `saveZramConfig()` in JS
3. Implement `loadZramConfig()` in JS
4. Add config cleanup to `module/uninstall.sh`
5. **Files**: `module/service.sh`, `module/uninstall.sh`, `module/webroot/script.js`

### Phase 6: Testing
1. Verify all sysfs reads return expected values
2. Test apply flow: change algo → verify → read back
3. Test disksize change with swap active (should block)
4. Test reset to defaults
5. Test cancel reverts form
6. Test persistence: apply → reboot → verify applied
7. Test uninstall cleans up config
8. Test concurrent benchmark + settings change (should block)

---

## 12. Edge Cases & Considerations

| Scenario | Handling |
|----------|----------|
| Kernel doesn't support writing to `comp_algorithm` | Show error toast; reload live value; disable algorithm dropdown |
| `disksize` write silently fails (swap active) | Read back after write; if unchanged, show error |
| `max_comp_streams` clamped by kernel | Read back; show toast "Kernel clamped streams to N" |
| User enters disksize in wrong unit | Unit selector prevents confusion; validation catches absurd values |
| Very first boot (no config, no defaults) | Snapshot current as defaults; show "No custom configuration" |
| Module updated (new version) | Config file version field allows future migration |
| `ksu.exec()` not available | Falls back to same pattern as existing `shell()` with callback |
| Device has multiple zram devices | Hardcode `zram0` — consistent with existing benchmark script |
| JSON parse fails on config file | Delete corrupted file; treat as no config; toast warning |

---

## 13. Summary of File Changes

| File | Change Type | Description |
|------|-------------|-------------|
| `module/webroot/index.html` | ADD | ZRAM Settings collapsible section (~40 lines of HTML) |
| `module/webroot/style.css` | ADD | `.zram-*` CSS classes (~150 lines) |
| `module/webroot/script.js` | ADD | `state.zram`, `loadZramSettings()`, `applyZramChanges()`, `resetZramDefaults()`, validation, persistence (~250 lines) |
| `module/service.sh` | MODIFY | Replace no-op with boot-time config application (~25 lines) |
| `module/uninstall.sh` | ADD | `rm -f zram_config.json` and `rm -f zram_defaults.json` (~2 lines) |
