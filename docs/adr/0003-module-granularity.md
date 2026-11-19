# ADR-0003: Wasm module granularity — region-per-module with `br_table` dispatch

- **Status:** Accepted (Phase 0 baseline ships block-per-module; region
  dispatch is the Phase 1 increment)
- **Date:** 2026-11

## Context

Every `WebAssembly.compile` + `instantiate` has fixed cost. Emitting one
module per *basic block* multiplies instantiation overhead on control-heavy
code; emitting one giant module per *region* delays compilation and
invalidates wholesale. The granularity decision shapes the whole JIT
(`spike A` measured the extremes).

## Decision

1. **Steady state (target):** one Wasm module per **region** — a trace or
   superblock — with an in-function `br_table` dispatch on the block-index
   entry, so entering any block in the region is one call and no
   instantiation happens per block.
2. **Phase 0 baseline (shipped):** one module per block, `() -> i32`
   next-PC signature. Rationale: simplest possible correctness story for the
   spike (each module independently fuzzable), and instantiation is amortised
   by the 1024-block LRU — measured cost lives in `engine.stats.instantiateNs`.
3. Migration path is additive: region builder consumes the same block
   compiler; `br_table` dispatch replaces the per-block exported entry.

## Evidence (Phase 0)

- Baseline: 400 k-step loop, `compiles=2` for the hot loop — LRU keeps
  instantiation off the steady-state path (23 ms JIT run, row `a2`).
- `instantiateNs`/`compileNs` counters exist in `engine.stats` for the
  region-granularity A/B in Phase 1.

## Consequences

- Snapshot/restore never persists compiled modules (Phase 0 choice) — warm
  starts use the future persistent code cache (roadmap Phase 1), keyed by
  image hash.
- Region formation must keep the slow-path exit contract: any block can
  leave the module via the interpreter without invalidating neighbours.
