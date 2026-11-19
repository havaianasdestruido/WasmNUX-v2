# ADR-0007: Separate scanout from guest 3D; keep all four paths open

**Status:** Provisional. No guest 3D path selected on performance or conformance.

**Decision.** Use WebGPU for host scanout where available, software fallback otherwise. Compare each guest path in matched VM configurations before committing to an accelerated ABI:

| Path | Expected API/evidence | Main risk | Speed/conformance evidence |
|---|---|---|---|
| A: virgl-style GL | OpenGL subset; `glmark2`, GL dEQP | Translating GL state/shaders to WebGPU; feature gaps | Unmeasured; browser backend absent |
| B: Venus serialization | Vulkan subset; `vkcube`, Vulkan dEQP | Vulkan synchronization, resource semantics and extensions exceed WebGPU | Unmeasured; browser backend absent |
| C: WebGPU-shaped virtio context + Mesa driver | Advertised Mesa GL/Vulkan subset; dEQP and WebGPU validation | Custom guest driver and upstream maintenance | Unmeasured; guest driver absent |
| D: llvmpipe/lavapipe | CPU GL/Vulkan baseline; same relevant conformance subsets | SIMD/threads CPU load and latency | Unmeasured in guest; SwiftShader is not this path |

**Trade-offs.** A/B reuse guest protocols but not their native rendering backends. C aligns command streams with browser primitives at the cost of new guest code. D provides a compatibility fallback, not acceleration. WebGPU is not full Vulkan.

**Evidence and revisit.** Browser data measures upload/copy and glyph rendering queue completion. The packaged headless shell may fall back to a GPU texture rather than canvas presentation. Use the graphics matrix harness on real GPU hosts and use matched frame traces and advertised capabilities; capture 1080p compositor and input-to-photon measurements separately.
