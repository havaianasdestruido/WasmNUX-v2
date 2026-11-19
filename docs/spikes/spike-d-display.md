# Spike D — Display + GPU: WebGPU scanout cost; software blit floor

**Deliverable:** `spikes/spike-d-display/` + `web/probe/webgpu-scanout.html` · **Results:** `benchmarks/results/spike-d-display-draft.json`

## What was built

- `src/blit.ts` — binaryen-built Wasm SIMD blit (verified bit-identical output)
- `src/pacing.ts` — frame pacing / vsync drift model
- `src/webgpu-probe.ts` — adapter/limits detection (Node-safe)
- `test/…` — 7/7 tests (incl. SIMD correctness vs scalar reference)
- Browser probe page for real `writeTexture` 1080p upload MB/s

## Measured (Node proxy, 1920×1080 RGBA, 30 reps)

| Path | MB/s | 1080p fps-equivalent |
|---|---|---|
| `typedArray.set` | 14,944 | 1,802 |
| Wasm SIMD blit | 14,799 | 1,784 |
| manual JS loop | 1,357 | ~163 |

SIMD is mandatory; typedArray≈SIMD → the blit abstraction can stay swappable.

## GPU paths (ADR-0007)

| Path | Verdict |
|---|---|
| A virgl-style GL over WebGL | rejected (single-thread ceiling, no compute) |
| B Venus/Vulkan | deferred — needs host Vulkan; IWA/native hosts only |
| **C WebGPU-shaped virtio-gpu context** | **acceleration path** (Mesa wnxvk → WebGPU encoder) |
| **D Wasm-SIMD llvmpipe-class fallback** | **correctness floor — always present** |

Browser notes (Dec 2025): WebGPU ships in desktop Chrome/Edge 113+, Firefox
141 (Windows) / 145 (macOS ARM), Safari 17.4+/26; **Linux Chrome/Firefox do
not ship it yet** — D is what keeps Linux useful.
