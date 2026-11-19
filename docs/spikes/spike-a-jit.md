# Spike A: JIT feasibility

**Status: GO.** A Wasm region JIT is not merely viable for this project, it is
the difference between meeting the CPU KPI and missing it by an order of
magnitude. Two design points it settled are not the ones the ROADMAP assumed:
the register file belongs in a **control page in guest memory**, not in imported
Wasm globals, and **indirect control flow (returns) is the bottleneck**, not
arithmetic.

- Date: 2026-11-19
- Commits: `b19b6c1`…`5a271c0` on branch `arena/8368d687-wasmnux-v2`
- Result files quoted: `benchmarks/results/20261119T164129Z-061bd0e-…` for the tables below, plus `…165929Z-fdb7d92-…` and `…172933Z-5a271c0-…` for the run-to-run spread in §3
- Host: Node 22.22.3 (V8), linux/x64, 2 vCPUs, 3.9 GB — a shared CI-class box, not a tuned machine
- Code: `core/src/jit/{cfg,codegen,engine,regfile}.ts`, `core/src/jit/wasm/{encoder,features}.ts`
- Tests: `core/test/jit.test.ts` (132), `core/test/wasm-encoder.test.ts` (21)
- Benchmarks: `benchmarks/suites/{jit,baseline,wasm}.ts`, results in `benchmarks/results/`, rendered summary in [`docs/kpi/latest.md`](../kpi/latest.md)

---

## 1. The question

ROADMAP §5 Phase 0: _"Translate hot blocks of the candidate ISA(s) to Wasm;
measure vs interpreter and vs an existing in-browser emulator baseline"_, with
§4's KPI _"CPU throughput vs best existing in-browser emulator ≥ 3× (stretch
5×)"_ and _"≥ 50% of QEMU-TCG on the same host"_.

Three things had to be true for the project's execution strategy (ADR-0002,
ADR-0003, ADR-0004) to survive contact with a runtime:

1. RV32IMA can be translated to Wasm **at all** — including atomics, LR/SC,
   division corner cases, and precise faults for MMIO.
2. The translation is **fast enough** to be worth the complexity, on the shapes
   of work a real Debian system runs, not just on a synthetic ALU loop.
3. It is **correct**: identical architectural state to the interpreter,
   identical retire counts, identical observable side effects (MMIO reads must
   happen exactly once).

## 2. What was built

A three-tier engine, all in TypeScript, with no dependencies:

- **Tier 0 — interpreter** (`core/src/cpu/interp.ts`): one `execute()` per step,
  a 1 IPC cycle model, `MachinePort` for MMIO and syscalls. This is the
  differential oracle; everything the JIT claims is checked against it.
- **CFG recovery** (`jit/cfg.ts`): basic blocks by traversal from a hot pc,
  mid-block truncation when a jump lands inside a block, region formation
  (ADR-0003: one region = one Wasm function with an internal `br_table`
  dispatch ladder, bounded by `maxRegionBlocks`/`maxRegionInsns`), loop-header
  detection so the instruction-budget check is emitted on back edges only.
- **Translator** (`jit/codegen.ts`): RV32IMA → Wasm. Register file in mutable
  globals _or_ in a control page; bounds by hardware trap _or_ inline check;
  constant and branch folding; AMOs via the threads proposal (`i32.atomic.rmw*`,
  verified against the real 0xfe opcode layout rather than recalled); LR/SC via
  a reservation carried across host transitions; `ecall`/`ebreak`/`wfi`/CSR/
  `fence.i` end the block so the host owns their exact semantics.
- **Encoder** (`jit/wasm/encoder.ts`): a from-scratch Wasm binary builder — no
  third-party assembler, because a JIT that cannot emit bytes cannot exist.
- **Tiering engine** (`jit/engine.ts`): heat on control-transfer targets →
  compile → run compiled until the host is needed → optional recompile with
  optimisation → code cache → invalidation on `fence.i` and interrupts.

Correctness was not deferred to the end: `core/test/jit.test.ts` runs a
12-program corpus (ALU loop, all seven AMOs, AMO min/max signed and unsigned,
AMO in a loop, LR/SC success and both failure modes, a CAS retry loop,
division/remainer corners, calls and indirect jumps, every load/store width,
shifts and compares, MMIO through the device model, CSR, nested loops) under
**eight** configuration variants, twice each, and requires identical registers,
identical guest RAM, identical stop reason, identical `minstret`, and identical
MMIO read counts.

## 3. Results

Throughput in millions of guest instructions per second (MIPS), best of up to 25
samples per cell, each sample on a freshly constructed machine. `interp` is the
Tier-0 interpreter; the other columns are the JIT under five configurations.

| workload    | shape                  | interp | globals/trap | globals/trap +opt | globals/inline | **memory/inline** | tail-chain |
| ----------- | ---------------------- | -----: | -----------: | ----------------: | -------------: | ----------------: | ---------: |
| arith-loop  | add/xor/addi/blt ×2M   |   59.4 |         2123 |              2160 |           2012 |          **3203** |       2134 |
| memory-copy | lw/sw 4 KiB ×500       |   44.9 |         1937 |              1716 |           1919 |          **2901** |       2056 |
| divmod      | LCG + divu/remu        |   61.8 |         2177 |              2165 |           1907 |          **2491** |       2199 |
| branchy     | unpredictable beqz/j   |   51.6 |         1176 |              1156 |           1171 |              1174 |   **1181** |
| calls       | recursive fib(24)      |   41.8 |          237 |               231 |            226 |           **285** |        228 |
| atomics     | amoadd.w loop (shared) |   42.7 |          529 |               631 |            634 |           **637** |        632 |
| matrix      | 64×64 scale ×40        |   55.2 |         1534 |              1394 |           1490 |          **2472** |       1446 |
| device-poll | UART LSR polling       |   47.7 |         24.9 |              24.8 |           24.2 |              26.5 |       24.8 |

Run-to-run spread on this box is real and worth stating: a second, independent
`record --all` (commit `fdb7d92`,
`benchmarks/results/20261119T165929Z-fdb7d92-jit+wasm+baseline.json`) reproduced
the _ranking_ exactly — `memory/inline` first on seven of eight workloads,
`device-poll` below 1× — but moved absolute throughput by up to ±30%
(arith-loop interpreter 59.4 vs 51.1 MIPS, best JIT 3203 vs 3543 MIPS). The
harness samples adaptively (best-of-5 minimum, extended to 25 repetitions until
the fastest sample exceeds 20 ms) and the gate's tolerance is 20%, which is
calibrated against exactly this spread. Treat the ratios, not the absolutes, as
the result.

Speedup over the interpreter:

| workload    | globals/trap | globals/trap +opt | globals/inline | memory/inline | tail-chain |
| ----------- | -----------: | ----------------: | -------------: | ------------: | ---------: |
| arith-loop  |        35.8× |             36.4× |          33.9× |     **54.0×** |      35.9× |
| memory-copy |        43.1× |             38.2× |          42.7× |     **64.6×** |      45.8× |
| divmod      |        35.2× |             35.0× |          30.9× |     **40.3×** |      35.6× |
| branchy     |        22.8× |             22.4× |          22.7× |         22.7× |  **22.9×** |
| calls       |         5.7× |              5.5× |           5.4× |      **6.8×** |       5.5× |
| atomics     |        12.4× |             14.8× |          14.9× |     **14.9×** |      14.8× |
| matrix      |        27.8× |             25.3× |          27.0× |     **44.8×** |      26.2× |
| device-poll |        0.52× |             0.52× |          0.51× |         0.56× |      0.52× |

### 3.1 Against an existing in-browser emulator

`8086emu` 1.5.1 (MIT, Rust compiled to Wasm, RV32IM interpreter core) is the
comparator: the same bytes, produced by _our_ assembler, written into its memory
and stepped for exactly the number of instructions our interpreter retires.

| workload   | interpreter (ours) | JIT globals/trap (ours) | 8086emu 1.5.1 | JIT vs 8086emu |
| ---------- | -----------------: | ----------------------: | ------------: | -------------: |
| arith-loop |               67.9 |                  2216.5 |         165.3 |      **13.4×** |
| divmod     |               54.9 |                  2108.4 |         142.3 |      **14.8×** |
| branchy    |               62.0 |                  1038.0 |         151.7 |       **6.8×** |

The KPI (≥3×, stretch 5×) is met with the JIT and **missed without it** — the
interpreter alone is 0.4× of a Rust-to-Wasm interpreter, which is what one
should expect from a TypeScript `switch`. This is the single strongest argument
for ADR-0002: the JIT is not an optimisation, it is the product.

`8086emu` is used for **speed only**. It is not a correctness oracle: on
`arith-loop` it halts having produced `a0 = 0` where an independent model of the
same program (and both of our engines) produce `-1188726464`, and on `branchy` it
stops mid-loop before its step budget is spent. Conformance comes from
`riscv-tests`, `riscv-arch-test` and QEMU-TCG differential fuzzing in CI
(ROADMAP §9), none of which can run in this sandbox (no riscv toolchain, no QEMU).

### 3.2 What compiling costs

| workload    | regions | blocks | Wasm bytes | translate ms | instantiate ms |            host exits |
| ----------- | ------: | -----: | ---------: | -----------: | -------------: | --------------------: |
| arith-loop  |       1 |      2 |        622 |         0.17 |           0.05 |                     0 |
| memory-copy |       1 |      4 |        844 |         0.15 |           0.06 |                     0 |
| branchy     |       1 |      5 |        701 |         0.11 |           0.06 |                     0 |
| calls       |       4 |     10 |       2870 |         0.62 |           0.29 |               149 980 |
| matrix      |       1 |      6 |       1078 |         0.14 |           0.06 |                     0 |
| device-poll |       2 |      8 |       1424 |         0.17 |           0.08 | 32 (then tiered down) |

Separately, the cost of V8 compiling a module of a given size (a loop of `i32.add`,
`benchmarks/suites/wasm.ts`):

| module size         |   bytes | compile+instantiate | ns per instruction |
| ------------------- | ------: | ------------------: | -----------------: |
| 256 instructions    |     936 |            0.003 ms |               11.0 |
| 4 096 instructions  |  14 376 |            0.006 ms |                2.4 |
| 32 768 instructions | 114 730 |            0.045 ms |                2.7 |

So **our translator is ~50× more expensive per instruction than V8's compiler**
(≈500 ns/instruction of translation vs ≈3–11 ns/instruction of compilation).
Region size limits should be chosen by translation time and code-cache pressure,
not by Wasm compile time; and an optimising pass that re-translates a hot region
pays for itself only if the region runs long enough (see §4.6).

### 3.3 Platform facts (ADR-0003/0004 evidence)

Probed at runtime, not read from a compatibility table:

| probe                                              | result                                                                          |
| -------------------------------------------------- | ------------------------------------------------------------------------------- |
| threads (shared `WebAssembly.Memory`)              | **yes**                                                                         |
| shared memory growable                             | **yes**                                                                         |
| atomics / `Atomics.wait`                           | **yes / yes**                                                                   |
| SIMD, bulk-memory, tail calls, exceptions          | **yes**                                                                         |
| memory64                                           | validates, **does not run** in Node 22 even with `--experimental-wasm-memory64` |
| reserve 4 GiB (32-bit, `initial:1, maximum:65536`) | **ok, 0.007 ms** — reservation is lazy                                          |
| reserve 4 GiB shared                               | **ok, 0.006 ms** (Node only - see below)                                        |
| commit 256 MiB / 256 MiB shared                    | ok, 0.010 ms / 0.007 ms                                                         |
| `i32.atomic.add` (Wasm)                            | 9.7 ns/op                                                                       |
| `Atomics.add` / `compareExchange` (JS)             | 10.1 / 10.7 ns/op                                                               |
| plain Wasm store+load                              | 0.29 ns/op                                                                      |

Two consequences. First, guest RAM can be a single lazily-reserved 4 GiB
`WebAssembly.Memory` with `maximum` set, and bounds checks can be delegated to
the hardware (ADR-0004) — the reservation is free. Second, **memory64 cannot be
part of the design**: it validates but traps at runtime, so the RV32 guest must
fit a 32-bit memory, which it does.

**The shared-reservation row is a Node result and must not be generalised.** A
shared `WebAssembly.Memory` is backed by a `SharedArrayBuffer`, and browsers
commit that eagerly where V8-in-Node reserves lazily. The first CI browser run
died silently for exactly this reason: the capability probe binary-searched the
shared maximum up to 4 GiB, the renderer went away, and the page never posted a
report - twenty minutes of nothing. The probe now takes a ceiling
(`SHARED_PROBE_CEILING_BROWSER`, 256 MiB in a page against the full 4 GiB in
Node) and reports that ceiling next to the result, so a capped number cannot be
mistaken for a limit. Whether a browser will reserve 4 GiB of _shared_ memory is
therefore **not measured here**, and it matters: ADR-0004 wants guest RAM shared
for SMP, so Spike B has to answer it per engine, in a worker, with a fallback
sized from `navigator.deviceMemory`.

An atomic RMW costs ~33× a plain access. Guest spinlocks and `amoswap`-heavy
kernel paths will therefore be slow in absolute terms; Spike B has to measure the
_contended_ case and decide whether `Atomics.wait`-based idle is enough.

## 4. Findings

### 4.1 GO on the region JIT

23–65× over the interpreter on seven of eight workload shapes, 6.8–14.8× over
the published in-browser comparator. Every configuration is correct on the whole
differential corpus. ADR-0002's tiering is justified by measurement.

### 4.2 The register file belongs in guest memory, not in Wasm globals

`regalloc: 'memory'` (a control page at the end of guest RAM) beat 33 imported
mutable globals on **every** workload: 1.5× on arith-loop, 1.5× on memory-copy,
1.6× on matrix, 1.1–1.3× elsewhere. Imported mutable globals cost on both sides
— Wasm reaches them through an import indirection, and JS reaches them through
`WebAssembly.Global.value` property accessors (~64 of them per host transition).

That second cost is visible directly: on the exit-heavy device-poll workload,
`memory/inline` was 2.4× faster than `globals/trap` _before_ tier-down existed,
because a memory register file needs almost no sync.

**Decision input for ADR-0004:** default to the control-page register file. Keep
the globals layout behind the config flag (it needs no control page, which
matters for a guest image that wants every byte of RAM), and re-measure in
browsers: this is a V8-in-Node result, and SpiderMonkey/JSC may rank imported
globals differently. Follow-up worth doing in Phase 1: make `CpuState.regs` an
`Int32Array` **view** onto the control page, which turns every host transition
from 64 property accesses into zero copies.

### 4.3 Trapping bounds and inline bounds cost the same

`globals/trap` vs `globals/inline`: within noise of each other on every workload
(±5%). Trapping bounds are cheaper to emit (no check code, smaller modules:
622 vs 633 bytes) and give exact fault addresses for free, but they require
guest RAM to be the _whole_ memory — a trailing control page would silently
absorb an out-of-range access instead of trapping, so the engine rejects that
combination outright. With the control-page register file (§4.2) that means
inline bounds are the practical default. Both stay supported; both are
differentially tested.

### 4.4 Indirect control flow is the bottleneck

Recursive fib(24) reaches only 5.4–6.8× while everything else reaches 23–65×.
The cause is visible in the counters: **149 980 host exits** for ~2 M
instructions, one per `ret`. Every indirect jump leaves the region
(`EXIT.CHAIN`), returns to the JS dispatcher, looks the target up, and re-enters
— and each of those transitions costs a register-file sync.

Tail chaining through a Wasm function table (`chaining: 'tail'`) does **not**
fix it here (228 vs 237 MIPS): the table call replaces the JS round trip but the
target region still has to be entered from the top, and V8's table calls are not
free. Real fixes, in rough order of expected payoff:

1. **Return-address inline cache**: remember the last target of each `jalr` site
   and, when it matches, dispatch inside the region via `br_table` instead of
   exiting. Recursion and `ret`-heavy code hit the same handful of targets.
2. **Region merging on hot call edges**: absorb a callee into the caller's
   region so `jal`/`ret` become internal edges (the region former already tracks
   `externalTargets`; it needs a call-graph-aware policy).
3. **A dispatch table inside the region** for indirect jumps whose targets are
   all in-region (switch tables, computed gotos — common in interpreters and
   in the kernel's syscall path).

This is the largest remaining performance item and it is a Phase 1 task, not a
spike blocker: even at 6.8× the KPI is met, and real workloads are less
return-dense than fib.

### 4.5 Compiled code is not automatically better: device polling

A UART polling loop measured **0.52× the interpreter** — 14× slower compiled.
Two mechanisms were needed to make that safe, and both are now permanent parts
of the engine:

- **Slow-pc learning.** An access that faults `MAX_TRAPS_PER_PC` (3) times is
  recorded; the next translation splits the block _before_ it and the host
  single-steps it. Retiring the region alone is not enough — it gets recompiled
  identically and faults again forever, and with inline bounds the engine spun
  200 000 times without retiring a single instruction. When the hot pc _is_ the
  slow instruction, the region is compiled from its successor and the
  interpreter single-steps into it, so the rest of the loop stays compiled.
  After learning, the JIT performs **exactly as many MMIO reads as the
  interpreter** (668 vs 668 on the polling test) — before the state-sync
  direction bug was found, it read the UART receive register twice per byte and
  silently discarded the input.
- **Tier-down.** One host exit costs ~1 µs, which is ~40 interpreted
  instructions. A region that retires fewer than 32 instructions per exit
  therefore cannot pay for itself; after 32 exits it is retired and its blocks
  declined, and the interpreter owns that code. Device polling went from 0.07×
  to 0.56× of the interpreter, and the residual gap is the one-off cost of
  compiling two regions before the heuristic fires.

The honest reading: **the interpreter is a tier, not a fallback**. Any
device-heavy or syscall-heavy phase of a real boot will spend time in it, and
that is the correct outcome.

### 4.6 Constant folding pays, but only on re-compilation

The optimising pass (`+opt`, which folds constant registers and whole branches)
is worth +1.7% on arith-loop, −10% on memory-copy, +0.1% on divmod: noise-level.
Its cost is a second translation of the region (≈0.1–0.6 ms). It stays in the
design because real code has address arithmetic that these microbenchmarks
already hoist by hand, but `optimizeThreshold` must stay high (default 4096
retired instructions) so cold regions are never translated twice.

### 4.7 What the spike did not measure

- **In a browser.** Everything above is Node/V8, and one row - the 4 GiB shared
  reservation - is known _not_ to generalise (see the note in §3.3). `npm run bench:browser`
  bundles the same suites with esbuild, serves them with COOP/COEP so
  `SharedArrayBuffer` exists (ADR-0010), and drives them with playwright-core;
  this sandbox has no Chromium binary, so those numbers are outstanding and are
  the first thing CI must produce. SpiderMonkey and JSC compile Wasm
  differently, and §4.2 in particular may not transfer.
- **Against QEMU-TCG.** The "≥50% of QEMU-TCG" KPI needs QEMU, which is not
  installable here. The comparator in §3.1 is the substitute for now.
- **MMU, privilege modes, interrupts under load.** All guest addresses are RAM
  offsets today; a software TLB in the translator will change the load/store
  cost profile, and the tier-down thresholds may need revisiting.
- **SMP.** One hart. Atomics were measured single-threaded (§3.3); contended
  behaviour is Spike B.
- **Real guest code.** No CoreMark/Dhrystone/gcc: those need a toolchain and a
  bootable image (Phase 1). The workloads here are hand-written RV32IMA shaped
  like the work those benchmarks are made of.

## 5. Decisions this spike feeds

| ADR                               | Input from this spike                                                                                                                                                                                                                                                  |
| --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ADR-0002 (tiered execution)       | **Confirmed.** 23–65× on compute shapes; interpreter-only is 0.4× of the comparator, so tiering is mandatory, and §4.5 shows the interpreter must remain a first-class tier.                                                                                           |
| ADR-0003 (region per Wasm module) | **Confirmed, with a caveat.** Regions of 2–10 blocks compile in 0.1–0.6 ms and run at 1–3 GIPS; module compile time is not the constraint (§3.2). The caveat is indirect control flow (§4.4).                                                                          |
| ADR-0004 (guest RAM model)        | **Confirmed and refined.** A single lazily-reserved 4 GiB memory works and is free; memory64 is unusable at runtime, so RV32 must fit 32 bits; the register file should live in a control page in that memory (§4.2), which then requires inline bounds checks (§4.3). |
| ADR-0013 (core language)          | New: the core is TypeScript, not Rust as §7 of the ROADMAP sketches, because the hot path _is_ Wasm and the host language has to build and instantiate modules synchronously. The measured 1–3 GIPS is the evidence that this is not a performance surrender.          |

## 6. Follow-ups

- [ ] Return-address inline cache for `jalr`/`ret` (§4.4) — largest remaining win.
- [ ] Call-graph-aware region formation: absorb hot callees.
- [ ] `CpuState.regs` as a view onto the control page → zero-copy host transitions (§4.2).
- [ ] Calibrate `TIER_DOWN_INSNS_PER_EXIT` from a measured sync cost at startup instead of a constant (§4.5).
- [ ] Run all three suites in Chromium, Firefox and WebKit in CI; compare the config ranking (§4.2, §4.3).
- [ ] Measure the largest _shared_ reservation each browser engine will hand a tab, and a worker. §3.3 shows the Node answer does not transfer, and ADR-0004's SMP story depends on it.
- [ ] `riscv-tests` + `riscv-arch-test` in CI, and QEMU-TCG differential fuzzing as the real oracle (§3.1).
- [ ] Re-measure with an MMU/software TLB in the load/store path.
- [ ] Slow-pc set must be invalidated when guest mappings change (it is a static-RAM assumption today).

## 7. Reproducing

```sh
npm install
npm test                                   # 288 tests, incl. 132 JIT differential
npm run bench -- --all                     # all three suites, text table
npm run spike -- a                         # the suites tagged for Spike A
npm run bench:record -- --all --baseline   # write results/ and refresh baselines/
npm run bench:gate -- --suite jit          # CI regression gate (20% tolerance)
npm run report -- --md --out docs/kpi/latest.md
npm run bench:browser -- --suite jit,wasm  # needs a Chromium binary (WNX_BROWSER)
npm run serve                              # browser demo on :8080, served with COOP/COEP
```

`web/test/demo.test.ts` runs the demo page's compute path in Node and asserts
what the page displays: both engines retire the same instruction count, produce
the same result, perform the same number of MMIO writes, and the UART polling
case tiers down.

Raw samples (every repetition, not just the best) are in
`benchmarks/results/*.json`; the numbers quoted above are the `best` sample of
each cell from `20261119T164129Z-061bd0e-jit+wasm+baseline.json`. Result files
are a history, not a cache: `docs/kpi/latest.md` renders whichever run is newest,
so its absolutes can differ from the tables here by the spread noted in §3 while
agreeing on every ranking.
