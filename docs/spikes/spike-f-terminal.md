# Spike F — Terminal: WebGPU glyph atlas (CPU-side model)

**Deliverable:** `spikes/spike-f-terminal/` · **Results:** `benchmarks/results/spike-f-terminal-draft.json`

## What was built

- `src/text.ts` — grapheme segmentation (`Intl.Segmenter`), wcwidth-style cell
  rules (ASCII=1, combining=0, CJK/emoji=2, ZWJ clusters), coding-ligature
  tokeniser (longest-match regex: `===`, `->`, `<!--`, …)
- `src/atlas.ts` — grid-slotted glyph atlas with LRU eviction + stats
- `src/scrollback.ts` — fixed-capacity ring (monotonic `totalPushed`)
- `src/damage.ts` — dirty-rect union tracking (2-line scroll = 4.2% of grid)
- 8/8 tests

## Measured (quick mode, 20k-line corpus; this host)

| Metric | Value |
|---|---|
| Ligature ingest | 1.71M cells/s (~12.8k lines/s) |
| Plain ingest | 7.54M cells/s (~55.9k lines/s) |
| Atlas hit rate | 99.99% |
| Full-frame CPU redraw | ~167 fps @1280×768 (659 MB/s glyph writes) |
| Damage redraw (2-line scroll) | ~9,300 fps |
| Scrollback push | ~5.85M lines/s |

GPU leg: see spike D for scanout cost (typedArray.set ≈ SIMD ≈ 14.8 GB/s) and
`web/probe/webgpu-scanout.html` for the in-browser `writeTexture` path.
Canvas2D fallback remains mandatory (no WebGPU on Linux yet — ADR-0007).

## Decision anchor

ADR-0009 (custom WebGPU renderer; xterm.js bootstrap only).
