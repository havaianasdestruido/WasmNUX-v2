# ADR-0007: GPU acceleration path

- **Status:** Proposed (Phase 0) — **deliberately undecided**, resolved by Spike D in Phase 6
- **Related:** ADR-0009, ADR-0010, ADR-0013

## Context

The guest wants hardware-accelerated GL/Vulkan. The browser offers WebGPU, which
is a _subset_ of Vulkan with a different object model, a different shading
language (WGSL), no geometry/tessellation shaders, different limits, and no
direct handle to a host GPU queue. There is no way to hand a guest a GPU: every
path is some form of command serialisation plus translation.

ROADMAP §3 lists four candidates. This ADR records what they are, what would
decide between them, and — importantly — what has to be true regardless of which
one wins, so that the software baseline is not an afterthought.

## The four paths

|       | Path                                                  | Mechanism                                                                            | Main risk                                                                                                       |
| ----- | ----------------------------------------------------- | ------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------- |
| **A** | virgl-style GL                                        | Guest Mesa GL driver → virgl command stream → host translates to WebGPU              | Translating a GL state machine onto WebGPU is a large, lossy job; virgl's protocol assumes a GL backend         |
| **B** | Venus / Vulkan serialisation                          | Guest Mesa Venus driver → serialised Vulkan commands → host deserialises onto WebGPU | Closest semantic match to WebGPU, but Venus expects a real Vulkan device; every gap becomes host-side emulation |
| **C** | Custom virtio-gpu context with WebGPU-shaped commands | Our own guest Mesa driver emits commands already shaped like WebGPU                  | Least translation, but we own a Mesa driver forever, and it only helps apps that go through it                  |
| **D** | llvmpipe/lavapipe with Wasm SIMD + threads            | Software rasterisation, no host GPU                                                  | Slow, but always available and always correct                                                                   |

## Decision (provisional)

1. **Path D is not optional and is not a fallback — it is the conformance
   baseline.** Every other path is measured against it. It must exist, be
   correct, and be fast enough to run a desktop compositor before any
   acceleration work starts, because it is also what Tier-2/3 browsers get.
2. **Paths A, B and C are spiked, not argued.** Spike D compares them on
   conformance (`glxinfo`, `vulkaninfo`, `vkcube`, `glmark2`, Mesa/dEQP subsets)
   and speed, with a published feature-gap matrix, because WebGPU ⊂ Vulkan means
   some features are unsupported no matter which path wins.
3. **B is the leading candidate on semantic grounds** (Vulkan→WebGPU is the
   shortest translation distance and Venus already serialises Vulkan), with **C**
   as the fallback if the gap-emulation cost dominates. This is a hypothesis to
   be falsified by Spike D, not a conclusion.
4. **Scanout is separate from acceleration.** 2D scanout via `virtio-gpu`
   presented by WebGPU in the display worker (Phase 5) does not depend on this
   decision and ships first.
5. **Zero-copy render targets** (guest framebuffer as a GPU texture) are a
   requirement on whichever path wins, not a nice-to-have: without them, every
   frame costs a readback.
6. **Unsupported features fall back to software with a clear log line**, never
   silently wrong output.

## Consequences

**Positive**

- Deferring the choice costs nothing today: nothing before Phase 6 needs it, and
  the software baseline (D) is needed anyway.
- A published gap matrix sets user expectations honestly instead of promising
  "GPU acceleration" that means different things per app.
- Shader translation (GLSL/SPIR-V → WGSL via Naga/Tint-class tooling) is shared
  infrastructure across A, B and C, so it can be built once Spike D picks a
  command protocol.

**Negative / risks**

- **We might own a Mesa driver** (path C). That is a multi-year maintenance
  commitment in a codebase with high churn, and it needs the signed apt repo
  from ADR-0006 to reach the guest.
- **WebGPU availability is not universal** and its limits differ per adapter, so
  any path needs a capability negotiation step and a software fallback at
  runtime, not just at build time.
- **Latency**: serialised GPU commands across a worker boundary add frames. The
  input→photon KPI (≤2 frames) may be unreachable for accelerated 3D regardless
  of path; Spike D should measure it as a first-class number.
- Video decode/encode via WebCodecs (virtio-video) is a separate pipeline that
  shares none of this and must not be conflated with it.

## What Spike D must produce

- Conformance table per path: `glxinfo`, `vulkaninfo`, `vkcube`, `glmark2`,
  dEQP subset pass rates.
- Frame-time and input→photon latency per path at 1080p, versus path D.
- The feature-gap matrix (WebGPU ⊂ Vulkan) with the emulation cost per gap.
- A recommendation, or an explicit "none of A/B/C is worth it; ship D and
  revisit" — which is a legitimate outcome and the reason this ADR is Proposed.
