# Contributing to zram-bench

Thanks for your interest in contributing! Here's how to get started.

## Development Setup

1. Clone the repository
2. Connect a rooted Android device via ADB
3. Run `./src/run_bench.sh run` to verify the full pipeline works

## Making Changes

### Shell script (`zram_bench.sh`)

- **POSIX-only**: No bashisms, no arrays, no `[[ ]]`, no process substitution
- **No external dependencies**: Must work with Android's toybox (awk, dd, cat, etc.)
- All floating-point math goes through `awk`
- Test on-device before submitting

### Python reporter (`zram_bench_reporter.py`)

- Python 3.6+ compatible
- No external dependencies (stdlib only)
- Type hints encouraged

### Orchestrator (`run_bench.sh`)

- Standard bash (host-side, not device-side)
- Must handle ADB connection errors gracefully

## Testing

- Run the full benchmark on at least one device before submitting algorithm or measurement changes
- Verify JSON output parses correctly with `python3 -m json.tool`
- Test the reporter in both `--summary` and `--compare` modes

## Submitting Changes

1. Fork the repository
2. Create a feature branch (`git checkout -b my-feature`)
3. Commit with clear, descriptive messages
4. Push and open a pull request
5. Describe what you tested and on which device

## Reporting Issues

Include:
- Device model and kernel version (`cat /proc/version`)
- Android version
- Algorithm and test mode being used
- Full command that triggered the issue
- Complete error output

## Code Style

- Shell: 4-space indentation, descriptive variable names
- Python: PEP 8, type hints on public functions
- Commit messages: imperative mood, < 72 chars
