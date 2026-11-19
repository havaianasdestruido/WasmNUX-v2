# ADR-0007: GPU Acceleration Path

- **Status:** Accepted
- **Date:** 2026-11-19

## Decision
Adopt **Path C (custom `virtio-webgpu` context carrying WebGPU-shaped command streams via a Mesa driver)** as the primary hardware-accelerated path, with **Path D (`lavapipe`/`llvmpipe` with Wasm SIMD + threads)** as the software fallback.

## Rationale
Spike D compared all four paths:
- Path A (`virgl`): 68% conformance, no compute, legacy GL impedance mismatch.
- Path B (`Venus`/Vulkan): 74% conformance, Vulkan-to-WebGPU translation gaps.
- Path C (`virtio-webgpu`): **98% conformance**, 24 B/draw overhead, ~19.8M draws/s ring throughput, 0.025 ms/frame 1080p scanout.
- Path D (`lavapipe` SIMD): 100% conformance fallback when WebGPU is unavailable.
