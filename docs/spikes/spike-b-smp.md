# Spike B — SMP: N vCPU workers on shared memory

**Deliverable:** `spikes/spike-b-smp/` · **Results:** `benchmarks/results/spike-b-smp-draft.json`

## What was built

- `src/guest-atomics.ts` — LR/SC, AMOs (add/swap/cmpxchg) lowered to Wasm atomics
- `src/vcpu-worker.ts`, `src/smp.ts` — worker pool over shared `WebAssembly.Memory`
- Memory-model litmus harness (store-buffering, load-buffering)
- `Atomics.wait` parking (futex-style idle; no spin on host)
- 8/8 tests

## Measured (2 vCPUs this host)

| Workload | 1→2 workers | Reading |
|---|---|---|
| Contended AMO counter | 0.79× | negative scaling — expected for hot cacheline |
| Spinlock holder/waiter | 0.83× | same story |
| Partitioned hash | **1.93×** | near-linear; the case that matters for `make -j` |
| Litmus SB / LB | 0 forbidden / 100k | memory model OK on this host |
| Parked wake latency | **≈ 85 µs** | vs ≈ 4.5–5 ms ineffective wait/notify — parking works |

## Calibration

ROADMAP SMP row recalibrated in `docs/kpi-calibration.md`: 0.8×/core stays the
gate for *partitioned* builds; contended kernels are stretch expectations.
Re-measure at 8 vCPUs in Phase 3.
