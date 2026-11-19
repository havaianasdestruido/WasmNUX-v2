# ADR-0003: Wasm module granularity — region-per-module with br_table dispatch

## Status

accepted

## Date

2026-11-19

## Context

The JIT emits WebAssembly for guest code regions. The unit of compilation
controls instantiation cost, branch handling, and code-cache layout.

Options:

1. **One module per basic block** — minimal recompile scope, but
   `WebAssembly.Module` instantiation overhead (µs–ms each) dominates; a hot
   loop crossing blocks pays per block. Rejected by measurement: spike A
   emitted 131–168-byte regions and instantiation, not execution, was the
   cold cost.
2. **One module for the whole guest image** — one instantiation, but any
   recompile invalidates everything; compile latency on first execution of
   any code; code cache keyed on global image hash — useless after apt
   upgrades. Rejected.
3. **Region-per-module** — compile natural regions (trace/superblock up to
   N instructions), each a module; in-function `br_table` jumps between
   compiled blocks of the same region; cross-region edges go through a
   trampoline table with side-exit stubs.

Browser reality: `WebAssembly.instantiate` of a tiny module is on the order
of tens of microseconds with cached compilation (structured clone +
low-level compile), and ~1 ms for cold modules. With region caching, amortized
cost per executed region approaches zero.

## Decision

Region-per-module:

- A **region** is a superblock: leader (backward branch target or fall-through
  after a side exit) followed by an optimized trace, capped at ~512 guest
  instructions or at any potentially-trapping/serializing instruction.
- Each region compiles to one Wasm module exporting `run(statePtr) -> nextState`.
- **In-function `br_table` dispatch** for block-to-block transfers inside the
  region (no `call_indirect` boundary per block).
- Cross-region transfers use a side table of region handles; missing entries
  trigger the baseline tier or interpreter and enqueue recompilation.
- Regions are keyed by `(pc, flags fingerprint)` and persisted in the JIT
  cache (Phase 3) — content-addressed so apt updates only recompile changed
  code.

## Consequences

- Trampoline/side-exit stubs are required machinery; budget them in the
  runtime from day one (they are how a region safely escapes to the
  interpreter on unexpected state).
- `br_table` arms are static per region; deep switch lowering is a binaryen
  job, not hand-rolled.
- The interpreter must be callable from any side exit at any region boundary.
- Crash isolation granularity is a region: waivers of one module can't corrupt
  others (Wasm type safety) but shared linear memory always can — see ADR-0004.
