# Spike A — JIT feasibility (RV64 → WebAssembly)

**Deliverable:** `spikes/spike-a-jit/` · **Results:** `benchmarks/results/spike-a-jit-draft.json`

## What was built

- `src/assembler.ts` — RV64 assembler (lui/addi/slt/ld/sd/branch/mul…)
- `src/interpreter.ts` — RV64IM interpreter (differential-testing oracle)
- `src/jit.ts` — block→Wasm translator (binaryen), `compileToWasm` + `instantiateRegion`
- `src/kernels.ts` — `sum_squares`, `xorshift64`, `memcpy64`
- 7/7 tests (`npm test`)

## Measured (2× Xeon @ 2.60 GHz, Node 22.22.3)

| Kernel | Interpreter | JIT effective | Speedup | Wasm bytes |
|---|---|---|---|---|
| sum_squares | 10.2 MIPS | 6,969 MIPS | 681× | 131–293 |
| xorshift64 | 7.8 MIPS | 6,160 MIPS | 789× | 168–339 |
| memcpy64 | — | — | 1,190× | — |

Emit ~1–34 ms per region; uncached instantiate ~0.9–108 ms (warm path ~1 ms).

## Go / No-Go

**GO** (ADR-0002). Watch items: div-by-zero/`INT64_MIN÷-1` trap semantics vs
RV defined results; `lr/sc` dead-peer livelock (needs timeout). Both are
Phase 1 fixes, not design flaws.

Baseline for "best in-browser emulator" comparisons (ADR-0002, ADR-0003):
v86_64 ≈ 530 MIPS (x86-64 v86 fork).
