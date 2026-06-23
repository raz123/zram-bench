const DEBUG = false;
if (DEBUG) console.log('[zram-bench] script loaded');

window.onerror = function(msg, url, line, col, error) {
    document.body.innerHTML = '<div style="padding:20px;color:#f44;font-family:monospace"><h2>JavaScript Error</h2><p>' + sanitize(msg) + '</p><p>Line: ' + line + '</p></div>';
    return false;
};

window.onunhandledrejection = function(e) {
    window.onerror(e.reason?.message || String(e.reason), '', 0, 0, e.reason);
    return false;
};

// Sanitize HTML to prevent XSS
function sanitize(str) {
    if (typeof str !== 'string') return '';
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
}

/**
 * ZRAM Benchmark — KernelSU WebUI Dashboard
 * Uses ksu.exec() for root shell access.
 */

// ── State ──────────────────────────────────────────────────────
const state = {
    running: false,
    results: null,
    history: [],
    activeHistoryIdx: null,
};

const BENCH_BIN_CANDIDATES = [
    '/system/bin/zram-bench',
    '/data/adb/modules/zram_bench/zram-bench',
    '/data/adb/modules/zram_bench/system/bin/zram-bench',
];
let BENCH_BIN = BENCH_BIN_CANDIDATES[0]; // resolved at init
const RESULTS_PATH = '/data/local/tmp/zram_bench/.results/final.json';
const HISTORY_KEY = 'zram-bench_history';
const MAX_HISTORY = 20;

// ── DOM refs ───────────────────────────────────────────────────
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

let dom = {};

// ── Helpers ────────────────────────────────────────────────────
async function shell(cmd, timeoutMs = 30000) {
    if (DEBUG) console.log('[zram-bench] shell():', cmd.substring(0, 80));
    if (typeof ksu === 'undefined' || typeof ksu.exec !== 'function') {
        console.error('[zram-bench] ksu.exec NOT available');
        throw new Error('ksu.exec not available — root access required');
    }
    
    return new Promise((resolve, reject) => {
        let timerId;
        const commandPromise = (async () => {
            try {
                const result = await ksu.exec(cmd);
                if (DEBUG) console.log('[zram-bench] ksu.exec result type:', typeof result);
                if (typeof result === 'object' && result !== null) {
                    return result.stdout || JSON.stringify(result);
                }
                return String(result);
            } catch (e) {
                if (DEBUG) console.log('[zram-bench] Promise-based failed, trying callback:', e.message);
                return new Promise((resolve2, reject2) => {
                    try {
                        ksu.exec(cmd, (result) => resolve2(result));
                    } catch (e2) {
                        reject2(new Error('ksu.exec failed: ' + e2.message));
                    }
                });
            }
        })();
        
        timerId = setTimeout(() => reject(new Error('Command timed out after ' + (timeoutMs/1000) + 's')), timeoutMs);
        
        commandPromise.then((result) => {
            clearTimeout(timerId);
            resolve(result);
        }, (err) => {
            clearTimeout(timerId);
            reject(err);
        });
    });
}

function shellLines(cmd) {
    return shell(cmd).then((raw) => {
        if (!raw) return [];
        return raw.split('\n').map((l) => l.trim()).filter(Boolean);
    });
}

function toast(msg, type = '') {
    let container = document.querySelector('.toast-container');
    if (!container) {
        container = document.createElement('div');
        container.className = 'toast-container';
        document.body.appendChild(container);
    }
    const t = document.createElement('div');
    t.className = 'toast' + (type ? ' ' + type : '');
    t.textContent = msg;
    container.appendChild(t);
    setTimeout(() => {
        t.style.opacity = '0';
        t.style.transition = 'opacity 0.3s';
        setTimeout(() => t.remove(), 300);
    }, 2500);
}

function formatBytes(bytes) {
    if (!bytes || bytes === 0) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB'];
    let i = 0;
    let v = Number(bytes);
    while (v >= 1024 && i < units.length - 1) {
        v /= 1024;
        i++;
    }
    return v.toFixed(i > 0 ? 1 : 0) + ' ' + units[i];
}

function formatMBs(val) {
    const n = Number(val);
    if (!isFinite(n) || isNaN(n)) return '--';
    return n.toFixed(1);
}

function formatRatio(val) {
    if (val === 'inf' || val === Infinity || val === 'Infinity') return 'inf';
    const n = Number(val);
    if (!isFinite(n) || isNaN(n)) return '--';
    return n.toFixed(2);
}

function formatDate(ts) {
    const d = new Date(ts);
    return d.toLocaleDateString(undefined, {
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
    });
}

function groupByAlgo(results) {
    const groups = {};
    for (const r of results) {
        if (!groups[r.algorithm]) groups[r.algorithm] = [];
        groups[r.algorithm].push(r);
    }
    return groups;
}

function avgOf(arr, key) {
    const nums = arr.map((r) => Number(r[key])).filter((n) => isFinite(n));
    if (nums.length === 0) return 0;
    return nums.reduce((a, b) => a + b, 0) / nums.length;
}

// ── Device Info ────────────────────────────────────────────────
// Update algorithm checkboxes based on device capabilities
function updateAlgoCheckboxes(available, current) {
    const container = document.querySelector('input[name="algo"]').closest('.checkbox-group');
    if (!container) return;
    
    // Clear existing checkboxes
    container.innerHTML = '';
    
    // Add checkboxes for available algorithms
    available.forEach(algo => {
        const label = document.createElement('label');
        label.className = 'checkbox';
        
        const input = document.createElement('input');
        input.type = 'checkbox';
        input.name = 'algo';
        input.value = algo;
        input.checked = algo === current;  // Pre-check current algorithm
        
        label.appendChild(input);
        label.appendChild(document.createTextNode(' ' + algo));
        container.appendChild(label);
    });
    
    // If no algorithms found, show a message
    if (available.length === 0) {
        container.innerHTML = '<span class="empty-state">No algorithms detected</span>';
    }
}

async function loadDeviceInfo() {
    try {
        const [model, kernel, algo, disksize] = await Promise.all([
            shell('getprop ro.product.model').catch(() => '--'),
            shell('uname -r').catch(() => '--'),
            shell('cat /sys/block/zram0/comp_algorithm 2>/dev/null || echo --').catch(() => '--'),
            shell('awk \'{printf "%.0f", $2/1048576}\' /sys/block/zram0/disksize 2>/dev/null || echo --').catch(() => '--'),
        ]);

        dom.deviceModel.textContent = model || '--';
        dom.deviceKernel.textContent = kernel || '--';
        
        // Parse comp_algorithm: "lzo lzo-rle [lz4] lz4hc lz4k lz4k_oplus lz4kd deflate 842 zstd"
        const algoLine = (algo || '').trim();
        const currentAlgo = (algoLine.match(/\[([^\]]+)\]/) || [])[1] || '';
        const availableAlgos = algoLine.replace(/[\[\]]/g, '').trim().split(/\s+/).filter(Boolean);
        
        dom.deviceAlgo.textContent = currentAlgo || '--';
        dom.deviceDisksize.textContent = disksize && disksize !== '0' ? disksize + ' MB' : (disksize === '0' ? '0 MB (unconfigured)' : '--');
        
        // Update algorithm checkboxes based on device capabilities
        updateAlgoCheckboxes(availableAlgos, currentAlgo);

    } catch (e) {
        console.error('loadDeviceInfo:', e);
    }
}
// ── Install CLI ────────────────────────────────────────────────
async function installCLI() {
    const btn = document.getElementById('btn-install-cli');
    if (btn) btn.disabled = true;
    try {
        // Primary: try symlink in /system/bin
        try {
            await shell('mount -o remount,rw /system && ln -sf /data/adb/modules/zram_bench/zram-bench /system/bin/zram-bench && mount -o remount,ro /system');
            dom.version.textContent = 'CLI installed (system)';
            toast('CLI installed to /system/bin/zram-bench', 'success');
            if (btn) btn.style.display = 'none';
            return;
        } catch (e1) {
            if (DEBUG) console.log('[zram-bench] system install failed:', e1.message);
        }
        // Fallback: copy to /data/local/bin
        await shell('mkdir -p /data/local/bin && cp /data/adb/modules/zram_bench/zram-bench /data/local/bin/zram-bench && chmod +x /data/local/bin/zram-bench');
        dom.version.textContent = 'CLI installed (local)';
        toast('CLI installed to /data/local/bin/zram-bench', 'success');
        if (btn) btn.style.display = 'none';
    } catch (e) {
        toast('Install failed: ' + e.message, 'error');
    } finally {
        if (btn) btn.disabled = false;
    }
}
// ── ZRAM Settings ─────────────────────────────────────────────
const ZRAM_CONFIG_PATH = '/data/adb/modules/zram_bench/zram_config.json';
let zramDefaults = { algo: '', disksize: 0, streams: 0 };
let zramCurrent = { algo: '', disksize: 0, streams: 0 };

async function loadZramSettings() {
    try {
        const [algoRaw, disksizeRaw, streamsRaw, cpusRaw] = await Promise.all([
            shell('cat /sys/block/zram0/comp_algorithm 2>/dev/null || echo --'),
            shell('cat /sys/block/zram0/disksize 2>/dev/null || echo 0'),
            shell('cat /sys/block/zram0/max_comp_streams 2>/dev/null || echo --'),
            shell('nproc 2>/dev/null || echo 4'),
        ]);

        // Parse algorithm: "lzo lzo-rle [lz4] lz4hc..."
        const algoLine = (algoRaw || '').trim();
        const currentAlgo = (algoLine.match(/\[([^\]]+)\]/) || [])[1] || '';
        const availableAlgos = algoLine.replace(/[[\]]/g, '').trim().split(/\s+/).filter(Boolean);

        zramCurrent.algo = currentAlgo;
        zramCurrent.disksize = parseInt(disksizeRaw, 10) || 0;
        zramCurrent.streams = parseInt(streamsRaw, 10) || 0;

        if (!zramDefaults.algo) zramDefaults.algo = currentAlgo;
        if (!zramDefaults.disksize) zramDefaults.disksize = zramCurrent.disksize;
        if (!zramDefaults.streams) zramDefaults.streams = zramCurrent.streams;

        const cpus = parseInt(cpusRaw, 10) || 4;
        const totalMem = await shell('awk \'/MemTotal/{print $2}\' /proc/meminfo 2>/dev/null || echo 0');
        const maxDiskMB = Math.floor((parseInt(totalMem, 10) || 0) / 2 / 1024);

        populateZramControls(availableAlgos, cpus, maxDiskMB);
        await checkZramSwap();
    } catch (e) {
        console.error('[zram-bench] loadZramSettings:', e);
        toast('Failed to load ZRAM settings: ' + e.message, 'error');
    }
}

function populateZramControls(availableAlgos, cpus, maxDiskMB) {
    // Algorithm select
    const algoSelect = document.getElementById('zram-algo-select');
    if (algoSelect) {
        algoSelect.innerHTML = '';
        for (const algo of availableAlgos) {
            const opt = document.createElement('option');
            opt.value = algo;
            opt.textContent = algo;
            if (algo === zramCurrent.algo) opt.selected = true;
            algoSelect.appendChild(opt);
        }
    }

    // Current/default displays
    const algoCurrentEl = document.getElementById('algo-current');
    const algoDefaultEl = document.getElementById('algo-default');
    if (algoCurrentEl) algoCurrentEl.textContent = zramCurrent.algo || '--';
    if (algoDefaultEl) algoDefaultEl.textContent = zramDefaults.algo || '--';

    // Disk size
    const disksizeInput = document.getElementById('zram-disksize-input');
    const disksizeCurrentEl = document.getElementById('disksize-current');
    const disksizeMaxEl = document.getElementById('disksize-max');
    const disksizeMB = Math.floor(zramCurrent.disksize / 1048576);
    const defaultDiskMB = Math.floor(zramDefaults.disksize / 1048576);
    if (disksizeInput) {
        disksizeInput.max = maxDiskMB || '';
        disksizeInput.value = disksizeMB;
    }
    if (disksizeCurrentEl) disksizeCurrentEl.textContent = disksizeMB + ' MB';
    if (disksizeMaxEl) disksizeMaxEl.textContent = maxDiskMB + ' MB';

    // Streams
    const streamsInput = document.getElementById('zram-streams-input');
    const streamsCurrentEl = document.getElementById('streams-current');
    const streamsMaxEl = document.getElementById('streams-max');
    if (streamsInput) {
        streamsInput.value = zramCurrent.streams;
        streamsInput.max = cpus;
    }
    if (streamsCurrentEl) streamsCurrentEl.textContent = zramCurrent.streams;
    if (streamsMaxEl) streamsMaxEl.textContent = cpus;
}

async function checkZramSwap() {
    try {
        const swapInfo = await shell('swapon --show 2>/dev/null | grep zram || echo none');
        const swapActive = swapInfo && !swapInfo.includes('none') && swapInfo.trim().length > 0;
        const warningEl = document.getElementById('zram-swap-warning');
        const disksizeInput = document.getElementById('zram-disksize-input');
        const disksizeUnit = document.getElementById('zram-disksize-unit');
        if (warningEl) warningEl.style.display = swapActive ? '' : 'none';
        if (disksizeInput) disksizeInput.disabled = swapActive;
        if (disksizeUnit) disksizeUnit.disabled = swapActive;
        return swapActive;
    } catch (_) {
        return false;
    }
}

function checkZramDirty() {
    const algoSelect = document.getElementById('zram-algo-select');
    const disksizeInput = document.getElementById('zram-disksize-input');
    const streamsInput = document.getElementById('zram-streams-input');

    const algoChanged = algoSelect && algoSelect.value !== zramCurrent.algo;
    const disksizeMB = disksizeInput ? parseInt(disksizeInput.value, 10) : Math.floor(zramCurrent.disksize / 1048576);
    const disksizeUnit = document.getElementById('zram-disksize-unit');
    const unitMul = disksizeUnit ? parseInt(disksizeUnit.value, 10) : 1048576;
    const newDisksize = disksizeMB * unitMul;
    const disksizeChanged = newDisksize !== zramCurrent.disksize;
    const streamsChanged = streamsInput && parseInt(streamsInput.value, 10) !== zramCurrent.streams;

    const applyBtn = document.getElementById('btn-zram-apply');
    if (applyBtn) applyBtn.disabled = !(algoChanged || disksizeChanged || streamsChanged);

    // Update status dots
    updateStatusDot('algo-status', algoChanged);
    updateStatusDot('disksize-status', disksizeChanged);
    updateStatusDot('streams-status', streamsChanged);
}

function updateStatusDot(id, changed) {
    const dot = document.getElementById(id);
    if (!dot) return;
    dot.className = 'zram-status-dot' + (changed ? ' zram-status-dot-changed' : '');
}

async function applyZramChanges() {
    const applyBtn = document.getElementById('btn-zram-apply');
    if (applyBtn) applyBtn.disabled = true;
    try {
        const algoSelect = document.getElementById('zram-algo-select');
        const disksizeInput = document.getElementById('zram-disksize-input');
        const disksizeUnit = document.getElementById('zram-disksize-unit');
        const streamsInput = document.getElementById('zram-streams-input');

        const newAlgo = algoSelect ? algoSelect.value : zramCurrent.algo;
        const disksizeMB = disksizeInput ? parseInt(disksizeInput.value, 10) : 0;
        const unitMul = disksizeUnit ? parseInt(disksizeUnit.value, 10) : 1048576;
        const newDisksize = disksizeMB * unitMul;
        const newStreams = streamsInput ? parseInt(streamsInput.value, 10) : zramCurrent.streams;

        // 1. Reset zram (required before changing parameters)
        toast('Applying ZRAM changes...', '');
        await shell('swapoff /dev/block/zram0 2>/dev/null; echo 1 > /sys/block/zram0/reset');

        // 2. Set algorithm
        if (newAlgo !== zramCurrent.algo) {
            await shell('echo ' + sanitize(newAlgo) + ' > /sys/block/zram0/comp_algorithm');
        }

        // 3. Set max compression streams
        if (newStreams !== zramCurrent.streams) {
            await shell('echo ' + parseInt(newStreams, 10) + ' > /sys/block/zram0/max_comp_streams');
        }

        // 4. Set disk size
        if (newDisksize !== zramCurrent.disksize) {
            await shell('echo ' + newDisksize + ' > /sys/block/zram0/disksize');
        }

        // 5. Re-enable swap if it was active
        const swapWasActive = await checkZramSwap();
        // checkZramSwap will return false after reset, we don't re-enable swap automatically

        // Update state
        zramCurrent.algo = newAlgo;
        zramCurrent.disksize = newDisksize;
        zramCurrent.streams = newStreams;

        // Persist config
        await saveZramConfig({
            algo: newAlgo,
            disksize: newDisksize,
            streams: newStreams,
        });

        // Refresh displays
        const disksizeMBDisplay = Math.floor(newDisksize / 1048576);
        const algoCurrentEl = document.getElementById('algo-current');
        const disksizeCurrentEl = document.getElementById('disksize-current');
        const streamsCurrentEl = document.getElementById('streams-current');
        if (algoCurrentEl) algoCurrentEl.textContent = newAlgo;
        if (disksizeCurrentEl) disksizeCurrentEl.textContent = disksizeMBDisplay + ' MB';
        if (streamsCurrentEl) streamsCurrentEl.textContent = newStreams;

        // Update device info display too
        if (dom.deviceAlgo) dom.deviceAlgo.textContent = newAlgo;
        if (dom.deviceDisksize) dom.deviceDisksize.textContent = disksizeMBDisplay + ' MB';

        // Clear dirty indicators
        updateStatusDot('algo-status', false);
        updateStatusDot('disksize-status', false);
        updateStatusDot('streams-status', false);

        toast('ZRAM settings applied successfully', 'success');
    } catch (e) {
        toast('Failed to apply ZRAM changes: ' + e.message, 'error');
        console.error('[zram-bench] applyZramChanges:', e);
    } finally {
        if (applyBtn) applyBtn.disabled = false;
    }
}

async function resetZramDefaults() {
    try {
        if (!zramDefaults.algo) {
            toast('No defaults recorded', 'error');
            return;
        }
        // Reset zram
        await shell('swapoff /dev/block/zram0 2>/dev/null; echo 1 > /sys/block/zram0/reset');
        // Apply defaults
        await shell('echo ' + sanitize(zramDefaults.algo) + ' > /sys/block/zram0/comp_algorithm');
        await shell('echo ' + parseInt(zramDefaults.streams, 10) + ' > /sys/block/zram0/max_comp_streams');
        await shell('echo ' + zramDefaults.disksize + ' > /sys/block/zram0/disksize');

        zramCurrent.algo = zramDefaults.algo;
        zramCurrent.disksize = zramDefaults.disksize;
        zramCurrent.streams = zramDefaults.streams;

        // Reset form values
        populateZramControls(
            [zramDefaults.algo],
            zramDefaults.streams,
            Math.floor(zramDefaults.disksize / 1048576)
        );

        // Reload full settings to refresh available algos etc.
        await loadZramSettings();

        // Clear persisted config
        await shell('rm -f ' + ZRAM_CONFIG_PATH);

        toast('ZRAM reset to defaults', 'success');
    } catch (e) {
        toast('Failed to reset ZRAM: ' + e.message, 'error');
        console.error('[zram-bench] resetZramDefaults:', e);
    }
}

async function saveZramConfig(config) {
    try {
        const json = JSON.stringify(config, null, 2);
        await shell('mkdir -p /data/adb/modules/zram_bench');
        // Use printf with single-quoted content to avoid shell escape issues
        const safe = json.replace(/'/g, "'\\''");
        await shell("printf '%s\\n' '" + safe + "' > '" + ZRAM_CONFIG_PATH + "'");
    } catch (e) {
        console.error('[zram-bench] saveZramConfig:', e);
    }
}

async function loadZramConfig() {
    try {
        const raw = await shell('cat ' + ZRAM_CONFIG_PATH + ' 2>/dev/null || echo {}');
        const config = JSON.parse(raw.trim());
        if (config.algo || config.disksize || config.streams) {
            return config;
        }
    } catch (e) {
        // Config doesn't exist or is invalid, use defaults
    }
    return null;
}

// ── Progress Tracking ──────────────────────────────────────────
function showProgress() {
    dom.progressSection.style.display = '';
    dom.progressFill.style.width = '0%';
    dom.progressPct.textContent = '0%';
    dom.progressPhase.textContent = 'Starting benchmark...';
    dom.progressDetail.textContent = '';
}

function updateProgress(pct, phase, detail) {
    dom.progressFill.style.width = Math.min(pct, 100) + '%';
    dom.progressPct.textContent = Math.round(pct) + '%';
    if (phase) dom.progressPhase.textContent = phase;
    if (detail) dom.progressDetail.textContent = detail;
}

function hideProgress() {
    dom.progressSection.style.display = 'none';
}

// ── Benchmark Execution ────────────────────────────────────────
function getSelectedOptions() {
    // Get selected algorithms
    const algos = Array.from(document.querySelectorAll('input[name="algo"]:checked'))
        .map(cb => cb.value);
    
    // Get selected patterns
    const patterns = Array.from(document.querySelectorAll('input[name="pattern"]:checked'))
        .map(cb => cb.value);
    
    // Get other options
    const dataSize = document.getElementById('opt-data-size').value;
    const iterations = document.getElementById('opt-iterations').value;
    const streams = document.getElementById('opt-streams').value;

    // Validate whitelist
    const algoRe = /^[a-z0-9_-]+$/;
    const patternRe = /^[a-z]+$/;
    const numRe = /^[0-9]+$/;

    for (const a of (algos.length > 0 ? algos : ['lz4'])) {
        if (!algoRe.test(a)) throw new Error('Invalid algorithm name: ' + a);
    }
    for (const p of (patterns.length > 0 ? patterns : ['zeros'])) {
        if (!patternRe.test(p)) throw new Error('Invalid test pattern: ' + p);
    }
    if (!numRe.test(dataSize)) throw new Error('Invalid data size: ' + dataSize);
    if (!numRe.test(iterations)) throw new Error('Invalid iterations: ' + iterations);
    if (!numRe.test(streams)) throw new Error('Invalid streams: ' + streams);
    
    return {
        algos: algos.length > 0 ? algos : ['lz4'],
        patterns: patterns.length > 0 ? patterns : ['zeros'],
        dataSize: dataSize,
        iterations: iterations,
        streams: streams
    };
}

function getBenchArgs(mode) {
    const opts = getSelectedOptions();
    
    if (mode === 'quick') {
        // Quick: use first 2 algos, first 2 patterns, 1 iteration
        const quickAlgos = opts.algos.slice(0, 2).join(' ');
        const quickPatterns = opts.patterns.slice(0, 2).join(' ');
        return '-a "' + quickAlgos + '" -m "' + quickPatterns + '" -s ' + opts.streams + ' -n 1 -d ' + opts.dataSize + ' --skip-latency --skip-cpu';
    }
    
    // Full: use all selected options
    return '-a "' + opts.algos.join(' ') + '" -m "' + opts.patterns.join(' ') + '" -s ' + opts.streams + ' -n ' + opts.iterations + ' -d ' + opts.dataSize + ' --skip-latency --skip-cpu';
}

async function estimateTotalTests(mode) {
    const opts = getSelectedOptions();
    if (mode === 'quick') {
        return opts.algos.slice(0, 2).length * opts.patterns.slice(0, 2).length;
    }
    // Full: algos × streams × patterns × iterations
    const streamsCount = opts.streams.includes(' ') ? opts.streams.split(' ').length : 1;
    return opts.algos.length * streamsCount * opts.patterns.length * parseInt(opts.iterations);
}

async function runBenchmark(mode) {
    if (DEBUG) console.log('[zram-bench] runBenchmark() START, mode:', mode);
    if (state.running) return;
    state.running = true;

    dom.btnQuick.disabled = true;
    dom.btnFull.disabled = true;
    showProgress();

    const totalTests = await estimateTotalTests(mode);
    let currentTest = 0;

    // Update progress every N seconds by polling the test count
    const args = getBenchArgs(mode);
    const cmd = BENCH_BIN + ' ' + args + ' -o ' + RESULTS_PATH;

    updateProgress(0, 'Running benchmark...', 'Mode: ' + mode);

    // We'll track progress by counting completed result files
    const progressTimer = setInterval(async () => {
        try {
            const countRaw = await shell(
                'ls /data/local/tmp/zram_bench/.results/*.json 2>/dev/null | wc -l'
            );
            currentTest = parseInt(countRaw, 10) || 0;
            const pct = Math.min((currentTest / totalTests) * 100, 99);
            updateProgress(
                pct,
                'Running benchmark...',
                currentTest + '/' + totalTests + ' configurations'
            );
        } catch (_) {
            // ignore polling errors
        }
    }, 2000);

    try {
        // Clear old results first
        await shell('rm -rf /data/local/tmp/zram_bench/.results');
        await shell('mkdir -p /data/local/tmp/zram_bench/.results');

        updateProgress(0, 'Running benchmark...', '');

        // Run the benchmark — this blocks until complete
        const output = await shell(cmd);

        clearInterval(progressTimer);

        // Read results
        const raw = await shell('cat ' + RESULTS_PATH);
        const results = JSON.parse(raw);

        updateProgress(100, 'Complete', results.length + ' tests finished');

        state.results = results;
        state.activeHistoryIdx = null;

        renderResults(results, mode);
        saveHistory(results, mode);

        setTimeout(hideProgress, 1200);

        toast('Benchmark complete!', 'success');
    } catch (e) {
        clearInterval(progressTimer);
        updateProgress(0, 'Error', String(e));
        toast('Benchmark failed: ' + e.message, 'error');
        setTimeout(hideProgress, 3000);
        console.error('runBenchmark:', e);
    } finally {
        state.running = false;
        dom.btnQuick.disabled = false;
        dom.btnFull.disabled = false;
    }
}

// ── Results Rendering ──────────────────────────────────────────
function renderResults(results, mode, comparisonTarget) {
    if (!results || results.length === 0) {
        dom.resultsSection.style.display = 'none';
        return;
    }
    dom.resultsSection.style.display = '';
    dom.exportRow.style.display = '';

    // Aggregate by algorithm × mode × streams
    const aggregated = aggregateResults(results);

    // Summary cards
    const algos = [...new Set(results.map((r) => r.algorithm))];
    let summaryHTML = '';

    for (const algo of algos) {
        const subset = results.filter((r) => r.algorithm === algo);
        const avgWrite = avgOf(subset, 'throughput_write_mbs');
        const avgRead = avgOf(subset, 'throughput_read_mbs');
        const ratios = subset.map((r) => Number(r.compression_ratio)).filter(isFinite);
        const avgRatio = ratios.length > 0
            ? ratios.reduce((a, b) => a + b, 0) / ratios.length
            : 0;

        summaryHTML += `
            <div class="summary-card">
                <span class="label">${sanitize(algo)} Write</span>
                <span class="value">${sanitize(formatMBs(avgWrite))}</span>
            </div>
            <div class="summary-card">
                <span class="label">${sanitize(algo)} Read</span>
                <span class="value">${sanitize(formatMBs(avgRead))}</span>
            </div>
            <div class="summary-card">
                <span class="label">${sanitize(algo)} Ratio</span>
                <span class="value">${sanitize(formatRatio(avgRatio))}x</span>
            </div>`;
    }
    dom.resultsSummary.innerHTML = summaryHTML;

    // Table
    let tbody = '';
    for (const row of aggregated) {
        const comp = comparisonTarget
            ? findComparable(row, comparisonTarget)
            : null;

        let writeClass = '';
        let readClass = '';
        if (comp) {
            writeClass = row.write > comp.write ? 'better' : row.write < comp.write ? 'worse' : '';
            readClass = row.read > comp.read ? 'better' : row.read < comp.read ? 'worse' : '';
        }

        tbody += `<tr>
            <td>${sanitize(row.algorithm)}</td>
            <td>${sanitize(row.mode)}</td>
            <td>${sanitize(String(row.streams))}</td>
            <td class="${writeClass}">${sanitize(formatMBs(row.write))}</td>
            <td class="${readClass}">${sanitize(formatMBs(row.read))}</td>
            <td>${sanitize(formatRatio(row.ratio))}</td>
            <td>${row.latency > 0 ? sanitize(row.latency.toFixed(1)) : '--'}</td>
        </tr>`;
    }
    dom.resultsBody.innerHTML = tbody;
}

function aggregateResults(results) {
    const map = new Map();
    for (const r of results) {
        const key = r.algorithm + '|' + r.test_mode + '|' + r.streams;
        if (!map.has(key)) {
            map.set(key, {
                algorithm: r.algorithm,
                mode: r.test_mode,
                streams: r.streams,
                writes: [],
                reads: [],
                ratios: [],
                latencies: [],
            });
        }
        const g = map.get(key);
        g.writes.push(Number(r.throughput_write_mbs));
        g.reads.push(Number(r.throughput_read_mbs));
        const ratio = Number(r.compression_ratio);
        if (isFinite(ratio)) g.ratios.push(ratio);
        if (r.latency_us_per_4k > 0) g.latencies.push(r.latency_us_per_4k);
    }

    return [...map.values()].map((g) => ({
        algorithm: g.algorithm,
        mode: g.mode,
        streams: g.streams,
        write: avg(g.writes),
        read: avg(g.reads),
        ratio: g.ratios.length > 0 ? avg(g.ratios) : Infinity,
        latency: g.latencies.length > 0 ? avg(g.latencies) : 0,
    }));
}

function avg(arr) {
    if (arr.length === 0) return 0;
    return arr.reduce((a, b) => a + b, 0) / arr.length;
}

function findComparable(row, targetResults) {
    const targetAgg = aggregateResults(targetResults);
    return targetAgg.find(
        (t) =>
            t.algorithm === row.algorithm &&
            t.mode === row.mode &&
            t.streams === row.streams
    );
}

// ── History ────────────────────────────────────────────────────
function loadHistory() {
    try {
        const raw = localStorage.getItem(HISTORY_KEY);
        state.history = raw ? JSON.parse(raw) : [];
    } catch (_) {
        state.history = [];
    }
    renderHistory();
}

function saveHistory(results, mode) {
    const entry = {
        timestamp: Date.now(),
        mode: mode,
        count: results.length,
        algorithms: [...new Set(results.map((r) => r.algorithm))],
        avgWrite: formatMBs(avgOf(results, 'throughput_write_mbs')),
        avgRead: formatMBs(avgOf(results, 'throughput_read_mbs')),
        results: results,
    };
    state.history.unshift(entry);
    if (state.history.length > MAX_HISTORY) {
        state.history = state.history.slice(0, MAX_HISTORY);
    }
    try {
        localStorage.setItem(HISTORY_KEY, JSON.stringify(state.history));
    } catch (e) {
        // Revert the unshift on quota exceeded or other storage errors
        state.history.shift();
        toast('Could not save history: storage full', 'error');
        console.error('saveHistory localStorage error:', e);
    }
    renderHistory();
}

function renderHistory() {
    if (state.history.length === 0) {
        dom.historyContainer.innerHTML =
            '<p class="empty-state">No history yet. Run a benchmark to get started.</p>';
        dom.btnClearHistory.style.display = 'none';
        return;
    }

    dom.btnClearHistory.style.display = '';
    let html = '';
    state.history.forEach((entry, idx) => {
        html += `
            <div class="history-item${state.activeHistoryIdx === idx ? ' active' : ''}" data-idx="${idx}">
                <div class="history-meta">
                    <span class="history-date">${sanitize(formatDate(entry.timestamp))}</span>
                    <span class="history-type ${sanitize(entry.mode)}">${sanitize(entry.mode)}</span>
                </div>
                <div class="history-stats">
                    <span>${sanitize(String(entry.count))} tests</span>
                    <span>Write: ${sanitize(entry.avgWrite)} MB/s</span>
                    <span>Read: ${sanitize(entry.avgRead)} MB/s</span>
                </div>
            </div>`;
    });
    dom.historyContainer.innerHTML = html;

    // Bind click handlers
    dom.historyContainer.querySelectorAll('.history-item').forEach((el) => {
        el.addEventListener('click', () => {
            const idx = parseInt(el.dataset.idx, 10);
            selectHistory(idx);
        });
    });
}

function selectHistory(idx) {
    const entry = state.history[idx];
    if (!entry) return;

    state.activeHistoryIdx = idx;
    state.results = entry.results;

    // If we have a previous entry, use it for comparison
    const prev = idx + 1 < state.history.length ? state.history[idx + 1].results : null;
    renderResults(entry.results, entry.mode, prev);
    renderHistory();

    // Scroll to results
    dom.resultsSection.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function clearHistory() {
    state.history = [];
    state.activeHistoryIdx = null;
    localStorage.removeItem(HISTORY_KEY);
    renderHistory();
    dom.resultsSection.style.display = 'none';
    dom.exportRow.style.display = 'none';
    toast('History cleared');
}

// ── Export ─────────────────────────────────────────────────────
function exportJSON() {
    if (!state.results) {
        toast('No results to export', 'error');
        return;
    }
    const json = JSON.stringify(state.results, null, 2);
    downloadFile(json, 'zram-bench_' + timestampSlug() + '.json', 'application/json');
    toast('Exported JSON');
}

function exportCSV() {
    if (!state.results) {
        toast('No results to export', 'error');
        return;
    }
    const headers = [
        'algorithm',
        'streams',
        'test_mode',
        'iteration',
        'data_size_mb',
        'throughput_write_mbs',
        'throughput_read_mbs',
        'latency_us_per_4k',
        'iops_4k',
        'orig_data_size',
        'compr_data_size',
        'mem_used_total',
        'mem_overhead_bytes',
        'compression_ratio',
        'cpu_compress_pct',
    ];

    let csv = headers.join(',') + '\n';
    for (const r of state.results) {
        csv += headers.map((h) => {
            let v = r[h];
            if (v === 'inf') v = 'Infinity';
            if (typeof v === 'string' && v.includes(',')) v = '"' + v + '"';
            return v;
        }).join(',') + '\n';
    }

    downloadFile(csv, 'zram-bench_' + timestampSlug() + '.csv', 'text/csv');
    toast('Exported CSV');
}

function timestampSlug() {
    return new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
}

function downloadFile(content, filename, mime) {
    const blob = new Blob([content], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    }, 100);
}

// ── Init ───────────────────────────────────────────────────────
async function init() {
    if (DEBUG) console.log('[zram-bench] init() START');
    
    // 1. Initialize DOM refs with null-ref validation
    dom = {
        version: $('#version'),
        deviceModel: $('#device-model'),
        deviceKernel: $('#device-kernel'),
        deviceAlgo: $('#device-algo'),
        deviceDisksize: $('#device-disksize'),
        btnQuick: $('#btn-quick'),
        btnFull: $('#btn-full'),
        btnExportJson: $('#btn-export-json'),
        btnExportCsv: $('#btn-export-csv'),
        exportRow: $('#export-row'),
        progressSection: $('#progress-section'),
        progressPhase: $('#progress-phase'),
        progressPct: $('#progress-pct'),
        progressFill: $('#progress-fill'),
        progressDetail: $('#progress-detail'),
        resultsSection: $('#results-section'),
        resultsSummary: $('#results-summary'),
        resultsBody: $('#results-body'),
        historyContainer: $('#history-container'),
        btnClearHistory: $('#btn-clear-history'),
    };
    
    // Validate critical DOM refs
    for (const [key, el] of Object.entries(dom)) {
        if (!el && key !== 'exportRow') {
            console.error('[zram-bench] DOM ref missing: #' + key);
        }
    }
    
    // 2. Hide loading indicator
    const loadingEl = document.getElementById('loading');
    if (loadingEl) loadingEl.style.display = 'none';
    
    const debugEl = document.getElementById('debug-output');
    const debugSection = document.getElementById('debug-section');
    try {
        // Debug: show API surface
        if (DEBUG) console.log('[zram-bench] debugEl:', debugEl ? 'found' : 'NOT FOUND');
        if (debugEl) {
            const info = [];
            info.push('typeof ksu: ' + typeof ksu);
            info.push('typeof window.ksu: ' + typeof window.ksu);
            info.push('typeof kernelsu: ' + typeof kernelsu);
            info.push('typeof window.KSU: ' + typeof window.KSU);
            if (typeof ksu === 'object' && ksu) {
                info.push('ksu keys: ' + Object.keys(ksu).join(', '));
            }
            if (typeof window.ksu === 'object' && window.ksu) {
                info.push('window.ksu keys: ' + Object.keys(window.ksu).join(', '));
            }
            info.push('navigator.userAgent: ' + navigator.userAgent.substring(0, 80));
            debugEl.textContent = info.join('\n');
        }
        if (DEBUG) console.log('[zram-bench] debug section populated');
        
        // 3. Attach event listeners and load history immediately (don't wait for async ops)
        if (DEBUG) console.log('[zram-bench] attaching event listeners...');
        if (dom.btnQuick) dom.btnQuick.addEventListener('click', () => runBenchmark('quick'));
        if (dom.btnFull) dom.btnFull.addEventListener('click', () => runBenchmark('full'));
        if (dom.btnExportJson) dom.btnExportJson.addEventListener('click', exportJSON);
        if (dom.btnExportCsv) dom.btnExportCsv.addEventListener('click', exportCSV);
        if (dom.btnClearHistory) dom.btnClearHistory.addEventListener('click', () => {
            if (confirm('Clear all benchmark history?')) clearHistory();
        });
        
        // Setup collapsible toggle
        const advancedToggle = document.getElementById('advanced-toggle');
        const advancedContent = document.getElementById('advanced-content');
        if (advancedToggle && advancedContent) {
            advancedToggle.addEventListener('click', () => {
                const expanded = advancedContent.classList.toggle('expanded');
                advancedToggle.setAttribute('aria-expanded', expanded);
            });
        }

        // ZRAM Settings collapsible toggle
        const zramSettingsToggle = document.getElementById('zram-settings-toggle');
        const zramSettingsContent = document.getElementById('zram-settings-content');
        if (zramSettingsToggle && zramSettingsContent) {
            zramSettingsToggle.addEventListener('click', () => {
                const expanded = zramSettingsContent.classList.toggle('expanded');
                zramSettingsToggle.setAttribute('aria-expanded', expanded);
            });
        }

        // ZRAM Settings controls
        const zramAlgoSelect = document.getElementById('zram-algo-select');
        const zramDisksizeInput = document.getElementById('zram-disksize-input');
        const zramDisksizeUnit = document.getElementById('zram-disksize-unit');
        const zramStreamsInput = document.getElementById('zram-streams-input');
        const btnZramApply = document.getElementById('btn-zram-apply');
        const btnZramReset = document.getElementById('btn-zram-reset');
        if (zramAlgoSelect) zramAlgoSelect.addEventListener('change', checkZramDirty);
        if (zramDisksizeInput) zramDisksizeInput.addEventListener('input', checkZramDirty);
        if (zramDisksizeUnit) zramDisksizeUnit.addEventListener('change', checkZramDirty);
        if (zramStreamsInput) zramStreamsInput.addEventListener('input', checkZramDirty);
        if (btnZramApply) btnZramApply.addEventListener('click', applyZramChanges);
        if (btnZramReset) btnZramReset.addEventListener('click', () => {
            if (confirm('Reset ZRAM to boot-time defaults?')) resetZramDefaults();
        });
        
        loadHistory();
        
        // 4. Parallelize bench binary resolution with device info loading
        const resolveBin = (async () => {
            if (DEBUG) console.log('[zram-bench] resolving bench binary...');
            for (const candidate of BENCH_BIN_CANDIDATES) {
                try {
                    if (DEBUG) console.log('[zram-bench] trying:', candidate);
                    const exists = await shell('test -x ' + candidate + ' && echo 1');
                    if (DEBUG) console.log('[zram-bench] result:', exists);
                    if (exists.trim() === '1') {
                        BENCH_BIN = candidate;
                        if (DEBUG) console.log('[zram-bench] FOUND:', candidate);
                        break;
                    }
                } catch (e) {
                    if (DEBUG) console.log('[zram-bench] candidate failed:', candidate, e.message);
                }
            }
            if (DEBUG) console.log('[zram-bench] BENCH_BIN:', BENCH_BIN);
        })();
        
        const loadDev = loadDeviceInfo().catch(e => {
            console.error('[zram-bench] loadDeviceInfo FAILED:', e);
            if (debugEl) debugEl.textContent += '\nloadDeviceInfo error: ' + e.message;
        });
        
        await Promise.all([resolveBin, loadDev]);
        
        // Load ZRAM settings after device info
        loadZramSettings().catch(e => {
            console.error('[zram-bench] loadZramSettings FAILED:', e);
        });
        
        // Check bench binary after resolution
        try {
            const exists = await shell('test -x ' + BENCH_BIN + ' && echo 1 || echo 0');
            if (exists.trim() === '0') {
                dom.version.textContent = 'bench not installed';
                const installBtn = document.getElementById('btn-install-cli');
                if (installBtn) {
                    installBtn.style.display = '';
                    installBtn.addEventListener('click', installCLI);
                }
            }
        } catch (_) {
            dom.version.textContent = 'bench not installed';
            const installBtn = document.getElementById('btn-install-cli');
            if (installBtn) {
                installBtn.style.display = '';
                installBtn.addEventListener('click', installCLI);
            }
        }
        
        if (debugEl) {
            debugEl.textContent += '\ninit() complete. BENCH_BIN=' + BENCH_BIN;
        }
        if (DEBUG) console.log('[zram-bench] init() COMPLETE');
    } catch (e) {
        console.error('[zram-bench] init() FAILED:', e);
        if (debugSection) debugSection.style.display = '';
        if (debugEl) {
            debugEl.textContent += '\n\nFATAL ERROR: ' + (e.message || e);
        }
        toast('Initialization failed: ' + e.message, 'error');
    }
}

document.addEventListener('DOMContentLoaded', init);
