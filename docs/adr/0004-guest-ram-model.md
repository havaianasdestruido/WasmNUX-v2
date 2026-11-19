# ADR-0004: Guest RAM model — shared `WebAssembly.Memory`, explicit TLB checks

- **Status:** Accepted (Phase 0)
- **Date:** 2026-11

## Context

Wasm has no `mprotect` and no guard pages: the MMU (Sv39) cannot rely on
hardware page faults to trap guest accesses. vCPUs must share one physical
RAM across workers (SMP), and the JIT needs a fast, in-bounds access path.

## Decision

1. **One shared `WebAssembly.Memory`** for all harts/workers. Worker threads
   receive it by structured clone — Phase 0 verified clones share the same
   underlying storage (reads/writes/grow visible both ways). `Memory64` is
   used where the engine exposes it (Phase 1 probe; Phase 0 targets the
   widely available 32-bit shared-memory path with an explicit 4 GB ceiling
   documented).
2. **Per-hart footer pages** after RAM: `[regfile | scratch] × hartCount`,
   selected by `hart` index — registers never cross harts, RAM is shared.
3. **Explicit TLB** in software (`mmu.ts` Sv39 walker + TLB) with
   **inline range/base probes in generated code**: the JIT emits a
   bounds check (RAM base..limit) before every load/store and falls back to
   the slow path (full translate + fault) outside — this is the Wasm
   analogue of the guard-page fault, done in software.
4. **Faults** surface as guest traps (cause 5/7/13/15/…) with the same
   semantics from interpreter and JIT (equivalence-tested).

## Evidence (Phase 0)

- `memory.ts` hart isolation tests (regfile offsets, shared RAM byte).
- `jit.test.ts`: out-of-range store traps identically in both tiers;
  fast-path load/store fuzz shows 0 divergences.
- Spike B: shared-memory ping-pong across `worker_threads` (row `b1`,
  57 µs/RTT) proves the SMP substrate.

## Consequences

- 4 GB RAM ceiling on the Memory32 path — acceptable (guest RAM ≤ 2 GB in
  Phase 1; Memory64 probe unlocks more later).
- Every JIT memory op pays one branch for the probe; tier 2 can hoist it
  (roadmap: *fast-path memory access with inline TLB probe*).
- Snapshot serialisation reads the same memory object (ADR-0005 journal
  chunks it).
