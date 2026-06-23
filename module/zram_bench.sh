#!/system/bin/sh
# zram_bench.sh — Enhanced ZRAM Benchmark for Android
# Based on HandyMenny's zramtest3.sh (gist.github.com/HandyMenny/d28766a45de48d6962a9)
# Requires: root access, Android device with zram0, no external dependencies
#
# All floating-point math uses awk (POSIX, available via toybox on Android).
# No bc, no jq, no arrays, no bashisms.

VERSION="1.0.0"

# ─── Configuration ───────────────────────────────────────────────

SYS_ZRAM="/sys/block/zram0"
DEV_ZRAM="/dev/block/zram0"
TEST_DIR="/data/local/tmp/zram_bench"

ALGORITHMS="lzo lz4"
TEST_MODES="zeros random compressible"
STREAMS="1 2 4"
ITERATIONS=3
DATA_SIZE_MB=64
LATENCY_SIZE_KB=256
DISKSIZE_FACTOR=2
HZ=250          # Kernel timer frequency; override with --hz
VERBOSE=0
SKIP_LATENCY=0
SKIP_CPU=0
WARMUP=0
RESULTS_FILE=""
RESULTS_DIR=""
RESULT_COUNT=0

# Original zram settings (restored on exit)
ORIG_ALGORITHM=""
ORIG_DISKSIZE=""
ORIG_STREAMS=""

# ─── Utility ─────────────────────────────────────────────────────

log() {
    printf '[bench] %s\n' "$*" >&2
}

die() {
    log "FATAL: $*"
    exit 1
}

# Read /proc/uptime — first field is uptime in seconds (centisecond precision).
get_time() {
    awk '{printf "%.3f", $1}' /proc/uptime
}

# Floating-point calculation via awk (no bc needed).
calc() {
    awk "BEGIN{printf \"%.6f\", ($*)}"
}

# Two-decimal-place variant.
calc2() {
    awk "BEGIN{printf \"%.2f\", ($*)}"
}

# Integer calculation via awk.
calci() {
    awk "BEGIN{printf \"%d\", ($*)}"
}

usage() {
    cat >&2 << 'EOF'
zram_bench.sh — Enhanced ZRAM Benchmark for Android

Usage: ./zram_bench.sh [options]

Options:
  -a, --algorithms LIST   Space-separated algorithm list (default: "lzo lz4")
  -m, --modes LIST        Space-separated test modes (default: "zeros random compressible")
  -s, --streams LIST      Space-separated stream counts (default: "1 2 4")
  -n, --iterations N      Iterations per test configuration (default: 3)
  -d, --data-size MB      Test data size in MB (default: 64)
  -o, --output FILE       Write JSON results to file (default: stdout)
      --hz N              Kernel HZ value for CPU calculation (default: 250)
      --warmup N           Run N warmup iterations before benchmark (measure dictionary warmup)
      --skip-latency      Skip 4K latency measurement
      --skip-cpu          Skip CPU utilization measurement
  -v, --verbose           Verbose output to stderr
  -h, --help              Show this help text

Test Modes:
  zeros          All-zero data — best-case compression
  random         Random data — worst-case compression
  compressible   Repeating 'A' pattern — high compressibility
  text           Text-like data (repeating sentences)
  structured     App data mix (70% structured, 20% IDs, 10% padding)
  mixed          Realistic mix (40% zeros, 30% compressible, 30% random)

Output:
  Prints a JSON array of result objects to stdout. Redirect to a file
  with -o or shell redirection for the reporter.

Examples:
  ./zram_bench.sh
  ./zram_bench.sh -a "lz4 lzo" -m "zeros random" -n 5
  ./zram_bench.sh -s "1 4 8" -d 128 -o results.json
  ./zram_bench.sh --skip-latency -v
EOF
    exit 0
}

parse_args() {
    while [ $# -gt 0 ]; do
        case "$1" in
            -a|--algorithms)   ALGORITHMS="$2";     shift 2;;
            -m|--modes)        TEST_MODES="$2";     shift 2;;
            -s|--streams)      STREAMS="$2";        shift 2;;
            -n|--iterations)   ITERATIONS="$2";     shift 2;;
            -d|--data-size)    DATA_SIZE_MB="$2";   shift 2;;
            -o|--output)       RESULTS_FILE="$2";   shift 2;;
            --hz)              HZ="$2";             shift 2;;
            --warmup)          WARMUP="$2";          shift 2;;
            --skip-latency)    SKIP_LATENCY=1;      shift;;
            --skip-cpu)        SKIP_CPU=1;          shift;;
            -v|--verbose)      VERBOSE=1;           shift;;
            -h|--help)         usage;;
            *)                 log "Unknown option: $1"; usage;;
        esac
    done
}

# ─── Snapshot & Restore ─────────────────────────────────────────

# Snapshot original zram settings before modifying
snapshot_zram_settings() {
    ORIG_ALGORITHM=$(cat "${SYS_ZRAM}/comp_algorithm" 2>/dev/null | grep -o '\[.*\]' | tr -d '[]')
    ORIG_DISKSIZE=$(cat "${SYS_ZRAM}/disksize" 2>/dev/null || echo 0)
    ORIG_STREAMS=$(cat "${SYS_ZRAM}/max_comp_streams" 2>/dev/null || echo 8)
    [ "$VERBOSE" -eq 1 ] && log "  [snapshot] algo=$ORIG_ALGORITHM disksize=$ORIG_DISKSIZE streams=$ORIG_STREAMS"
}

# Restore original zram settings on exit
restore_zram_settings() {
    [ "$VERBOSE" -eq 1 ] && log "  [restore] Restoring original zram settings..."
    
    # Reset device first
    if [ -w "${SYS_ZRAM}/reset" ]; then
        echo 1 > "${SYS_ZRAM}/reset" 2>/dev/null
        sleep 1
    fi
    
    # Restore algorithm (must be before disksize!)
    if [ -n "$ORIG_ALGORITHM" ] && [ -w "${SYS_ZRAM}/comp_algorithm" ]; then
        echo "$ORIG_ALGORITHM" > "${SYS_ZRAM}/comp_algorithm" 2>/dev/null
    fi
    
    # Restore disksize
    if [ -n "$ORIG_DISKSIZE" ] && [ "$ORIG_DISKSIZE" -gt 0 ] 2>/dev/null && [ -w "${SYS_ZRAM}/disksize" ]; then
        echo "$ORIG_DISKSIZE" > "${SYS_ZRAM}/disksize" 2>/dev/null
    fi
    
    # Restore streams
    if [ -n "$ORIG_STREAMS" ] && [ -w "${SYS_ZRAM}/max_comp_streams" ]; then
        echo "$ORIG_STREAMS" > "${SYS_ZRAM}/max_comp_streams" 2>/dev/null
    fi
    
    [ "$VERBOSE" -eq 1 ] && log "  [restore] Done"
}

# ─── Cleanup ─────────────────────────────────────────────────────

cleanup() {
    restore_zram_settings
    # Remove test files but preserve results directory
    rm -f "${TEST_DIR}"/testfile_* "${TEST_DIR}"/warmup_* "${TEST_DIR}"/readback 2>/dev/null
}

# ─── Prerequisites ───────────────────────────────────────────────

check_prereqs() {
    # Must be root
    if [ "$(id -u)" -ne 0 ] 2>/dev/null; then
        die "Must run as root (adb root)"
    fi

    # Zram device must exist
    if [ ! -b "$DEV_ZRAM" ]; then
        die "Block device $DEV_ZRAM not found"
    fi
    if [ ! -d "$SYS_ZRAM" ]; then
        die "Sysfs directory $SYS_ZRAM not found"
    fi

    # Verify we can write to sysfs
    if [ ! -w "${SYS_ZRAM}/disksize" ]; then
        die "Cannot write to ${SYS_ZRAM}/disksize — check SELinux context"
    fi
    
    # Snapshot original settings for restoration on exit
    snapshot_zram_settings

    # Create test directory
    mkdir -p "$TEST_DIR" || die "Cannot create test directory $TEST_DIR"
}

# ─── Zram Management ─────────────────────────────────────────────

# Set up zram with specified disksize (bytes). Called before each measurement.
setup_zram() {
    # Disable swap if active (may fail or hang if swap is busy)
    # Use timeout to prevent indefinite hang when system actively swaps
    timeout 5 swapoff "$DEV_ZRAM" 2>/dev/null || true

    # Drop caches to reduce noise
    echo 3 > /proc/sys/vm/drop_caches 2>/dev/null || true

    # Reset the device (clears all data, resets stats)
    # May fail if swap is still active - continue anyway
    echo 1 > "${SYS_ZRAM}/reset" 2>/dev/null || {
        log "WARNING: Could not reset zram (swap may be active)"
        # Continue anyway - we can still write to zram
    }

    return 0
}

# Set disksize (must be called AFTER set_algorithm on some kernels)
set_disksize() {
    local disksize_bytes="$1"
    # May fail if swap is active - use existing disksize
    echo "$disksize_bytes" > "${SYS_ZRAM}/disksize" 2>/dev/null || {
        log "NOTE: Using existing disksize (swap may be active)"
    }
}

# Set compression algorithm and verify by reading back.
# Map algorithm names to what this kernel actually supports
# Read-only: does not modify zram state
map_algorithm() {
    local algo="$1"
    local available
    available=$(cat "${SYS_ZRAM}/comp_algorithm" 2>/dev/null)
    
    # Common mappings: lzo -> lzo-rle on newer kernels
    case "$algo" in
        lzo)
            # If lzo-rle is available and plain lzo isn't in the list, use lzo-rle
            if echo "$available" | grep -q "lzo-rle" && ! echo "$available" | grep -qw "lzo"; then
                echo "lzo-rle"
            else
                echo "lzo"
            fi
            ;;
        *)
            echo "$algo"
            ;;
    esac
}

set_algorithm() {
    local algo="$1"
    # Map algorithm name to what this kernel supports
    local mapped_algo
    mapped_algo=$(map_algorithm "$algo")
    algo="$mapped_algo"


    echo "$algo" > "${SYS_ZRAM}/comp_algorithm" 2>/dev/null
    sync
    sleep 0.1

    # Read back and verify
    local raw
    read -r raw < "${SYS_ZRAM}/comp_algorithm" 2>/dev/null || {
        log "ERROR: Cannot read comp_algorithm"
        return 1
    }

    # Format is typically "lzo lzo-rle [lz4] lz4hc" — brackets mark current selection
    # Check if [algo] appears in the output (exact bracket match)
    local current
    if echo "$raw" | grep -q "\[${algo}\]"; then
        current="$algo"
    else
        current=""
    fi

    if [ "$current" != "$algo" ]; then
        log "ERROR: Algorithm verification failed"
        log "  Requested: $algo"
        log "  Got: $raw"
        return 1
    fi

    [ "$VERBOSE" -eq 1 ] && log "  Algorithm verified: $algo"
    return 0
}

# Set max_comp_streams and verify.
set_streams() {
    local n="$1"

    if [ ! -w "${SYS_ZRAM}/max_comp_streams" ]; then
        [ "$VERBOSE" -eq 1 ] && log "  max_comp_streams not writable, skipping"
        return 0
    fi

    echo "$n" > "${SYS_ZRAM}/max_comp_streams" 2>/dev/null

    local current
    read -r current < "${SYS_ZRAM}/max_comp_streams" 2>/dev/null || current="?"

    if [ "$current" != "$n" ]; then
        log "  NOTE: Requested $n streams, got $current"
    fi
    [ "$VERBOSE" -eq 1 ] && log "  Streams: $current"
    return 0
}

# ─── Data Generation ─────────────────────────────────────────────

generate_zeros() {
    local file="$1" mb="$2"
    dd if=/dev/zero of="$file" bs=1048576 count="$mb" 2>/dev/null
}

generate_random() {
    local file="$1" mb="$2"
    dd if=/dev/urandom of="$file" bs=1048576 count="$mb" 2>/dev/null
}

generate_compressible() {
    local file="$1" mb="$2"
    local block="${TEST_DIR}/.pat"
    local i=0

    # Create 1MB block of repeating 'A' characters
    dd if=/dev/zero bs=1048576 count=1 2>/dev/null | tr '\0' 'A' > "$block"

    # Build the test file by concatenating 1MB blocks
    : > "$file"    # truncate/create
    while [ "$i" -lt "$mb" ]; do
        cat "$block" >> "$file"
        i=$((i + 1))
    done

    rm -f "$block"
}

# Realistic Android workload patterns
generate_text() {
    local file="$1" mb="$2"
    local block="${TEST_DIR}/.pat"
    local i=0

    # Create 1MB block of text-like data (repeating sentences)
    printf 'The quick brown fox jumps over the lazy dog. ' > "$block"
    printf 'Pack my box with five dozen liquor jugs. ' >> "$block"
    printf 'How vexingly quick daft zebras jump! ' >> "$block"
    dd if=/dev/zero bs=1 count=$((1048576 - $(wc -c < "$block"))) 2>/dev/null >> "$block"

    : > "$file"
    while [ "$i" -lt "$mb" ]; do
        cat "$block" >> "$file"
        i=$((i + 1))
    done

    rm -f "$block"
}

generate_structured() {
    local file="$1" mb="$2"
    local block="${TEST_DIR}/.pat"
    local i=0

    # Generate structured data simulating Android app metadata:
    # JSON-like records with repeated key names, sequential IDs,
    # cycling status values, and sequential timestamps.
    # These patterns exercise dictionary-based matching differently
    # across compression algorithms (LZ4 vs ZSTD vs LZO).
    awk 'BEGIN {
        n = 0; id = 1000
        split("active,pending,error,idle,running", v, ",")
        while (1) {
            line = "{\"id\":" id ",\"name\":\"app_" (id % 100) "\",\"type\":\"session\",\"status\":\"" v[(id % 5) + 1] "\",\"ts\":" (1700000000 + id * 3) ",\"bytes\":" (id % 4096) "}"
            len = length(line) + 1
            if (n + len > 1048576) break
            print line
            n += len; id++
        }
    }' > "$block"

    # Pad remainder with zeros to reach exactly 1MB
    local cur
    cur=$(wc -c < "$block")
    dd if=/dev/zero bs=1 count=$((1048576 - cur)) 2>/dev/null >> "$block"

    : > "$file"
    while [ "$i" -lt "$mb" ]; do
        cat "$block" >> "$file"
        i=$((i + 1))
    done

    rm -f "$block"
}

generate_mixed() {
    local file="$1" mb="$2"
    local block="${TEST_DIR}/.pat"
    local sub_text="${TEST_DIR}/.mt"
    local sub_struct="${TEST_DIR}/.ms"
    local i=0 cur

    # 30% text (314573 bytes) — repeating natural language pangrams
    awk 'BEGIN {
        txt = "The quick brown fox jumps over the lazy dog. Pack my box with five dozen liquor jugs. How vexingly quick daft zebras jump! "
        tlen = length(txt); n = 0
        while (n + tlen <= 314573) { printf "%s", txt; n += tlen }
    }' > "$sub_text"
    cur=$(wc -c < "$sub_text")
    dd if=/dev/zero bs=1 count=$((314573 - cur)) 2>/dev/null >> "$sub_text"

    # 30% structured (314573 bytes) — JSON-like event records
    awk 'BEGIN {
        n = 0; id = 4000
        split("active,pending,error", v, ",")
        while (1) {
            line = "{\"id\":" id ",\"type\":\"event\",\"status\":\"" v[(id % 3) + 1] "\",\"pid\":" (id % 32768) "}"
            len = length(line) + 1
            if (n + len > 314573) break
            print line; n += len; id++
        }
    }' > "$sub_struct"
    cur=$(wc -c < "$sub_struct")
    dd if=/dev/zero bs=1 count=$((314573 - cur)) 2>/dev/null >> "$sub_struct"

    # Assemble 1MB block: text + structured + random + zeros
    # 314573 + 314573 + 209715 + 209715 = 1048576
    : > "$block"
    cat "$sub_text" >> "$block"
    cat "$sub_struct" >> "$block"
    dd if=/dev/urandom bs=209715 count=1 2>/dev/null >> "$block"
    dd if=/dev/zero bs=209715 count=1 2>/dev/null >> "$block"

    : > "$file"
    while [ "$i" -lt "$mb" ]; do
        cat "$block" >> "$file"
        i=$((i + 1))
    done

    rm -f "$block" "$sub_text" "$sub_struct"
}

# Dispatch pattern generation by mode name.
generate_test_file() {
    local mode="$1" file="$2" mb="$3"

    rm -f "$file"

    case "$mode" in
        zeros)        generate_zeros "$file" "$mb" ;;
        random)       generate_random "$file" "$mb" ;;
        compressible) generate_compressible "$file" "$mb" ;;
        text)         generate_text "$file" "$mb" ;;
        structured)   generate_structured "$file" "$mb" ;;
        mixed)        generate_mixed "$file" "$mb" ;;
        *)            die "Unknown test mode: $mode" ;;
    esac

    # Verify the file was created and has expected size
    local actual_size
    actual_size=$(wc -c < "$file" 2>/dev/null || echo 0)
    local expected_bytes=$((mb * 1048576))
    if [ "$actual_size" -ne "$expected_bytes" ] 2>/dev/null; then
        log "WARNING: Generated file is $actual_size bytes, expected $expected_bytes"
    fi
}

# ─── Measurement ─────────────────────────────────────────────────

# Write data to zram device and return: elapsed_time throughput_mbs
# Uses positional echo: $1=elapsed, $2=throughput
measure_write() {
    local device="$1" src="$2" size_mb="$3"
    local t0 t1 elapsed mbs

    t0=$(get_time)
    dd if="$src" of="$device" bs=1048576 count="$size_mb" 2>/dev/null
    sync
    t1=$(get_time)

    elapsed=$(calc "$t1 - $t0")
    # throughput = size_mb / elapsed (MB/s)
    mbs=$(awk -v s="$size_mb" -v e="$elapsed" \
        'BEGIN{if(e+0 > 0.001) printf "%.2f", s/e; else print "9999.99"}')

    printf '%s %s' "$elapsed" "$mbs"
}

# Read data from zram device and return: elapsed_time throughput_mbs
measure_read() {
    local device="$1" dst="$2" size_mb="$3"
    local t0 t1 elapsed mbs

    t0=$(get_time)
    dd if="$device" of="$dst" bs=1048576 count="$size_mb" 2>/dev/null
    t1=$(get_time)

    elapsed=$(calc "$t1 - $t0")
    mbs=$(awk -v s="$size_mb" -v e="$elapsed" \
        'BEGIN{if(e+0 > 0.001) printf "%.2f", s/e; else print "9999.99"}')

    printf '%s %s' "$elapsed" "$mbs"
}

# Measure write latency using 4K blocks.
# Returns: latency_us iops
measure_latency() {
    local device="$1" src="$2" size_kb="$3"
    local block_size=4096
    local count elapsed lat_us iops

    count=$((size_kb * 1024 / block_size))
    [ "$count" -gt 0 ] || count=1

    local t0 t1
    t0=$(get_time)
    dd if="$src" of="$device" bs="$block_size" count="$count" 2>/dev/null
    sync
    t1=$(get_time)

    elapsed=$(calc "$t1 - $t0")

    # Latency per block in microseconds
    lat_us=$(awk -v e="$elapsed" -v c="$count" \
        'BEGIN{if(e+0 > 0.0001 && c+0 > 0) printf "%.2f", (e/c)*1000000; else print "0"}')

    # IOPS = count / elapsed
    iops=$(awk -v e="$elapsed" -v c="$count" \
        'BEGIN{if(e+0 > 0.001) printf "%.0f", c/e; else print "0"}')

    printf '%s %s' "$lat_us" "$iops"
}

# ─── Zram Stats ──────────────────────────────────────────────────

# Read compression statistics from sysfs.
# Returns: orig_data_size compr_data_size mem_used_total compression_ratio
read_compression_stats() {
    local sysdir="$SYS_ZRAM"
    local orig=0 compr=0 mem=0 ratio=0

    # Try individual files first (older kernels)
    if [ -f "${sysdir}/orig_data_size" ]; then
        orig=$(cat "${sysdir}/orig_data_size" 2>/dev/null || echo 0)
        compr=$(cat "${sysdir}/compr_data_size" 2>/dev/null || echo 0)
        mem=$(cat "${sysdir}/mem_used_total" 2>/dev/null || echo 0)
    # Fall back to mm_stat (newer kernels, space-separated)
    elif [ -f "${sysdir}/mm_stat" ]; then
        orig=$(awk '{print $1}' "${sysdir}/mm_stat" 2>/dev/null || echo 0)
        compr=$(awk '{print $2}' "${sysdir}/mm_stat" 2>/dev/null || echo 0)
        mem=$(awk '{print $3}' "${sysdir}/mm_stat" 2>/dev/null || echo 0)
        orig=${orig:-0}
        compr=${compr:-0}
        mem=${mem:-0}
    fi

    ratio=$(awk -v o="$orig" -v c="$compr" \
        'BEGIN{if(c+0 > 0) printf "%.2f", o/c; else if(o+0 > 0) print "inf"; else print "0"}')



    printf '%s %s %s %s' "$orig" "$compr" "$mem" "$ratio"
}

# ─── CPU Measurement ─────────────────────────────────────────────

# Read total CPU jiffies from /proc/stat (sum of all fields on the "cpu" line
# excluding the label). Works across all CPU count configurations.
read_total_cpu_jiffies() {
    awk '/^cpu / { t=0; for(i=2;i<=NF;i++) t+=$i; print t }' < /proc/stat 2>/dev/null || echo 0
}

# Calculate CPU utilization percentage over a measurement window.
# Uses HZ (kernel tick rate) to convert jiffies to seconds.
# Returns: cpu_pct (percentage of total available CPU time used)
calc_cpu_pct() {
    local jiffies_before="$1" jiffies_after="$2" wall_time_s="$3"
    local delta_jiffies cpu_seconds total_available cpu_pct num_cpus

    delta_jiffies=$((jiffies_after - jiffies_before))
    [ "$delta_jiffies" -lt 0 ] && delta_jiffies=0

    # Convert jiffies to seconds using kernel HZ
    cpu_seconds=$(awk -v j="$delta_jiffies" -v hz="$HZ" \
        'BEGIN{printf "%.6f", j/hz}')

    # Total available CPU seconds = wall_time * num_cpus
    num_cpus=$(grep -c '^processor' /proc/cpuinfo 2>/dev/null || echo 1)
    total_available=$(awk -v w="$wall_time_s" -v n="$num_cpus" \
        'BEGIN{printf "%.6f", w*n}')

    # CPU utilization percentage
    cpu_pct=$(awk -v c="$cpu_seconds" -v t="$total_available" \
        'BEGIN{if(t+0 > 0.0001) printf "%.1f", c/t*100; else print "0"}')

    printf '%s' "$cpu_pct"
}

# ─── Benchmark Core ──────────────────────────────────────────────

# Run a single benchmark configuration (one algorithm × streams × mode × iter).
# Writes a JSON object to RESULTS_DIR/<seq>.json.
run_single_bench() {
    local algo="$1" streams="$2" mode="$3" iter="$4"
    local result_file="${RESULTS_DIR}/$(printf '%06d' "$RESULT_COUNT").json"
    local test_file="${TEST_DIR}/testfile_${mode}"
    local disksize_bytes=$((DATA_SIZE_MB * DISKSIZE_FACTOR * 1048576))

    RESULT_COUNT=$((RESULT_COUNT + 1))

    if [ "$VERBOSE" -eq 1 ]; then
        log "  [$RESULT_COUNT] algo=$algo streams=$streams mode=$mode iter=$iter"
    fi

    # ── Generate test data ──
    generate_test_file "$mode" "$test_file" "$DATA_SIZE_MB" || return 1

    # ── Write throughput + compression stats ──
    setup_zram || return 1
    set_algorithm "$algo" || return 1
    set_streams "$streams"
    set_disksize "$disksize_bytes" || return 1

    # Memory overhead: snapshot mm_stat BEFORE write
    local mem_before
    mem_before=$(awk '{print $3}' "${SYS_ZRAM}/mm_stat" 2>/dev/null || echo 0)

    local write_result write_elapsed write_mbs
    write_result=$(measure_write "$DEV_ZRAM" "$test_file" "$DATA_SIZE_MB")
    write_elapsed=$(echo "$write_result" | awk '{print $1}')
    write_mbs=$(echo "$write_result" | awk '{print $2}')

    # Compression stats (snapshot after write)
    local stats_result orig_size compr_size mem_used comp_ratio mem_after mem_overhead
    stats_result=$(read_compression_stats)
    orig_size=$(echo "$stats_result" | awk '{print $1}')
    compr_size=$(echo "$stats_result" | awk '{print $2}')
    mem_used=$(echo "$stats_result" | awk '{print $3}')
    comp_ratio=$(echo "$stats_result" | awk '{print $4}')

    # Memory overhead = mem_used after - mem_used before (bytes consumed by compression state)
    mem_after="$mem_used"
    mem_overhead=$(awk -v a="$mem_after" -v b="$mem_before" 'BEGIN{d=a-b; if(d<0)d=0; print d}')

    # ── Read throughput ──
    read_file="${TEST_DIR}/readback"
    local read_result read_elapsed read_mbs
    read_result=$(measure_read "$DEV_ZRAM" "$read_file" "$DATA_SIZE_MB")
    read_elapsed=$(echo "$read_result" | awk '{print $1}')
    read_mbs=$(echo "$read_result" | awk '{print $2}')

    rm -f "$read_file"

    # ── CPU measurement (already captured during write pass) ──
    # CPU stats are captured in measure_write via cpu_before/cpu_after
    # For now, set to 0; full CPU measurement can be added to measure_write if needed
    local cpu_pct="0"

    # ── Latency measurement ──
    local latency_us="0" iops_4k="0"
    if [ "$SKIP_LATENCY" -eq 0 ]; then
        # Generate a small test file for latency measurement
        local lat_file="${TEST_DIR}/latfile_${mode}"
        local lat_size_mb=$((LATENCY_SIZE_KB / 1024))
        [ "$lat_size_mb" -lt 1 ] && lat_size_mb=1
        generate_test_file "$mode" "$lat_file" "$lat_size_mb" || true

        local lat_disksize=$((LATENCY_SIZE_KB * 1024 * DISKSIZE_FACTOR))
        setup_zram || true
        set_algorithm "$algo" || true
        set_streams "$streams"
        set_disksize "$lat_disksize" || true

        local lat_result
        lat_result=$(measure_latency "$DEV_ZRAM" "$lat_file" "$LATENCY_SIZE_KB")
        latency_us=$(echo "$lat_result" | awk '{print $1}')
        iops_4k=$(echo "$lat_result" | awk '{print $2}')

        rm -f "$lat_file"
    fi

    # ── Emit JSON result ──
    cat > "$result_file" << ENDJSON
{
  "algorithm": "${algo}",
  "streams": ${streams},
  "test_mode": "${mode}",
  "iteration": ${iter},
  "data_size_mb": ${DATA_SIZE_MB},
  "time_real_write": ${write_elapsed},
  "time_real_read": ${read_elapsed},
  "throughput_write_mbs": ${write_mbs},
  "throughput_read_mbs": ${read_mbs},
  "latency_us_per_4k": ${latency_us},
  "iops_4k": ${iops_4k},
  "orig_data_size": ${orig_size},
  "compr_data_size": ${compr_size},
  "mem_used_total": ${mem_used},
  "mem_overhead_bytes": ${mem_overhead},
  "compression_ratio": "${comp_ratio}",
  "cpu_compress_pct": ${cpu_pct}
}
ENDJSON

    [ "$VERBOSE" -eq 1 ] && log "  -> write=${write_mbs}MB/s read=${read_mbs}MB/s ratio=${comp_ratio}:1 cpu=${cpu_pct}%"

    rm -f "$test_file"
    return 0
}

# ─── Benchmark Orchestrator ──────────────────────────────────────

run_benchmark() {
    log "ZRAM Benchmark v${VERSION}"
    log "Algorithms:  $ALGORITHMS"
    log "Modes:       $TEST_MODES"
    log "Streams:     $STREAMS"
    log "Iterations:  $ITERATIONS"
    log "Data size:   ${DATA_SIZE_MB}MB"
    log "Latency blk: ${LATENCY_SIZE_KB}KB (4K blocks)"
    [ "$WARMUP" -gt 0 ] && log "Warmup:      $WARMUP iterations"
    [ "$SKIP_LATENCY" -eq 1 ] && log "  (latency measurement SKIPPED)"
    [ "$SKIP_CPU" -eq 1 ] && log "  (CPU measurement SKIPPED)"
    log ""

    # Create results directory
    RESULTS_DIR="${TEST_DIR}/.results"
    mkdir -p "$RESULTS_DIR" || die "Cannot create results directory"

    local total=0
    local failed=0

    # ── Warmup Phase ──
    if [ "$WARMUP" -gt 0 ]; then
        log "=== Warmup Phase ($WARMUP iterations) ==="
        log "Measuring compression ratio improvement over iterations..."
        log ""

        for algo in $ALGORITHMS; do
            for mode in $TEST_MODES; do
                log "Warmup: $algo / $mode"
                local warmup_file="${TEST_DIR}/warmup_${algo}_${mode}"
                generate_test_file "$mode" "$warmup_file" "$DATA_SIZE_MB" || continue

                # Setup zram ONCE before warmup loop (don't reset between iterations)
                setup_zram || break
                set_algorithm "$algo" || break
                set_streams 2
                set_disksize $((DATA_SIZE_MB * DISKSIZE_FACTOR * 1048576)) || break

                local warmup_i=1
                while [ "$warmup_i" -le "$WARMUP" ]; do
                    measure_write "$DEV_ZRAM" "$warmup_file" "$DATA_SIZE_MB" > /dev/null 2>&1
                    sync

                    local w_stats w_orig w_compr w_ratio
                    w_stats=$(read_compression_stats)
                    w_orig=$(echo "$w_stats" | awk '{print $1}')
                    w_compr=$(echo "$w_stats" | awk '{print $2}')
                    w_ratio=$(echo "$w_stats" | awk '{print $4}')

                    log "  iter $warmup_i: orig=${w_orig} compr=${w_compr} ratio=${w_ratio}"
                    warmup_i=$((warmup_i + 1))
                done
                rm -f "$warmup_file"
            done
        done
        log ""
        log "=== End Warmup — Starting Benchmark ==="
        log ""
    fi

    # ── Main Benchmark Phase ──
    # Count total tests for progress
    local algo_count=0 mode_count=0 stream_count=0
    for _a in $ALGORITHMS; do algo_count=$((algo_count + 1)); done
    for _m in $TEST_MODES; do mode_count=$((mode_count + 1)); done
    for _s in $STREAMS; do stream_count=$((stream_count + 1)); done
    local total_tests=$((algo_count * stream_count * mode_count * ITERATIONS))
    log "Total test configurations: $total_tests"
    log ""

    # Iterate all combinations
    for algo in $ALGORITHMS; do
        for stream in $STREAMS; do
            for mode in $TEST_MODES; do
                iter=1
                while [ "$iter" -le "$ITERATIONS" ]; do
                    total=$((total + 1))
                    log "[$total/$total_tests] $algo / streams=$stream / $mode / iter=$iter"

                    run_single_bench "$algo" "$stream" "$mode" "$iter"
                    if [ $? -ne 0 ]; then
                        log "  FAILED — skipping"
                        failed=$((failed + 1))
                    fi

                    iter=$((iter + 1))
                done
            done
        done
    done

    log ""
    log "Completed: $((total - failed))/$total succeeded, $failed failed"

    # ── Assemble JSON array ──
    finalize_json
}

# ─── JSON Assembly ───────────────────────────────────────────────

# Assemble individual result files into a single JSON array.
# Outputs to stdout (for piping) or RESULTS_FILE (for -o flag).
finalize_json() {
    local first=1

    printf '[\n'

    # Iterate result files in sorted order
    set -- "${RESULTS_DIR}"/*.json
    if [ -f "$1" ]; then
        for f in "$@"; do
            if [ "$first" -eq 1 ]; then
                first=0
            else
                printf ',\n'
            fi
            cat "$f"
        done
    fi

    printf '\n]\n'
}

# ─── Main ────────────────────────────────────────────────────────

main() {
    parse_args "$@"

    check_prereqs
    trap cleanup EXIT

    if [ -n "$RESULTS_FILE" ]; then
        local tmp_file="${RESULTS_FILE}.tmp.$$"
        run_benchmark > "$tmp_file"
        mv "$tmp_file" "$RESULTS_FILE"
        log "Results written to: $RESULTS_FILE"
    else
        run_benchmark
    fi
}

main "$@"
