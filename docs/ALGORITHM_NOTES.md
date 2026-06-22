# Compression Algorithm Notes

Technical details on ZRAM compression algorithms commonly available on Android kernels.

## LZO

- **Type**: LZ77-based
- **Compression speed**: Fast
- **Decompression speed**: Very fast
- **Compression ratio**: Moderate
- **CPU usage**: Low
- **Memory**: Low footprint
- **Notes**: Default algorithm on many Android kernels. Good balance of speed and ratio. The LZO1X variant is typically used in the kernel.

## LZ4

- **Type**: LZ77-based
- **Compression speed**: Very fast (fastest available)
- **Decompression speed**: Very fast
- **Compression ratio**: Slightly lower than LZO
- **CPU usage**: Very low
- **Memory**: Low footprint
- **Notes**: Designed for speed over ratio. Often the best choice when CPU is the bottleneck. On multi-core devices, the difference from LZO is minimal for throughput but measurable for latency.

## ZSTD (Zstandard)

- **Type**: FSE + Huffman + LZ77
- **Compression speed**: Configurable (levels 1-3 typically used in kernel)
- **Decompression speed**: Fast
- **Compression ratio**: Best available in kernel
- **CPU usage**: Higher than LZO/LZ4
- **Memory**: Higher dictionary and workspace requirements
- **Notes**: Available on kernel 4.19+ (backported to some 4.14 kernels). Level 1 is a good default; levels 2-3 trade CPU for ratio. Best for devices with CPU headroom.

## LZ4HC

- **Type**: LZ77 with hash chain
- **Compression speed**: Slow (compression only)
- **Decompression speed**: Very fast (same as LZ4)
- **Compression ratio**: Better than LZ4
- **CPU usage**: High during compression
- **Memory**: Higher than LZ4
- **Notes**: Not commonly used for ZRAM because the compression CPU cost is too high for the swap path. Decompression is identical to LZ4.

## 842

- **Type**: Hardware-accelerated (PowerPC / specific SoCs)
- **Compression speed**: Very fast (with hardware)
- **Decompression speed**: Very fast (with hardware)
- **Compression ratio**: Low
- **CPU usage**: Minimal (offloaded to hardware)
- **Notes**: Requires hardware support. Not available on ARM Android devices. Included here for completeness.

## Algorithm Selection Guide

| Priority | Best Algorithm |
|----------|---------------|
| Maximum throughput | LZ4 |
| Maximum compression | ZSTD |
| Balanced (default) | LZO |
| Latency-sensitive | LZ4 |
| CPU-constrained | LZ4 |
| Memory-constrained | LZO |

## Multi-Stream Considerations

`max_comp_streams` controls how many compression contexts are used in parallel. On multi-core devices:

- **1 stream**: Single-core compression, lowest memory overhead
- **2 streams**: Good default for dual/quad-core devices
- **4+ streams**: Diminishing returns on most mobile SoCs; increases memory overhead

The optimal stream count depends on the SoC's core topology and memory bandwidth. Benchmark results typically show diminishing returns beyond 2-4 streams on mobile devices.

## Kernel Configuration

Relevant kernel config options:

```
CONFIG_ZRAM=y
CONFIG_ZRAM_DEF_COMP="lz4"      # Default algorithm
CONFIG_CRYPTO_LZ4=y
CONFIG_CRYPTO_LZO=y
CONFIG_CRYPTO_ZSTD=y             # If available
```

The available algorithms depend on which crypto modules are compiled into the kernel. `zram_bench.sh` maps user-friendly names to the actual kernel module names (e.g., `lzo` -> `lzo-rle` on newer kernels).
