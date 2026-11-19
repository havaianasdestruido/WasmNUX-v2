# ADR-0002: Execution strategy — tiered interpreter + region JIT

- **Status:** Accepted (Phase 0), on measured evidence
- **Related:** ADR-0001, ADR-0003, ADR-0004, ADR-0013
- **Evidence:** [`docs/spikes/spike-a-jit.md`](../spikes/spike-a-jit.md)

## Context

The emulator core has to run a Linux kernel and userland at usable speed inside
a browser tab. ROADMAP §4 sets the KPIs: ≥3× (stretch 5×) the best existing
in-browser emulator, ≥50% of QEMU-TCG on the same host, <2 s to first shell
prompt.

The options are a pure interpreter, a single-tier JIT, or tiered execution.
Phase 0 exists precisely to turn this from an opinion into a measurement.

## Decision

**Three tiers, with the interpreter as a permanent first-class tier rather than
a bootstrap fallback.**

1. **Tier 0 — interpreter** (`core/src/cpu/interp.ts`). One instruction per
   step, 1 IPC cycle model, owns all side effects (MMIO, syscalls, CSR, `wfi`).
   It is the correctness oracle: every JIT claim in CI is checked against it.
2. **Tier 1 — baseline region JIT** (`core/src/jit/{cfg,codegen,engine}.ts`).
   Heat is accrued on control-transfer targets; a hot pc triggers CFG recovery
   and translation of a _region_ (ADR-0003) into one Wasm module, compiled and
   instantiated synchronously, then entered.
3. **Tier 2 — optimising re-translation.** After `optimizeThreshold` (4096)
   retired instructions in a region, it is re-translated with constant folding
   and branch folding enabled.

Plus two demotion paths, both learned the hard way in Spike A:

- **Slow-pc learning.** A pc that faults `MAX_TRAPS_PER_PC` (3) times is
  recorded; the region is retired and the next translation splits its block
  _before_ that pc so the interpreter single-steps it. This is what makes MMIO
  polling loops safe.
- **Tier-down.** A region that retires fewer than 32 instructions per host exit
  is retired and its blocks declined permanently. One host exit costs ≈1 µs
  (a register-file sync), i.e. ≈40 interpreted instructions, so a region that
  exits every few instructions is _slower_ than interpreting.

## Why not the alternatives

**Pure interpreter.** Measured at 45–68 MIPS. The published in-browser
comparator (`8086emu` 1.5.1, Rust compiled to Wasm) runs the same bytes at
142–165 MIPS. A TypeScript interpreter is **0.4×** of it — it misses the KPI by
more than an order of magnitude and there is no amount of tuning that closes
that gap, because the gap is `switch`-dispatch overhead.

**Single-tier JIT (compile everything, immediately).** Two measured problems:

- Translation costs ≈500 ns per guest instruction, while V8 compiling the
  resulting module costs ≈3–11 ns per instruction (§3.2). So the translator, not
  Wasm compilation, is the warm-up cost, and compiling cold code is pure loss.
- Compiling everything is also _wrong_ for device-heavy code: the UART polling
  loop measured **0.52× the interpreter** compiled, because every poll exits to
  the host. Tier-down exists to undo that decision, and heat thresholds exist to
  avoid making it.

**Optimising JIT from the start (no baseline tier).** The `+opt` pass measured
+1.7% / −10% / +0.1% across three workloads — within noise (§4.6). Paying a
second translation for no measured gain on cold code is why the optimising pass
is deferred behind a high retire threshold instead of being the default.

## Consequences

**Positive**

- 23–65× over the interpreter on seven of eight workload shapes; 6.8–14.8× over
  the comparator. The KPI is met by the JIT and missed without it.
- The interpreter stays authoritative, so a JIT bug is a performance bug, not a
  correctness bug: any region can be declined and the system keeps running.
- Warm-up is bounded and predictable: `hotThreshold` 32 control transfers,
  regions of ≤24 blocks / ≤512 instructions, `maxRegions` 512.

**Negative / obligations**

- **Three ways to execute the same instruction means three ways to be wrong.**
  Retire accounting has to live in exactly one place, and the differential tests
  have to assert it (`jitInstructions + interpInstructions == interpreter's
minstret`). Spike A found three separate retire-accounting defects; this is
  the standing cost of tiering.
- **State synchronisation is the expensive, bug-prone seam.** When the JIT hands
  back to the host, `cpu` is authoritative and pushing the register file back
  would re-execute an instruction — which is how a UART byte got read twice.
  Every exit path in `engine.ts` carries that hazard.
- **Invalidation must be complete and cheap.** `fence.i` and interrupts flush
  the code cache; stale cache records after a region is retired caused an
  infinite recompile-trap loop.
- **The thresholds are host-dependent constants.** `TIER_DOWN_INSNS_PER_EXIT=32`
  is derived from a measured ≈1 µs sync cost on one box and should be calibrated
  at startup. It is also register-file dependent: with `regalloc:'memory'` there
  is almost no sync, so the correct threshold differs per configuration.
- Code cache pressure and memory growth need a policy (LRU over `maxRegions`)
  that does not exist yet.

## Follow-ups

- Calibrate tier-down thresholds from a measured sync cost instead of a constant.
- Return-address inline cache for `jalr`/`ret` — `calls` reaches only 6.8× and
  is exit-bound (149 980 host exits for ~2 M instructions).
- Persistent code cache (Phase 3) so warm starts skip translation entirely.
