# ADR-0009: Terminal

- **Status:** Accepted
- **Date:** 2026-11-19

## Decision
Build a **custom WebGPU glyph-atlas terminal renderer** (with Canvas2D/WebGL fallback); use `xterm.js` only as a temporary Phase 1 bootstrap.

## Rationale
Spike F demonstrated **39.8 MB/s** cell-grid throughput with row-level damage tracking, wide-char/emoji support, and an LRU glyph atlas.
