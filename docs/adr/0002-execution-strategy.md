# ADR-0002: Execution Strategy

- **Status:** Accepted
- **Date:** 2026-11-19

## Decision
Use a **tiered execution engine**:
1. **Tier 0:** Correctness-first RV64GC interpreter.
2. **Tier 1:** Baseline block JIT (fast compilation, direct Wasm emission).
3. **Tier 2:** Optimizing region JIT (superblocks, loop optimizations).

## Rationale
Pure interpretation is too slow (~63 MIPS in Spike A), while a single-tier optimizing JIT incurs unacceptable warm-up latency. Tiering gives instant boot + high steady-state throughput.
