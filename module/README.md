# ZRAM Benchmark Module

A KernelSU module that provides ZRAM benchmarking capabilities with a WebUI dashboard.

## Features

- **CLI Benchmark Tool**: Run quick or full ZRAM performance tests
- **WebUI Dashboard**: Monitor ZRAM status and view benchmark results in a browser
- **Real-time Monitoring**: Track ZRAM compression and performance metrics
- **History Tracking**: Save and compare benchmark results over time

## Installation

1. Download the module ZIP file
2. Open KernelSU Manager
3. Go to Modules → Install from storage
4. Select the downloaded ZIP file
5. Reboot your device

## Usage

### CLI Commands

```bash
# Show help
zram-bench --help

# Run quick benchmark (30 seconds)
zram-bench --quick

# Run full benchmark (5 minutes)
zram-bench --full

# Show ZRAM status
zram-bench --status

# Start WebUI server
zram-bench --webui
```

### WebUI Dashboard

1. Start the WebUI server:
   ```bash
   zram-bench --webui
   ```

2. Open your browser and navigate to:
   ```
   http://localhost:8080
   ```

3. The dashboard allows you to:
   - View current ZRAM status
   - Run quick, full, or custom benchmarks
   - View benchmark results with detailed metrics
   - Export results to JSON
   - View benchmark history

## Benchmark Metrics

The benchmark tests measure:

- **Sequential Write**: Large block sequential write performance
- **Sequential Read**: Large block sequential read performance
- **Random 4K Write**: Small block random write IOPS
- **Random 4K Read**: Small block random read IOPS
- **ZRAM Compression**: How effectively ZRAM compresses data
- **Compression Ratio**: Ratio of original to compressed size

## Requirements

- Android device with root access
- KernelSU installed and configured
- ZRAM enabled in kernel
- fio (for benchmarks, usually pre-installed)

## Configuration

The module stores data in:
- `/data/local/tmp/zram-bench/` - Benchmark data and results
- `/data/adb/modules/zram_bench/` - Module files

## Troubleshooting

### ZRAM device not found
Ensure ZRAM is enabled in your kernel. Check:
```bash
ls -la /sys/block/zram0
```

### Benchmark fails
Check if fio is installed:
```bash
which fio
```

### WebUI won't start
The module requires either Python 3 or BusyBox httpd:
```bash
# Check for Python 3
python3 --version

# Or check for BusyBox httpd
busybox httpd --help
```

## License

This module is provided as-is under the MIT License.

## Author

raz123

## Version History

- **v1.0** (2024): Initial release
  - CLI benchmark tool
  - WebUI dashboard
  - History tracking
  - JSON export
