# ADR-0002: Execution strategy — tiered interpreter → baseline block JIT → region JIT

- **Status:** Accepted (Phase 0 delivered tier 0 + tier 1; tier 2 is Phase 1+)
- **Date:** 2026-11

## Context

Single-thread throughput must reach ≥ 50 % of QEMU-TCG and ≥ 3× the best
existing in-browser emulator (ROADMAP §4 CPU KPIs). A pure interpreter is too
slow; a single-tier JIT has poor warm-up and a long tail of ops that cannot
be lowered directly.

## Decision

**Three tiers, one correctness oracle:**

1. **Tier 0 — interpreter** (`packages/core/src/cpu`): BigInt-backed RV64
   implementation of the full implemented ISA, including div/rem, AMO/LR-SC,
   CSR, traps, and ecall. Always able to execute any instruction; serves as
   the differential oracle for all JIT tiers.
2. **Tier 1 — baseline block JIT** (`packages/core/src/jit`, spike A):
   straight-line blocks of RV64I ALU/branch/load/store/mul/fence → one Wasm
   module per block returning the next PC; slow ops exit to the interpreter.
   LRU cache (1024), flush on `satp`/privilege change.
3. **Tier 2 — optimizing region JIT** (Phase 1+, per roadmap): superblocks,
   constant propagation, register-to-Wasm-local allocation, dead-flag
   elimination, inline TLB probes on the fast memory path.

## Evidence (Phase 0)

- Functional: `jit.test.ts` 10/10 (differential fuzz incl. 150-insn random
  programs — 0 divergences; cache, flush, trap-equivalence covered).
- Performance (Node, 400 k-step loop): interpreter **3.3 M steps/s**,
  baseline JIT **21.4 M steps/s** — **6.43×** speedup (rows `a1`–`a3`),
  clearing the ≥2× GO threshold and ≥5× stretch target. Decision: **GO**.

## Consequences

- Tier 1 is on by default for compilable blocks; the interpreter executes
  everything else — correctness never depends on JIT coverage.
- Phase 1 targets the in-browser baseline KPI (≥3× vs existing emulator) and
  adds tier 2 only if the 60 fps envelope needs more headroom.
- Compile-time instrumentation (compiles, fast/slow steps, cache hits) is
  already plumbed (`engine.stats`) for CI regression gates.
