# ADR-0002: Execution strategy — tiered interpreter → baseline block JIT → region JIT

## Status

accepted

## Date

2026-11-19

## Context

Exit criteria for Phase 0 require an **explicit go/no-go on the JIT design**.
This ADR records both the decision and the evidence.

The options were:

1. Pure interpreter — measured ~7–10 MIPS on spike A kernels. Too slow for a
   daily-driver VM.
2. Single-tier JIT (compile every block once) — slow warm-up, still pays
   optimization cost on cold code.
3. Tiered: interpreter → baseline block JIT → optimizing region JIT.

Prior art:
- **v86_64** (x86-64 fork of v86): 64-bit JIT ~530 MIPS vs ~80 interpreted;
  boots Debian/Ubuntu ISOs (~150 MIPS average). Winner by a factor ~6× on
  hot code.
- WebVM author's public comment: ~6× slowdown on small code, up to ~50× on
  GCC vs native — i.e., even a good JIT trails native by a wide margin;
  expectations must be calibrated accordingly.
- qemu-wasm is substantially slower (no cross-module block chaining).

WasmNUX spike A measurements (2× Xeon @ 2.60 GHz, Node 22.22.3,
`benchmarks/results/spike-a-jit-draft.json`):

| Kernel | Interpreter | JIT (binaryen, -O2) | Speedup |
|---|---|---|---|
| memcpy64 | — | — | 1,135× |
| xorshift64 | — | — | 986× |
| aggregate    | ~5–10 MIPS | ~4,400–7,000 effective MIPS | ~750–1200× |

(Two measurement runs on the same host; effective-MIPS halved between them
under host contention — the ratio vs the interpreter is the honest figure.)
Generated Wasm is tiny (131–377 bytes per region), instantiation dominates
cold-start cost — which is what ADR-0003 (region granularity + br_table
dispatch) exists to amortize.

RV64M semantics are implemented exactly as the spec defines (divisor-zero and
INT64_MIN÷−1 handled explicitly — verified by JIT↔interpreter differential
tests). Remaining known divergences accepted (spike-documented):
- Guest `lr/sc` loops under a dead peer can spin; needs a timeout + fault
  path (the reservation itself is now ABA-proof via a per-granule epoch
  companion buffer — see spike B).
- Assembler immediate range is ±2048 for `li` — assembler limitation, not ABI.
- Effective addresses with nonzero bits above bit 31 trap instead of
  wrapping (stricter than the interpreter, which raises RangeError — same
  outcome class).

## Decision

**GO.** The JIT-to-Wasm design is viable and is the execution strategy:

- Tier 0: interpreter (always available; correctness oracle for differential
  testing).
- Tier 1: baseline block JIT — straight-line translation, no optimization,
  compile on first execution of a hot block.
- Tier 2: region JIT — superblock formation, loop optimizations, binaryen
  `-O2`-class passes, persistent code cache on disk.

No-go triggers that would flip this decision (watch in Phases 1–3):
- Module instantiation cost per region cannot be driven below ~1 ms with
  caching (ADR-0003 mitigations fail).
- Sustained hot-loop throughput below ~25% of QEMU-TCG on the same host.
- Warm-up time to usable prompt exceeds snapshot/restore budget (Phase 3).

## Consequences

- Interpreter must remain a permanent, maintained component (fallback + fuzz
  oracle). No interpreter deletion "because the JIT works".
- Every JIT bug is a two-implementation bug — differential fuzzing against
  the interpreter is mandatory CI (Phase 1 onward).
- Performance targets in ROADMAP §4 (≥ 3× best in-browser emulator; ≥ 50% of
  QEMU-TCG) are considered achievable but unproven in-browser until Phase 3;
  they remain CI gates once the guest exists.
- ADR-0004 (shared memory / Memory64) and ADR-0003 (region granularity)
  are prerequisites, not options.
