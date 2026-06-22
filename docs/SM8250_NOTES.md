# SM8250 (Snapdragon 865/870) Platform Notes

Device-specific findings for ZRAM benchmarking on Qualcomm SM8250-based devices.

## Platform Overview

- **SoC**: Qualcomm SM8250 (Snapdragon 865) / SM8250-AB (Snapdragon 870)
- **CPU**: 1x Cortex-A77 Prime + 3x Cortex-A77 Performance + 4x Cortex-A55 Efficiency
- **RAM**: LPDDR5 (typically 6-12 GB)
- **Kernel**: Varies by OEM (typically 4.19 or 5.4 with Qualcomm patches)

## Devices Tested

| Device | SoC | Android | Kernel | RAM |
|--------|-----|---------|--------|-----|
| POCO F3 | SM8250-AB | 12+ | 4.19 | 6-8 GB |

## Key Findings

### Compression Ratios

- **LZ4 + zeros**: Effectively infinite (compressed size ~0)
- **LZ4 + compressible**: ~32:1 ratio
- **LZ4 + random**: ~1:1 (no compression benefit)
- **LZO + zeros**: Effectively infinite
- **LZO + compressible**: ~31:1 ratio

### Throughput

- **LZ4 write**: 290-320 MB/s (2 streams, 32MB test)
- **LZO write**: 270-300 MB/s (2 streams, 32MB test)
- **Read throughput**: Consistently higher than write (400-460 MB/s)

### Latency

- 4K block latency is heavily influenced by the test data pattern
- Zero-compressed blocks have near-zero read latency
- Random data shows highest latency due to uncompressed I/O path

### Multi-Stream

- **CRITICAL: On SM8250 (8 cores), max_comp_streams silently ignores values below 8.** Setting 1, 2, or 4 streams has no effect — the kernel uses all 8 cores regardless. Verify with: `cat /sys/block/zram0/max_comp_streams` after setting.

### CPU Utilization

- Compression CPU usage is minimal for LZ4 on this platform
- The A77 Prime core handles most compression work efficiently
- LZO shows slightly higher CPU usage than LZ4

## Kernel Notes

- SM8250 devices typically ship with kernel 4.19 (Qualcomm's android-4.19 branch)
- Some custom ROMs may use 5.4 or 5.10 kernels
- **CRITICAL**: On SM8250 (4.19), the algorithm MUST be set before disksize. Setting disksize first causes the algorithm write to fail silently.
- Algorithm names may differ between kernel versions:
  - On SM8250 (4.19), only `lzo-rle` is available. The plain `lzo` name is rejected with an error.
  - `zram_bench.sh` maps `lzo` -> `lzo-rle` automatically when needed
- After a zram reset (`echo 1 > reset`), the default algorithm reverts to lz4 (CONFIG_ZRAM_DEF_COMP). The script resets the device before each test, so the algorithm must be re-set each time.
- **No `algorithm_params` support** — dict= and level= parameters require kernel 6.x+ (Sergey Senozhatsky's "custom comp backends API", 2024). Not available on 4.19.

## Recommendations for SM8250

1. **Default choice**: LZ4 with 2 streams for best throughput-to-ratio balance
2. **If memory is tight**: ZSTD with 1-2 streams for better compression ratio
3. **Stream count**: Start with 2, benchmark up to 4 if memory allows
4. **Warmup**: Enable `--warmup 1-3` for more realistic compression ratio measurements, as LZ algorithms improve their dictionary with repeated data

## Known Issues

- Some SM8250 devices report 0 for `compr_data_size` when compression ratio is "inf" (all zeros). This is expected behavior — the kernel optimizes zero pages to use no compressed storage.
- On newer kernels, individual sysfs files (orig_data_size, compr_data_size, mem_used_total) may not exist. `mm_stat` is the standard source — it is a space-separated file with fields: orig_data_size, compr_data_size, mem_used_total, same_pages, pages_compacted, huge_pages.
- CPU HZ may differ from the default 250 — use `--hz` to override if CPU percentages look incorrect.
