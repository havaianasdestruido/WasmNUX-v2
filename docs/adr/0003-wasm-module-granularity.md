# ADR-0003: Wasm Module Granularity

- **Status:** Accepted
- **Date:** 2026-11-19

## Decision
Compile **region-per-module** with in-function `br_table` dispatch.

## Rationale
Instantiating one `WebAssembly.Module` per basic block is dominated by V8/SpiderMonkey instantiation overhead. Grouping hot regions into a single module amortizes instantiation cost and enables structured Wasm `loop` / `br_table` dispatch.
