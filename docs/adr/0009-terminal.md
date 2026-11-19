# ADR-0009: Terminal — custom WebGPU renderer (Canvas2D/WebGL fallback)

- **Status:** Accepted (Phase 0 substrate; renderer lands Phase 2)
- **Date:** 2026-11

## Context

The terminal is the product's front door: keystroke→pixel ≤ 1 frame, `cat`
of a large file must saturate the display without blocking the vCPU, and
Unicode (wide chars, combining marks, ligatures, IME) must be correct.
xterm.js is allowed only as bootstrap — DOM/Canvas performance ceilings are
known.

## Decision

1. **Custom renderer:** a cell buffer + glyph-atlas renderer targeting
   **WebGPU** (glyph atlas as a texture, quads per run), with **Canvas2D**
   fallback and capability detection choosing the backend
   (`pickScanoutBackend` in spike D).
2. **Glyph atlas:** packed grid cache with LRU eviction
   (`GlyphAtlas`, spike F) — no per-frame rasterisation of unchanged glyphs.
3. **Damage tracking:** row-bitset dirty tracking + byte-diff present
   (`DamageTracker`/`presentFrame`) so a keystroke copies only changed rows.
4. **Unicode:** wcwidth-class width tables (base + combining = one cluster),
   wide chars occupy two cells with a continuation marker; ligatures opt-in
   (`DEFAULT_LIGATURES`, longest-match scan); **IME**: composition text is
   rendered locally and only committed text reaches the guest
   (`ImeSession`).
5. xterm.js remains only for the bootstrap/debug console.

## Evidence (Phase 0)

- `terminal.test.ts` — 18 tests (widths, clusters, ligatures, atlas
  allocation/LRU invariants, cell-buffer wide/wrap semantics, IME lifecycle).
- `display.test.ts` — damage/present correctness + throughput smoke
  (1080p full present ≈ 0.8–1.2 ms, rows `d1`/`d2`).
- Browser IME keystroke→pixel row `f4` reserved for the interactive harness.

## Consequences

- Renderer must never touch the main thread's vCPU budget: display worker
  owns the canvas (scanout path shared with ADR-0007 zero-copy targets).
- Atlas sizing (cell × grid) is a Phase 2 tuning knob against real font
  coverage; ligature scanning is O(row × rules) — acceptable at 187 k rows/s
  (row `f2`).
