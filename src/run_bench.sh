#!/bin/bash
# run_bench.sh - PC-side orchestrator for ZRAM Benchmark
# Pushes zram_bench.sh to device, runs it, pulls results, optionally compares

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEVICE_SCRIPT="/data/local/tmp/zram_bench.sh"
DEVICE_RESULTS="/data/local/tmp/zram_results.json"
LOCAL_RESULTS_DIR="./results"

usage() {
    cat << EOF
run_bench.sh - ZRAM Benchmark Orchestrator

Usage: ./run_bench.sh [command] [options]

Commands:
  run [options]           Run benchmark on device
  compare <file1> <file2> Compare two result files
  pull [run_id]           Pull latest results from device
  list                    List local result files

Run Options:
  -a, --algorithms ALGOS  Algorithms to test (default: "lzo lz4")
  -m, --modes MODES       Test patterns (default: "zeros random compressible")
  -s, --streams STREAMS   Streams to test (default: "1 2")
  -n, --iterations N      Iterations per config (default: 3)
  -t, --test-size MB      Test data size (default: 50)
  --no-compare            Don't auto-compare with previous run

Examples:
  # Run full benchmark
  ./run_bench.sh run

  # Run with specific options
  ./run_bench.sh run -a "lz4" -n 5 -t 100

  # Compare two runs
  ./run_bench.sh compare results/20240101_120000.json results/20240102_120000.json

  # Pull latest results
  ./run_bench.sh pull
EOF
    exit 0
}

check_adb() {
    if ! command -v adb &> /dev/null; then
        echo "ERROR: adb not found in PATH" >&2
        exit 1
    fi
    
    local device_state=$(adb get-state 2>/dev/null || echo "error")
    if [ "$device_state" != "device" ]; then
        echo "ERROR: No device connected (state: $device_state)" >&2
        exit 1
    fi
    
    local is_root=$(adb shell id -u 2>/dev/null || echo "1")
    if [ "$is_root" != "0" ]; then
        echo "ERROR: Device not rooted. Run 'adb root' first." >&2
        exit 1
    fi
}

push_script() {
    echo "Pushing zram_bench.sh to device..."
    adb push "$SCRIPT_DIR/zram_bench.sh" "$DEVICE_SCRIPT"
    adb shell chmod +x "$DEVICE_SCRIPT"
    echo "✓ Script pushed"
}

run_benchmark() {
    local algorithms="${1:-lzo lz4}"
    local modes="${2:-zeros random compressible}"
    local streams="${3:-1 2}"
    local iterations="${4:-3}"
    local test_size="${5:-50}"
    local no_compare="${6:-false}"
    
    check_adb
    push_script
    
    echo ""
    echo "=== Running ZRAM Benchmark ==="
    echo "Algorithms: $algorithms"
    echo "Patterns: $modes"
    echo "Streams: $streams"
    echo "Iterations: $iterations"
    echo "Test Size: ${test_size}MB"
    echo ""
    
    # Run benchmark on device
    adb shell "$DEVICE_SCRIPT" \
        -a "\"$algorithms\"" \
        -m "\"$modes\"" \
        -s "\"$streams\"" \
        -n "$iterations" \
        -t "$test_size" \
        -o "$DEVICE_RESULTS"
    
    # Pull results
    local timestamp=$(date +%Y%m%d_%H%M%S)
    local local_file="${LOCAL_RESULTS_DIR}/${timestamp}.json"
    
    mkdir -p "$LOCAL_RESULTS_DIR"
    adb pull "$DEVICE_RESULTS" "$local_file"
    
    echo ""
    echo "✓ Results saved to: $local_file"
    
    # Auto-compare with previous run unless disabled
    if [ "$no_compare" = "false" ] && [ -d "$LOCAL_RESULTS_DIR" ]; then
        local previous=$(ls -t "$LOCAL_RESULTS_DIR"/*.json 2>/dev/null | head -2 | tail -1)
        if [ -n "$previous" ] && [ "$previous" != "$local_file" ]; then
            echo ""
            echo "=== Comparing with previous run ==="
            echo "Previous: $previous"
            echo "Current:  $local_file"
            echo ""
            
            python3 "$SCRIPT_DIR/zram_bench_reporter.py" \
                --compare "$previous" "$local_file"
        fi
    fi
}

compare_files() {
    local file1=$1
    local file2=$2
    
    if [ ! -f "$file1" ]; then
        echo "ERROR: File not found: $file1" >&2
        exit 1
    fi
    
    if [ ! -f "$file2" ]; then
        echo "ERROR: File not found: $file2" >&2
        exit 1
    fi
    
    python3 "$SCRIPT_DIR/zram_bench_reporter.py" --compare "$file1" "$file2"
}

pull_results() {
    local run_id=$1
    
    if [ -n "$run_id" ]; then
        local local_file="${LOCAL_RESULTS_DIR}/${run_id}.json"
        adb pull "$DEVICE_RESULTS" "$local_file"
        echo "✓ Results saved to: $local_file"
    else
        local timestamp=$(date +%Y%m%d_%H%M%S)
        local local_file="${LOCAL_RESULTS_DIR}/${timestamp}.json"
        mkdir -p "$LOCAL_RESULTS_DIR"
        adb pull "$DEVICE_RESULTS" "$local_file"
        echo "✓ Results saved to: $local_file"
    fi
}

list_results() {
    if [ ! -d "$LOCAL_RESULTS_DIR" ]; then
        echo "No results found."
        return
    fi
    
    echo "Local result files:"
    ls -lt "$LOCAL_RESULTS_DIR"/*.json 2>/dev/null | awk '{print "  " $NF " (" $5 " bytes)"}'
}

# Parse command
COMMAND=""
ALGORITHMS="lzo lz4"
MODES="zeros random compressible"
STREAMS="1 2"
ITERATIONS=3
TEST_SIZE=50
NO_COMPARE=false

if [ $# -eq 0 ]; then
    usage
fi

COMMAND=$1
shift

case "$COMMAND" in
    run)
        while [ $# -gt 0 ]; do
            case "$1" in
                -a|--algorithms) ALGORITHMS="$2"; shift 2;;
                -m|--modes) MODES="$2"; shift 2;;
                -s|--streams) STREAMS="$2"; shift 2;;
                -n|--iterations) ITERATIONS="$2"; shift 2;;
                -t|--test-size) TEST_SIZE="$2"; shift 2;;
                --no-compare) NO_COMPARE=true; shift;;
                *) shift;;
            esac
        done
        run_benchmark "$ALGORITHMS" "$MODES" "$STREAMS" "$ITERATIONS" "$TEST_SIZE" "$NO_COMPARE"
        ;;
    compare)
        if [ $# -lt 2 ]; then
            echo "ERROR: compare requires 2 files" >&2
            exit 1
        fi
        compare_files "$1" "$2"
        ;;
    pull)
        pull_results "$1"
        ;;
    list)
        list_results
        ;;
    -h|--help|help)
        usage
        ;;
    *)
        echo "Unknown command: $COMMAND" >&2
        usage
        ;;
esac
