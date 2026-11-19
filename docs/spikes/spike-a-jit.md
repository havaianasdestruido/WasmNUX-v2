# Spike A — JIT feasibility (RV64 → WebAssembly)

**Deliverable:** `spikes/spike-a-jit/` · **Results:** `benchmarks/results/spike-a-jit-draft.json`

## What was built

- `src/assembler.ts` — RV64 assembler (lui/addi/slt/ld/sd/branch/mul…)
- `src/interpreter.ts` — RV64IM interpreter (differential-testing oracle)
- `src/jit.ts` — block→Wasm translator (binaryen), `compileToWasm` + `instantiateRegion`
- `src/kernels.ts` — `sum_squares`, `xorshift64`, `memcpy64`
- 7/7 tests (`npm test`)

## Measured (2× Xeon @ 2.60 GHz, Node 22.22.3)

Two measurement runs on the same host (binaryen -O2):

| Kernel | 2026-11-19 run 1 | 2026-11-19 run 2 (committed JSON) |
|---|---|---|
| sum_squares | 6,969 MIPS, 681× | 4,464 MIPS, 751× |
| xorshift64 | 6,160 MIPS, 789× | 4,412 MIPS, 986× |
| memcpy64 | 1,190× | 1,135× |

Host variance roughly halves effective-MIPS figures between runs; both runs
sit ≥ ~440× the interpreter (~5–10 MIPS). Wasm regions 146–377 bytes.
Emit ~1–44 ms per region; uncached instantiate ~1–108 ms (warm path ~1 ms).

Post-review hardening: RV64M div/rem now lower to Wasm with explicit handlers
for divisor-zero (quotient −1 / `2^64−1`, remainder = dividend) and
`INT64_MIN ÷ −1` (quotient `INT64_MIN`, remainder 0) — matching the RV64
spec exactly, verified by JIT↔interpreter differential tests. Effective
addresses with nonzero bits above bit 31 now trap instead of silently
wrapping into low RAM. Branch/JAL immediates and `lui`/`auipc` are
range-checked at assemble time instead of being encoded with silent wrap.

## Go / No-Go

**GO** (ADR-0002). Remaining watch items: `lr/sc` dead-peer livelock (needs
timeout); interpreter/JIT disagreement classes beyond M-extension are covered
by the differential fuzzer planned in Phase 1.

Baseline for "best in-browser emulator" comparisons (ADR-0002, ADR-0003):
v86_64 ≈ 530 MIPS (x86-64 v86 fork).
