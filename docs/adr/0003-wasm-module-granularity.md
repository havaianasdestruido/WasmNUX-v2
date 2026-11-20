# ADR-0003: Wasm module granularity — region-per-module

- **Status:** Accepted (Phase 0), on measured evidence
- **Related:** ADR-0002, ADR-0004
- **Evidence:** [`docs/spikes/spike-a-jit.md`](../spikes/spike-a-jit.md) §3.2

## Context

A JIT that emits Wasm has to decide what one `WebAssembly.Module` corresponds
to. The choices are one module per basic block, one per function, one per region
(a set of blocks with an internal dispatch), or one long-lived module that is
patched. Each module costs a compile plus an instantiate, and Wasm gives no way
to add a function to an existing module — so granularity directly sets how much
of the budget goes to module churn.

The generated code also cannot jump between modules directly: Wasm has no
function pointers into arbitrary blocks, so cross-module control flow must go
through an indirect call, a table, or the host.

## Decision

**One Wasm module per region.** A region is a set of basic blocks closed under
the CFG where practical, compiled into a single function with an internal
`br_table` dispatch ladder:

```
(entryBlock: i32, budget: i32) -> (reason: i32, budgetLeft: i32)
  $exitLoop → $top → $fault → $budgetExit → $b_0 … $b_n → br_table
```

Limits, all measured rather than guessed: `maxRegionBlocks` 24,
`maxRegionInsns` 512, `maxRegions` 512.

Module boundaries are crossed only where the CFG actually leaves the region
(indirect jumps, calls to uncompiled code, MMIO, syscalls), and each crossing is
an explicit exit reason handled by the engine's dispatcher.

**Rejected: one module per basic block.** A block of 2–6 instructions would cost
≈500 ns of translation plus a module compile/instantiate, to run maybe 50 times
before the next block is compiled. ROADMAP §3 already names this
("instantiate overhead dominates") and the measurements agree from the other
direction: a 256-instruction module costs ~11 ns/instruction to compile while a
32 768-instruction module costs ~2.7 ns/instruction, so **small modules are
disproportionately expensive** — the ~20 µs fixed cost per compile dominates
until a module is a few thousand instructions.

**Rejected: one module per guest function.** Guest function boundaries are not
visible without a full call-graph analysis, recursive and mutually-recursive
functions would each need their own module and an indirect-call trampoline
between them, and hot loops that call nothing would be split unnecessarily.
Region formation from a hot pc is CFG-local and needs no call graph.

**Rejected: one long-lived, patched module.** Wasm modules are immutable; there
is no patching. (A `Table` of compiled regions plus one dispatcher module is a
viable _addition_ — see consequences.)

## Consequences

**Positive**

- The internal `br_table` ladder turns intra-region edges into a single indirect
  branch inside one function: no host round trip, no table call. This is why
  tight loops reach 40–65× the interpreter and exit the host **zero** times
  (`hostExits = 0` on arith-loop, memory-copy, divmod, branchy, atomics, matrix).
- One instantiate per region: measured 0.05–0.29 ms for regions of 1–4 modules,
  against workloads that then run at 1–3 GIPS.
- Region size is bounded, so translation time is bounded (0.11–0.62 ms) and
  memory growth is predictable.
- The instruction budget is checked once per loop back-edge rather than per
  instruction, which removes the check from the inner loop entirely (Spike A
  measured 8192-tick slicing at 607 MIPS vs 1086 MIPS unsliced on the same code).

**Negative / obligations**

- **Cross-region control flow is expensive, and it is the dominant remaining
  cost.** `calls` reaches only 5.4–6.8× because each `ret` exits the region
  (149 980 host exits for ~2 M instructions). Tail-chaining through a Wasm
  function table did not fix it in Node/V8 (228 vs 237 MIPS). The real fixes are
  a return-address inline cache and call-graph-aware region merging, both of
  which change what a region _is_ — this ADR will need an amendment.
- A region is bounded by `maxRegionInsns`, so a large hot loop gets split across
  regions and pays an exit at the seam. `formRegion` should prefer splitting on
  cold edges, which it does not currently do.
- The dispatch ladder costs one `br_table` per edge; for regions with many
  blocks this is a real (if small) overhead versus direct branches.
- Code-cache growth is per-module, so `maxRegions` is a hard memory bound that
  needs an eviction policy.

## Evidence

| workload    | regions | blocks | Wasm bytes | translate ms | instantiate ms |           host exits |
| ----------- | ------: | -----: | ---------: | -----------: | -------------: | -------------------: |
| arith-loop  |       1 |      2 |        622 |         0.17 |           0.05 |                    0 |
| memory-copy |       1 |      4 |        844 |         0.15 |           0.06 |                    0 |
| branchy     |       1 |      5 |        701 |         0.11 |           0.06 |                    0 |
| calls       |       4 |     10 |       2870 |         0.62 |           0.29 |              149 980 |
| device-poll |       2 |      8 |       1424 |         0.17 |           0.08 | 32, then tiered down |

Module compile cost by size (V8, Node 22): 256 insns → 11.0 ns/insn;
4096 → 2.4 ns/insn; 32768 → 2.7 ns/insn. Our translator: ≈500 ns/insn.
