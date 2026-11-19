# ADR-0007: GPU Acceleration Path

- **Status:** Accepted
- **Date:** 2026-11-19

## Decision
Adopt **Path C (custom `virtio-webgpu` context carrying WebGPU-shaped command streams via a Mesa driver)** as the primary hardware-accelerated path, with **Path D (`lavapipe`/`llvmpipe` with Wasm SIMD + threads)** as the software fallback.

## Rationale
Spike D evaluated the architectural trade-offs (estimated conformance based on WebGPU vs OpenGL/Vulkan feature matrices) and benchmarked the command-stream ring and 1080p scanout:
- Path A (`virgl`): ~68% estimated conformance, no compute, legacy GL impedance mismatch.
- Path B (`Venus`/Vulkan): ~74% estimated conformance, Vulkan-to-WebGPU translation gaps.
- Path C (`virtio-webgpu`): **~98% estimated conformance**, 24 B/draw overhead, ~19.8M draws/s ring throughput, 0.025 ms/frame 1080p scanout.
- Path D (`lavapipe` SIMD): 100% software conformance fallback when WebGPU is unavailable.
