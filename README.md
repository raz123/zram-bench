# zram-bench

**ZRAM Benchmark Suite for Android** — Measure compression algorithm throughput, latency, and compression ratios on Android devices with ZRAM swap.

Based on [HandyMenny's zramtest3.sh](https://gist.github.com/HandyMenny/d28766a45de48d6962a9), enhanced with multi-algorithm comparison, multi-stream testing, latency measurement, and automated reporting.

## Features

- **Multi-algorithm comparison** — Benchmark LZO, LZ4, and other kernel-supported algorithms side-by-side
- **Multiple test patterns** — Zeros, random, compressible, text, structured, and mixed workloads
- **Multi-stream testing** — Test with 1, 2, 4, or more compression streams
- **Latency measurement** — 4K block write latency and IOPS
- **Compression ratio tracking** — Original vs. compressed size, memory overhead
- **CPU utilization** — Compression CPU cost measurement
- **Warmup phases** — Optional dictionary warmup iterations to capture real-world compression behavior
- **JSON output** — Machine-readable results for scripting and CI
- **Automated reporting** — Python reporter generates Markdown summaries and run-to-run comparisons
- **Zero dependencies on device** — Pure POSIX shell, no bc/jq/bashisms; works with Android's toybox
- **PC-side orchestrator** — Push, run, pull, and compare from your development machine via ADB

## Requirements

### Device (Android)
- Root access (`adb root`)
- Kernel with ZRAM support (`/sys/block/zram0`)
- Standard Android shell (toybox/busybox)

### Host (PC)
- `adb` in PATH
- Python 3.6+ (for the reporter)
- Bash 4+

## Quick Start

```bash
# 1. Connect your rooted Android device
adb devices

# 2. Run the orchestrator (pushes script, runs benchmark, pulls results)
./src/run_bench.sh run

# 3. Generate a summary report
python3 src/zram_bench_reporter.py --summary results/20240101_120000.json
```

## Usage

### On-device script (`zram_bench.sh`)

```bash
# Push to device
adb push src/zram_bench.sh /data/local/tmp/
adb shell chmod +x /data/local/tmp/zram_bench.sh

# Run with defaults (lzo lz4, zeros/random/compressible, 3 iterations)
adb shell su -c "/data/local/tmp/zram_bench.sh"

# Run with custom parameters
adb shell su -c "/data/local/tmp/zram_bench.sh \
    -a 'lz4 lzo' \
    -m 'zeros random compressible' \
    -s '1 2 4' \
    -n 5 \
    -d 128 \
    -o /data/local/tmp/results.json \
    -v"
```

#### Options

| Flag | Description | Default |
|------|-------------|---------|
| `-a, --algorithms LIST` | Space-separated algorithm list | `lzo lz4` |
| `-m, --modes LIST` | Test modes (see below) | `zeros random compressible` |
| `-s, --streams LIST` | Compression stream counts | `1 2 4` |
| `-n, --iterations N` | Iterations per configuration | `3` |
| `-d, --data-size MB` | Test data size in MB | `64` |
| `-o, --output FILE` | Write JSON to file | stdout |
| `--hz N` | Kernel HZ for CPU calc | `250` |
| `--warmup N` | Warmup iterations before measurement | `0` |
| `--skip-latency` | Skip 4K latency measurement | off |
| `--skip-cpu` | Skip CPU utilization measurement | off |
| `-v, --verbose` | Verbose logging to stderr | off |

#### Test Modes

| Mode | Description |
|------|-------------|
| `zeros` | All-zero data — best-case compression |
| `random` | Random data — worst-case compression |
| `compressible` | Repeating pattern — high compressibility |
| `text` | Text-like data (repeating pangrams) |
| `structured` | App data mix (70% structured, 20% IDs, 10% padding) |
| `mixed` | Realistic mix (40% zeros, 30% compressible, 30% random) |

### PC-side orchestrator (`run_bench.sh`)

```bash
# Full benchmark run (pushes, runs, pulls, compares)
./src/run_bench.sh run

# Custom algorithms and modes
./src/run_bench.sh run -a "lz4 lzo" -m "zeros random" -n 5

# Compare two result files
./src/run_bench.sh compare results/run1.json results/run2.json

# Pull latest results from device
./src/run_bench.sh pull

# List local result files
./src/run_bench.sh list
```

### Reporter (`zram_bench_reporter.py`)

```bash
# Generate summary report from a single run
python3 src/zram_bench_reporter.py --summary results/benchmark.json

# Compare two runs (shows improvements/regressions)
python3 src/zram_bench_reporter.py --compare baseline.json current.json

# Custom regression threshold (default: 5%)
python3 src/zram_bench_reporter.py --compare old.json new.json --threshold 10

# Output to file
python3 src/zram_bench_reporter.py --summary results.json -o report.md
```

## Output Format

Each benchmark run produces a JSON array of result objects:

```json
[
  {
    "algorithm": "lz4",
    "streams": 2,
    "test_mode": "compressible",
    "iteration": 1,
    "data_size_mb": 64,
    "time_real_write": 0.220,
    "time_real_read": 0.140,
    "throughput_write_mbs": 290.91,
    "throughput_read_mbs": 457.14,
    "latency_us_per_4k": 12.5,
    "iops_4k": 80000,
    "orig_data_size": 67108864,
    "compr_data_size": 1048576,
    "mem_used_total": 2097152,
    "mem_overhead_bytes": 1048576,
    "compression_ratio": "64.00",
    "cpu_compress_pct": 3.2
  }
]
```

## Sample Algorithm Comparison

Results from a POCO F3 (SM8250/Kona, 8GB RAM) baseline run with 6 data patterns:

| Algorithm | Avg Write (MB/s) | Avg Read (MB/s) | Avg Ratio | Best For |
|-----------|------------------|-----------------|-----------|----------|
| **lzo-rle** | **291.3** | 420.5 | 1121.92:1 | Best throughput |
| lz4 | 285.7 | 444.1 | 1215.28:1 | Balanced performance |
| lzo | 286.5 | 426.8 | 1087.13:1 | Legacy compatibility |
| **zstd** | 273.7 | **436.0** | **1508.22:1** | Best compression |

### Compression by Data Pattern

| Pattern | lz4 | lzo-rle | zstd | Description |
|---------|-----|---------|------|-------------|
| zeros | inf | inf | inf | All-zero data (kernel optimization) |
| compressible | inf | inf | inf | Repeating 'A' pattern |
| random | 1.00:1 | 1.00:1 | 1.00:1 | Uncompressible data |
| **text** | **7281:1** | **6721:1** | **9039:1** | Repeating sentences |
| structured | 5.56:1 | 5.56:1 | 5.56:1 | App data mix (70% structured) |
| mixed | 3.32:1 | 3.32:1 | 3.32:1 | Realistic workload (40/30/30) |

*Results vary by device, kernel version, and workload pattern. Zstd achieves 25% better compression than lz4 on text data.*

## Algorithm Notes

See [docs/ALGORITHM_NOTES.md](docs/ALGORITHM_NOTES.md) for details on compression algorithms available on Android kernels.

See [docs/SM8250_NOTES.md](docs/SM8250_NOTES.md) for device-specific findings on Qualcomm SM8250 (Snapdragon 870) platforms.

## Project Structure

```
zram-bench/
├── README.md              # This file
├── LICENSE                # MIT License
├── .gitignore
├── CONTRIBUTING.md        # Contribution guidelines
├── src/
│   ├── zram_bench.sh      # Main on-device benchmark script
│   ├── zram_bench_reporter.py  # Python reporter for summaries/comparisons
│   └── run_bench.sh       # PC-side ADB orchestrator
├── docs/
│   ├── ALGORITHM_NOTES.md # Compression algorithm details
│   └── SM8250_NOTES.md    # Device-specific findings
├── examples/
│   └── sample_output.json # Example benchmark output
└── results/
    └── .gitkeep           # Placeholder for user results
```

## How It Works

1. **Data Generation** — Creates test files of configurable size with various patterns (zeros, random, compressible, etc.)
2. **ZRAM Setup** — Resets the ZRAM block device, sets the algorithm, stream count, and disk size
3. **Write Measurement** — Writes test data to `/dev/block/zram0` via `dd`, measuring elapsed time
4. **Compression Stats** — Reads `/sys/block/zram0/mm_stat` for original/compressed sizes and memory usage
5. **Read Measurement** — Reads back from ZRAM to measure decompression throughput
6. **Latency Test** — Writes 4K blocks to measure per-block latency and IOPS
7. **CPU Measurement** — Samples `/proc/stat` jiffies to calculate compression CPU utilization
8. **JSON Assembly** — Combines per-iteration result files into a single JSON array

All floating-point math uses `awk` (POSIX, available via Android's toybox). No bc, no jq, no arrays, no bashisms.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines.

## License

MIT — see [LICENSE](LICENSE).

## Credits

- [HandyMenny](https://gist.github.com/HandyMenny/d28766a45de48d6962a9) — Original zramtest3.sh
