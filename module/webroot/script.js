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

const BENCH_BIN = '/system/bin/zram-bench';
const RESULTS_PATH = '/data/local/tmp/zram-bench/.results/final.json';
const HISTORY_KEY = 'zram-bench_history';
const MAX_HISTORY = 20;

// ── DOM refs ───────────────────────────────────────────────────
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

const dom = {
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

// ── Helpers ────────────────────────────────────────────────────
function shell(cmd) {
    return new Promise((resolve, reject) => {
        if (typeof ksu !== 'undefined' && ksu.exec) {
            ksu.exec(cmd, (result) => {
                resolve(result);
            });
        } else {
            // Fallback for desktop testing — use fetch to a local proxy or mock
            console.warn('[mock] ksu.exec not available, using mock response');
            reject(new Error('ksu.exec not available'));
        }
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
        // comp_algorithm may have a prefix like [lz4]
        dom.deviceAlgo.textContent = (algo || '--').replace(/[\[\]]/g, '').trim();
        dom.deviceDisksize.textContent = disksize && disksize !== '0' ? disksize + ' MB' : '--';

        // Check if bench binary exists
        try {
            const exists = await shell('test -x ' + BENCH_BIN + ' && echo 1 || echo 0');
            if (exists.trim() === '0') {
                dom.version.textContent = 'bench not installed';
            }
        } catch (_) {
            dom.version.textContent = 'bench not installed';
        }
    } catch (e) {
        console.error('loadDeviceInfo:', e);
    }
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
function getBenchArgs(mode) {
    // Quick: lz4 only, zeros+compressible, 2 streams, 1 iter, 32MB, skip-latency, skip-cpu
    // Full: all algos, all modes, 3 iter, 64MB
    if (mode === 'quick') {
        return '-a lz4 -m "zeros compressible" -s 2 -n 1 -d 32 --skip-latency --skip-cpu';
    }
    return '-a "lz4 lzo" -m "zeros random compressible" -s "1 2 4" -n 3 -d 64';
}

async function estimateTotalTests(mode) {
    if (mode === 'quick') return 2; // 1 algo × 2 modes
    // Full: 2 algos × 3 streams × 3 modes × 3 iters = 54
    return 54;
}

async function runBenchmark(mode) {
    if (state.running) return;
    state.running = true;

    dom.btnQuick.disabled = true;
    dom.btnFull.disabled = true;
    showProgress();

    const totalTests = await estimateTotalTests(mode);
    let currentTest = 0;

    // Update progress every N seconds by polling the test count
    const args = getBenchArgs(mode);
    const cmd = BENCH_BIN + ' ' + args + ' -o ' + RESULTS_PATH + ' -v';

    updateProgress(0, 'Running benchmark...', 'Mode: ' + mode);

    // We'll track progress by counting completed result files
    const progressTimer = setInterval(async () => {
        try {
            const countRaw = await shell(
                'ls /data/local/tmp/zram-bench/.results/*.json 2>/dev/null | wc -l'
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
        await shell('rm -rf /data/local/tmp/zram-bench/.results');
        await shell('mkdir -p /data/local/tmp/zram-bench/.results');

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
                <span class="label">${algo} Write</span>
                <span class="value">${formatMBs(avgWrite)}</span>
            </div>
            <div class="summary-card">
                <span class="label">${algo} Read</span>
                <span class="value">${formatMBs(avgRead)}</span>
            </div>
            <div class="summary-card">
                <span class="label">${algo} Ratio</span>
                <span class="value">${formatRatio(avgRatio)}x</span>
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
            <td>${row.algorithm}</td>
            <td>${row.mode}</td>
            <td>${row.streams}</td>
            <td class="${writeClass}">${formatMBs(row.write)}</td>
            <td class="${readClass}">${formatMBs(row.read)}</td>
            <td>${formatRatio(row.ratio)}</td>
            <td>${row.latency > 0 ? row.latency.toFixed(1) : '--'}</td>
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
    localStorage.setItem(HISTORY_KEY, JSON.stringify(state.history));
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
                    <span class="history-date">${formatDate(entry.timestamp)}</span>
                    <span class="history-type ${entry.mode}">${entry.mode}</span>
                </div>
                <div class="history-stats">
                    <span>${entry.count} tests</span>
                    <span>Write: ${entry.avgWrite} MB/s</span>
                    <span>Read: ${entry.avgRead} MB/s</span>
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
function init() {
    loadDeviceInfo();
    loadHistory();

    dom.btnQuick.addEventListener('click', () => runBenchmark('quick'));
    dom.btnFull.addEventListener('click', () => runBenchmark('full'));
    dom.btnExportJson.addEventListener('click', exportJSON);
    dom.btnExportCsv.addEventListener('click', exportCSV);
    dom.btnClearHistory.addEventListener('click', () => {
        if (confirm('Clear all benchmark history?')) clearHistory();
    });
}

document.addEventListener('DOMContentLoaded', init);
