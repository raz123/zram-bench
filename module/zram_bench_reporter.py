#!/usr/bin/env python3
"""
zram_bench_reporter.py - ZRAM Benchmark Results Reporter

Generates markdown reports from zram_bench.sh JSON output.
Supports single-file summary and two-file comparison modes.
"""

import json
import sys
import argparse
from datetime import datetime
from pathlib import Path
from typing import List, Dict, Any, Optional, Tuple


def load_results(filepath: str) -> List[Dict[str, Any]]:
    """Load JSON results from file."""
    try:
        with open(filepath, 'r') as f:
            data = json.load(f)
        if not isinstance(data, list):
            print(f"Error: Expected JSON array in {filepath}, got {type(data).__name__}", file=sys.stderr)
            sys.exit(1)
        return data
    except FileNotFoundError:
        print(f"Error: File not found: {filepath}", file=sys.stderr)
        sys.exit(1)
    except json.JSONDecodeError as e:
        print(f"Error: Invalid JSON in {filepath}: {e}", file=sys.stderr)
        sys.exit(1)
    except PermissionError:
        print(f"Error: Permission denied: {filepath}", file=sys.stderr)
        sys.exit(1)


def calculate_compression_ratio(orig: int, compr: int) -> float:
    """Calculate compression ratio (orig/compr)."""
    if compr == 0:
        return 0.0
    return orig / compr


def format_size(size_bytes: int) -> str:
    """Format bytes to human readable."""
    for unit in ['B', 'KB', 'MB', 'GB']:
        if abs(size_bytes) < 1024.0:
            return f"{size_bytes:.1f}{unit}"
        size_bytes /= 1024.0
    return f"{size_bytes:.1f}TB"


def format_ratio(ratio: float) -> str:
    """Format compression ratio."""
    return f"{ratio:.2f}:1"


def format_delta(before: float, after: float, threshold: float = 5.0, lower_is_better: bool = False) -> Tuple[str, str]:
    """Calculate and format delta with status indicator."""
    if before == 0 and after == 0:
        return "0.0%", "➖ NO_CHANGE"
    if before == 0:
        return "N/A", "➖ NO_CHANGE"
    
    delta_pct = ((after - before) / before) * 100
    
    if lower_is_better:
        # For metrics where lower is better (latency, CPU%)
        if abs(delta_pct) < threshold:
            return f"{delta_pct:+.1f}%", "➖ NO_CHANGE"
        elif delta_pct < 0:
            return f"{delta_pct:.1f}%", "✅ IMPROVED"
        else:
            return f"+{delta_pct:.1f}%", "⚠️ REGRESSED"
    else:
        # For metrics where higher is better (throughput, compression ratio)
        if abs(delta_pct) < threshold:
            return f"{delta_pct:+.1f}%", "➖ NO_CHANGE"
        elif delta_pct > 0:
            return f"+{delta_pct:.1f}%", "✅ IMPROVED"
        else:
            return f"{delta_pct:.1f}%", "⚠️ REGRESSED"


def generate_summary(results: List[Dict[str, Any]], title: str = "ZRAM Benchmark Summary") -> str:
    """Generate summary report from single results file."""
    # Group by algorithm
    algorithms: Dict[str, List[Dict[str, Any]]] = {}
    for r in results:
        alg = r.get('algorithm', 'unknown')
        if alg not in algorithms:
            algorithms[alg] = []
        algorithms[alg].append(r)
    
    lines = [
        f"# {title}",
        f"Generated: {datetime.now().isoformat()}",
        f"Total runs: {len(results)}",
        "",
    ]
    
    # Summary table
    lines.extend([
        "## Algorithm Comparison",
        "",
        "| Algorithm | Avg Write (MB/s) | Avg Read (MB/s) | Avg Ratio | Avg Latency (µs) | Mem Overhead (KB) | Runs |",
        "|-----------|------------------|-----------------|-----------|------------------|-------------------|------|"
    ])
    
    best_write = 0
    best_alg_write = ""
    best_ratio = 0
    best_alg_ratio = ""
    
    for alg, runs in algorithms.items():
        avg_write = sum(r.get('throughput_write_mbs', 0) for r in runs) / len(runs)
        avg_read = sum(r.get('throughput_read_mbs', 0) for r in runs) / len(runs)
        avg_ratio = sum(
            calculate_compression_ratio(
                r.get('orig_data_size', 0),
                r.get('compr_data_size', 0)
            ) for r in runs
        ) / len(runs)
        avg_latency = sum(r.get('latency_us_per_4k', 0) for r in runs) / len(runs)
        avg_mem_overhead = sum(r.get('mem_overhead_bytes', 0) for r in runs) / len(runs) / 1024
        
        lines.append(
            f"| {alg} | {avg_write:.1f} | {avg_read:.1f} | {format_ratio(avg_ratio)} | {avg_latency:.1f} | {avg_mem_overhead:.1f} | {len(runs)} |"
        )
        
        if avg_write > best_write:
            best_write = avg_write
            best_alg_write = alg
        if avg_ratio > best_ratio:
            best_ratio = avg_ratio
            best_alg_ratio = alg
    
    lines.extend(["", ""])
    
    # Recommendations
    lines.extend([
        "## Recommendations",
        "",
        f"🏆 **Best Throughput**: {best_alg_write} ({best_write:.1f} MB/s)",
        f"🏆 **Best Compression**: {best_alg_ratio} ({format_ratio(best_ratio)})",
        ""
    ])
    
    # Detailed results by algorithm
    lines.extend(["## Detailed Results", ""])
    
    for alg, runs in algorithms.items():
        lines.extend([
            f"### {alg.upper()}",
            "",
            "| Pattern | Streams | Write (MB/s) | Read (MB/s) | Ratio | Latency (µs) | CPU % |",
            "|---------|---------|--------------|-------------|-------|--------------|-------|"
        ])
        
        for r in runs:
            ratio = calculate_compression_ratio(
                r.get('orig_data_size', 0),
                r.get('compr_data_size', 0)
            )
            lines.append(
                f"| {r.get('test_mode', 'N/A')} | {r.get('streams', 'N/A')} | "
                f"{r.get('throughput_write_mbs', 0):.1f} | {r.get('throughput_read_mbs', 0):.1f} | "
                f"{format_ratio(ratio)} | {r.get('latency_us_per_4k', 0):.1f} | "
                f"{r.get('cpu_compress_pct', 0):.1f} |"
            )
        
        lines.extend(["", ""])
    
    return "\n".join(lines)


def generate_comparison(
    baseline: List[Dict[str, Any]],
    current: List[Dict[str, Any]],
    threshold: float = 5.0
) -> str:
    """Generate comparison report between two result sets."""
    
    # Group both by algorithm + pattern + streams
    def make_key(r: Dict[str, Any]) -> str:
        return f"{r.get('algorithm')}_{r.get('test_mode')}_{r.get('streams')}"
    
    baseline_grouped: Dict[str, List[Dict[str, Any]]] = {}
    current_grouped: Dict[str, List[Dict[str, Any]]] = {}
    
    for r in baseline:
        key = make_key(r)
        if key not in baseline_grouped:
            baseline_grouped[key] = []
        baseline_grouped[key].append(r)
    
    for r in current:
        key = make_key(r)
        if key not in current_grouped:
            current_grouped[key] = []
        current_grouped[key].append(r)
    
    lines = [
        "# ZRAM Benchmark Comparison",
        f"Generated: {datetime.now().isoformat()}",
        f"Baseline runs: {len(baseline)}",
        f"Current runs: {len(current)}",
        "",
        "## Comparison Results",
        "",
        "| Algorithm | Pattern | Streams | Metric | Before | After | Delta | Status |",
        "|-----------|---------|---------|--------|--------|-------|-------|--------|"
    ]
    
    improvements = 0
    regressions = 0
    no_change = 0
    
    for key in sorted(set(list(baseline_grouped.keys()) + list(current_grouped.keys()))):
        if key not in baseline_grouped or key not in current_grouped:
            continue
        
        base_runs = baseline_grouped[key]
        curr_runs = current_grouped[key]
        
        # Average across iterations
        algo = base_runs[0].get('algorithm', 'N/A')
        pattern = base_runs[0].get('test_mode', 'N/A')
        streams = base_runs[0].get('streams', 'N/A')
        
        metrics = [
            ('throughput_write_mbs', 'Write (MB/s)', False),
            ('throughput_read_mbs', 'Read (MB/s)', False),
            ('latency_us_per_4k', 'Latency (µs)', True),
            ('cpu_compress_pct', 'CPU %', True),
            ('mem_overhead_bytes', 'Mem Overhead (B)', True)
        ]
        
        for metric_key, metric_name, lower_is_better in metrics:
            base_val = sum(r.get(metric_key, 0) for r in base_runs) / len(base_runs)
            curr_val = sum(r.get(metric_key, 0) for r in curr_runs) / len(curr_runs)
            
            delta, status = format_delta(base_val, curr_val, threshold, lower_is_better)
            
            if "IMPROVED" in status:
                improvements += 1
            elif "REGRESSED" in status:
                regressions += 1
            else:
                no_change += 1
            
            lines.append(
                f"| {algo} | {pattern} | {streams} | {metric_name} | "
                f"{base_val:.1f} | {curr_val:.1f} | {delta} | {status} |"
            )
        
        # Compression ratio
        base_ratio = sum(
            calculate_compression_ratio(r.get('orig_data_size', 0), r.get('compr_data_size', 0))
            for r in base_runs
        ) / len(base_runs)
        curr_ratio = sum(
            calculate_compression_ratio(r.get('orig_data_size', 0), r.get('compr_data_size', 0))
            for r in curr_runs
        ) / len(curr_runs)
        
        delta, status = format_delta(base_ratio, curr_ratio, threshold)
        if "IMPROVED" in status:
            improvements += 1
        elif "REGRESSED" in status:
            regressions += 1
        else:
            no_change += 1
        
        lines.append(
            f"| {algo} | {pattern} | {streams} | Compression Ratio | "
            f"{format_ratio(base_ratio)} | {format_ratio(curr_ratio)} | {delta} | {status} |"
        )
    
    lines.extend([
        "",
        "## Summary",
        "",
        f"- ✅ Improvements: {improvements}",
        f"- ⚠️ Regressions: {regressions}",
        f"- ➖ No Change: {no_change}",
        ""
    ])
    
    if regressions > 0:
        lines.append("⚠️ **ACTION REQUIRED**: Regressions detected. Review changes before merging.")
    elif improvements > 0:
        lines.append("✅ **LOOKING GOOD**: Improvements detected with no regressions.")
    else:
        lines.append("➖ **NEUTRAL**: No significant changes detected.")
    
    return "\n".join(lines)


def main():
    parser = argparse.ArgumentParser(
        description='ZRAM Benchmark Results Reporter',
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  # Generate summary from single file
  %(prog)s --summary results.json
  
  # Compare two runs
  %(prog)s --compare baseline.json current.json
  
  # Compare with custom threshold
  %(prog)s --compare old.json new.json --threshold 10
        """
    )
    
    parser.add_argument('files', nargs='+', help='JSON result files')
    parser.add_argument('--compare', action='store_true', 
                        help='Compare two files (requires exactly 2 files)')
    parser.add_argument('--summary', action='store_true',
                        help='Generate summary from single file')
    parser.add_argument('--threshold', type=float, default=5.0,
                        help='Delta threshold for status (default: 5%%)')
    parser.add_argument('-o', '--output', help='Output to file (default: stdout)')
    
    args = parser.parse_args()
    
    if args.compare and len(args.files) != 2:
        parser.error("--compare requires exactly 2 files")
    
    if args.summary and len(args.files) != 1:
        parser.error("--summary requires exactly 1 file")
    
    # Default to summary if only 1 file
    if len(args.files) == 1 and not args.compare:
        args.summary = True
    
    # Load results
    results = [load_results(f) for f in args.files]
    
    # Generate report
    if args.compare:
        report = generate_comparison(results[0], results[1], args.threshold)
    else:
        report = generate_summary(results[0])
    
    # Output
    if args.output:
        Path(args.output).write_text(report)
        print(f"Report saved to: {args.output}", file=sys.stderr)
    else:
        print(report)


if __name__ == '__main__':
    main()
