# ADR-0007: GPU acceleration — in-browser WebGPU paths; llvmpipe-class SIMD fallback first, WebGPU-shaped virtio-gpu second

## Status

accepted

## Date

2026-11-19

## Context

Guest GUI apps want GL/Vulkan. The host browser exposes WebGPU (subset of
Vulkan) and WebGL. Four paths were compared (per ROADMAP and the spike D
plan), plus the real-world state of GPU virtualization in 2025:

**Path A — virgl-style GL command serialization** (virtio-gpu + VirGL over
the wire): most software (existing guest GL drivers), single host thread,
slowest of the hardware-accelerated paths upstream; VirGL 4.3 is the ceiling
without blob resources. In a browser there is no virglrenderer to run; this
path means shipping/emulating VirGL inside Wasm and re-targeting its output to
WebGL/WebGPU. High effort, questionable payoff.

**Path B — Venus (Vulkan serialization)**: the 2025 state of the art on real
hypervisors (Collabora, Jan 2025): Venus is stable since May 2023, near-native
performance, Vulkan 1.3+ end-to-end (Mesa 25.1 advertises 1.4). **Requires
blob resources and a host Vulkan driver** — Chromium browsers expose no raw
host Vulkan, so Venus cannot run inside a browser tab. It *is* the right
answer for a future IWA/native host backend, and WasmNUX should not paint
itself into a corner against it.

**Path C — custom virtio-gpu context carrying WebGPU-shaped command streams**:
a WasmNUX-specific Mesa driver (lavapipe-class) emitting WebGPU-shaped encoder
commands to the display worker. No impedance-matching layer, designed for the
exact subset WebGPU supports; but it is new surface we own (no upstream Mesa
code today), and WebGPU has no GL→translation story — apps need Vulkan-ish
or the guest software path.

**Path D — lavapipe/llvmpipe with Wasm SIMD + threads as the fallback**:
software rendering everywhere, no host GPU dependency; slow for 3D, correct
for 2D and trivial-3D compositors (i3/openbox/sway 2D). Spike D shows the
CPU-side blit path running ~14.8–14.9 GB/s with Wasm SIMD (parity with
`typedArray.set`), manual JS at ~1.36 GB/s — software rendering is *usable*
for a terminal and 2D shell at 1080p (blit ~1,800 fps-equivalent for full
1080p frames on this host).

WebGPU availability (Dec 2025): Chrome/Edge 113+ desktop, Chrome Android
121+, Firefox 141 Windows / 145 macOS ARM, Safari 17.4+/26 — Linux Chrome and
Linux Firefox still do **not** ship WebGPU; mobile support is patchy. A
WebGPU-only design excludes Linux desktop users. **A CPU path is mandatory,
not optional.**

## Decision

Ship **two** GPU paths, in this order:

1. **(D) Wasm-SIMD software path is the correctness floor** — always present,
   always tested, used whenever WebGPU is absent, disabled, or loses context.
   Terminal (ADR-0009) and 2D desktop compositing must be fluid on (D) alone.
2. **(C) WebGPU-shaped virtio-gpu context** is the acceleration path: guest
   Mesa "wnxvk" driver → display worker → WebGPU encoder. Scoped initially to
   what WebGPU actually supports (compute, render pipelines, no geometry
   shaders, bind-group limits), with explicit capability advertisement so
   guest Mesa fails gracefully to (D) for unsupported features.
3. **(B) Venus** is explicitly deferred, not rejected: noted in this ADR as
   the upgrade path for Isolated Web App / native hosts where a host Vulkan
   exists. Do not build WebGPU-subset emulation of Vulkan for its own sake.
4. **(A) virgl-style GL** is rejected for browsers: emulation cost + host
   WebGL ceiling + no path to compute; revisit only if a guest GL app we must
   support cannot use (C).

## Consequences

- Phase 5/6 deliver GUI on (D) first; (C) lands incrementally behind a flag,
  then becomes default where WebGPU is present.
- Conformance gate: dEQP/Vulkan subset runs on (D) on every release; (C) must
  match (D) render-output hashes for the conformance subset before default-on.
- Linux desktop without WebGPU still gets a full-featured 2D system — a real
  differentiator vs GPU-gated browser VMs.
- The guest mesa "wnxvk" driver is new code We own; budget for it in Phase 6
  and keep it small (WebGPU's feature set *is* its feature set).
