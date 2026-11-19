# ADR-0007: GPU acceleration path — four paths compared, leading option C

- **Status:** Accepted in Phase 0 as *comparison + leading option*; final
  implementation choice re-validated with in-browser numbers in Phase 2
- **Date:** 2026-11

## Context

WebGPU is a **subset of Vulkan**, so a guest that speaks DRM/Vulkan/GL needs
one of four host strategies. Each differs in conformance, performance, and
engineering effort (Spike D compares them).

## Decision (Phase 0 model — see `spikes/spike-d-display/src/gpu-paths.ts`)

| Path | Conformance (weighted) | Perf class | Effort | Notes |
|---|---|---|---|---|
| (A) virgl-style GL relay | ~lower | 3 | 3 | GL-only, mature guest-side story |
| (B) Venus/Vulkan serialization | mid | 3 | 4 | Vulkan 1.x coverage; large driver surface |
| **(C) WebGPU-shaped virtio-gpu + Mesa driver** | **80.4 % (best composite)** | **4** | **5** | fewest translation layers, zero-copy scanout targets; needs a new Mesa driver |
| (D) lavapipe/llvmpipe (Wasm SIMD + threads) | highest | 2 | 2 | software fallback; works with WebGPU disabled |

**Leading option: (C)**, with **(D) as the guaranteed fallback** and
(A)/(B) kept as reference implementations for feature-gap analysis.

## Evidence (Phase 0)

- Deterministic scoring model (10 weighted features) in `gpu-paths.ts`,
  tested for stability (`display.test.ts`); row `d4` records scores.
- WebGPU vs Canvas2D scanout cost (row `d5`) runs in `web/index.html`
  (browser required — Phase 1 gate).

## Consequences

- Phase 2 implements (C): guest command stream ≈ WebGPU encoder semantics;
  shader translation GLSL/SPIR-V → WGSL via Naga/Tint-class tooling.
- Feature-gap matrix (WebGPU ⊂ Vulkan) published with software fallback log
  lines (roadmap Phase 2 checklist).
- Guest framebuffer = GPU texture (zero-copy) where the path allows.
