# ADR-0004: Guest RAM — shared WebAssembly.Memory, Memory64 where available, explicit TLB

## Status

accepted

## Date

2026-11-19

## Context

Guest RAM must be shared across N vCPU workers (ADR see SMP spike B) with
correct guest atomic semantics, and must address more than 4 GB where hosts
allow it. Wasm offers two memory types:

- **Memory32 (shared)**: works on all threads-capable builds; 4 GB ceiling;
  requires cross-origin isolation (ADR-0010).
- **Memory64 (shared)**: Chrome-only today (flagged in Safari/Firefox
  development paths); raises the ceiling past 4 GB and simplifies large-image
  guests; must be feature-detected at runtime with a Memory32 fallback.

Wasm has no hardware page protection, no `mprotect`, no guard pages. An
unchecked guest load/store outside RAM would corrupt the whole sandbox. All
generated code therefore needs **explicit address translation/bounding**:

- Fixed-size TLB cache in linear memory (hashed per guest page), populated by
  the MMU emulation; generated loads/stores first probe the TLB fast path.
- Slow path traps to the MMU which performs the walk, maps or raises the
  guest fault (guest page fault → guest kernel, not a host trap).
- All guest memory instructions are bounds-safe **by construction**: the TLB
  fast path computes `host_addr = tlb_entry.base + (guest_addr & (pagesize-1))`
  from a dedicated table the guest cannot address, and any miss branches to a
  non-inlinable helper. There is no raw guest→linear-memory index anywhere in
  generated code.

SMP atomics (spike B): guest LR/SC and AMOs map onto shared-memory Wasm
atomics (`i64.atomic.rmw.add`, `i64.atomic.rmw.cmpxchg`, `i32/i64.atomic.load`
etc.). Memory-model validation in spike B ran store-buffering and
load-buffering litmus tests (0 forbidden outcomes in 100k rounds) and
confirmed `Atomics.wait` parks idle vCPUs without spinning (parked wake
≈ 85 µs vs ≈ 4.5–5 ms for an ineffective wait/notify cycle). Contended
`AMO` scaling is negative (0.79–0.83× for the contended counter), while
partitioned access scaled 1.93× — guest scheduler guidance should prefer
partitioned structures (recorded in ADR-0002-adjacent docs).

## Decision

- Guest RAM is a **shared `WebAssembly.Memory`**: Memory64 + shared when
  feature-detected, shared Memory32 otherwise; never non-shared.
- **Explicit TLB** in generated code as described; no direct guest-indexed
  memory access anywhere.
- Guest atomics lower to Wasm atomic instructions on the same shared memory;
  LR/SC loops use a bounded reservation with timeout (dead-peer liveness).
- Idle vCPUs park in `Atomics.wait` (futex-style), woken by `Atomics.notify`
  from the interrupt generator — no spin loops on the host.

## Consequences

- 4 GB guest ceiling on Memory32 fallback; ROADMAP startup/memory KPIs must
  be validated on the Memory32 path too.
- TLB miss path is shared code, heavily exercised — differential-test it like
  the ALU.
- One linear memory = one failure domain for stray stores; the "Wasm can't
  trap on store" property means guest wild stores silently corrupt guest
  RAM. Mitigation is generated-code correctness + the TLB invariant, not a
  page fault. Fuzz the generator (Phase 1).
- Shared-memory + threads requires cross-origin isolation everywhere
  (ADR-0010) — this is not optional.
