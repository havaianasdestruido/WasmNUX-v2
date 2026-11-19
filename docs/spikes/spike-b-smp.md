# Spike B — SMP: N vCPU workers on shared memory

**Deliverable:** `spikes/spike-b-smp/` · **Results:** `benchmarks/results/spike-b-smp-draft.json`

## What was built

- `src/guest-atomics.ts` — LR/SC, AMOs (add/swap/cmpxchg) lowered to Wasm atomics
- `src/vcpu-worker.ts`, `src/smp.ts` — worker pool over shared `WebAssembly.Memory`
- Memory-model litmus harness (store-buffering, load-buffering)
- `Atomics.wait` parking (futex-style idle; no spin on host)
- 8/8 tests

Post-review hardening (both benchmarks re-run and committed):

- LR/SC reservations no longer trust a value compare. A per-granule **epoch
  companion buffer** (8 B/granule, shared alongside guest RAM) invalidates a
  reservation on ANY write to the granule — including same-value round trips
  (ABA). ABA cases (same-value store, same-value AMO) are covered by tests.
  All write paths claim the granule epoch (seqlock-style odd/even), so SC
  success/failure is exact. Cost measured in the table below.
- The partitioned-hash benchmark was measuring a **different function** per
  worker count (seeds were per worker index) — checksums could never match.
  Redefined as an element-independent SplitMix64 fold xor-combined across
  partitions; 1- and 2-worker checksums now match exactly
  (`57ca3717a5a33fe2` both). 2-worker speedup 1.86–2.03×.

## Measured (2 vCPUs this host, epoch-protocol code)

| Workload | 1→2 workers | Reading |
|---|---|---|
| Contended AMO counter | 0.63× | negative scaling — expected for hot cacheline; slower than pre-review (0.79×) because every AMO now claims the epoch (correctness over micro-benchmark speed) |
| Spinlock holder/waiter | 0.68× | same story (was 0.83×) |
| Partitioned hash | **1.86×** | near-linear; the case that matters for `make -j` |
| Litmus SB / LB | 0 forbidden / 100k | memory model OK on this host |
| Parked wake latency | **≈ 86 µs** | vs ≈ 4.5–5 ms ineffective wait/notify — parking works |

## Calibration

ROADMAP SMP row recalibrated in `docs/kpi-calibration.md`: 0.8×/core stays the
gate for *partitioned* builds; contended kernels are stretch expectations.
Re-measure at 8 vCPUs in Phase 3.
