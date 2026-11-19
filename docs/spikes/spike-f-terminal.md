# Spike F — Terminal: WebGPU glyph atlas (CPU-side model)

**Deliverable:** `spikes/spike-f-terminal/` · **Results:** `benchmarks/results/spike-f-terminal-draft.json`

## What was built

- `src/text.ts` — grapheme segmentation (`Intl.Segmenter`), wcwidth-style cell
  rules (ASCII=1, combining=0, CJK/emoji=2, regional-indicator flags=2,
  keycap sequences=2, VS16 emoji-presentation sequences=2, ZWJ clusters=2),
  coding-ligature tokeniser (longest-match regex: `===`, `->`, `<!--`, …)
- `src/atlas.ts` — grid-slotted glyph atlas with LRU eviction + stats
- `src/scrollback.ts` — fixed-capacity ring (monotonic `totalPushed`)
- `src/damage.ts` — dirty-rect union tracking (2-line scroll = 4.2% of grid)
- 8/8 tests

## Measured (quick mode, 20k-line corpus; this host)

| Metric | Value |
|---|---|
Post-review fix: the ligature pass counted cells for ligatures as 2 and
looked the full-token key up `text.length + 1` times per token (inflating the
atlas hit rate and cells/s). It now does one lookup per token and counts
`tokenWidth()` cells (`===` = 3), so the numbers below are the honest ones —
and materially lower.

| Metric | 2026-11-19 run 1 | 2026-11-19 run 2 (committed JSON) |
|---|---|---|
| Ligature ingest | 1.71M cells/s (inflated) | ~0.73–0.90M cells/s (~5.4–6.7k lines/s) |
| Plain ingest | 7.54M cells/s | ~3.0–3.8M cells/s (~23–28k lines/s) |
| Atlas hit rate | 99.99% | 99.99% |
| Full-frame CPU redraw | ~167 fps | ~104–177 fps @1280×768 |
| Damage redraw (2-line scroll) | ~9,300 fps | ~5,800–6,700 fps |
| Scrollback push | ~5.85M lines/s | ~3.1–4.9M lines/s |

GPU leg: see spike D for scanout cost (typedArray.set ≈ SIMD ≈ 14.8 GB/s) and
`web/probe/webgpu-scanout.html` for the in-browser `writeTexture` path.
Canvas2D fallback remains mandatory (no WebGPU on Linux yet — ADR-0007).

## Decision anchor

ADR-0009 (custom WebGPU renderer; xterm.js bootstrap only).
