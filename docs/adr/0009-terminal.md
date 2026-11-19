# ADR-0009: Terminal — custom WebGPU glyph-atlas renderer; xterm.js bootstrap only

## Status

accepted

## Date

2026-11-19

## Context

The terminal *is* the product UI. Requirements: fullscreen, GPU-accelerated
scrollback, ligatures, wide chars (CJK), emoji/ZWJ clusters, IME input, and
sub-frame keystroke→pixel latency. Candidates:

1. **xterm.js** — battle-tested (VS Code, Hyper), DOM/Canvas renderers with a
   hard throughput ceiling and no WebGPU path; Ligatures via addon are limited
   to font features, not programmable control of the atlas. Great for Phase 1
   bring-up, wrong long-term answer.
2. **Custom renderer: WebGPU glyph atlas** — Rust→Wasm (or TS) computes grid
   cells; a GPU texture atlas holds cached glyph bitmaps; one instanced draw
   call per frame; damage tracking limits redraw to dirty rows; ligature
   substitution at tokenize time; `Intl.Segmenter` for graphemes.
3. **Canvas2D** — simple, correct, slow at 1080p fullscreen with ligatures.

Spike F measured (`benchmarks/results/spike-f-terminal-draft.json`;
CPU-side model, GPU leg deferred to spike D/WebGPU probe):

- Ingest `cat` of 20k lines (~2 MB): ligature-aware tokenise ~1.71M cells/s
  (~12.8k lines/s); plain ASCII path ~7.54M cells/s
- Glyph atlas hit rate: **99.99%** (hot set ≈ 95 printable glyphs + wide
  forms + ligature glyphs); LRU eviction validated by unit tests
- Full-frame CPU redraw equivalent: ~167 fps @1280×768, ~659 MB/s of glyph
  writes; 2-row damage redraw: **~9,300 frames/s** — far beyond any display
- Scrollback ring: ~5.8M line pushes/s; damage tracker union logic validated
- Wide chars/ZWJ/combining-mark width rules implemented and tested (8/8
  tests: e+◌́ = 1 cell, CJK = 2, 👨‍👩‍👧 = 2 cells, ⚠️, skin tones)

WebGPU scanout cost for the 1080p canvas is measured separately
(spike D + `web/probe/webgpu-scanout.html`); the glyph atlas does not depend
on a GPU being present — it degrades to Canvas2D blitting the same atlas
bitmap.

## Decision

- **Terminal = custom WebGPU glyph-atlas renderer**, designed from the spike
  F building blocks: `text.ts` (graphemes/width/ligatures), `atlas.ts`
  (grid packing + LRU), `scrollback.ts` (ring), `damage.ts` (dirty-union).
- **xterm.js is permitted only as a Phase 1 bootstrap** (first paint before
  the real renderer works) and must be behind a feature flag with a removal
  gate before Phase 2 exit.
- Canvas2D fallback for WebGPU-absent hosts (Linux as of Dec 2025 — see
  ADR-0007); both paths share the atlas and damage code.
- Input latency budget: ≤ 1 frame keystroke→pixel on Tier-1 hosts; no
  main-thread work on the hot path (ADR principle §1).
- IME: handled in the textarea-composition overlay → confirmed cluster sent
  to guest as cooked input; uncommitted composition is painted by the host
  overlay, never by the guest protocol.

## Consequences

- We own a renderer (fine — that *is* the product) and its test burden:
  glyph atlas, width tables, ligature table need conformance tests per
  release; Unicode data refreshes are routine maintenance.
- IME correctness depends on composition events, not raw keys — the input
  layer is its own small project; don't skimp in Phase 2.
- The 99.99% atlas hit rate justifies the simple grid-LRU design now; a
  fancy shelf packer can come later without changing interfaces.
- xterm.js must not acquire load-bearing features; anything added to the
  bootstrap must be re-done on the real renderer.
