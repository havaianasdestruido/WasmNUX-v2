# Architecture decision records

> These records describe historical decisions and proposals, not current feature
> completion. The active implementation and outstanding evidence are documented
> in [architecture](../../ARCHITECTURE.md) and [integration status](../integration-status.md).
> The prior best-sample measurements are not validated cross-host KPIs.

Phase 0's exit criterion (ROADMAP §5) is "measured numbers for every KPI row,
written ADRs, explicit go/no-go on the JIT design". This directory holds the
ADRs. Where a spike produced numbers, the ADR cites them; where it did not, the
ADR says what is still missing and what would settle it.

| ADR                                     | Question                            | Status                                                                                               |
| --------------------------------------- | ----------------------------------- | ---------------------------------------------------------------------------------------------------- |
| [0001](0001-guest-isa.md)               | Guest ISA                           | **Accepted** — riscv64 target, RV32IMA built and measured first                                      |
| [0002](0002-execution-strategy.md)      | Execution strategy                  | **Accepted** — three tiers, interpreter as a permanent tier, on measured evidence                    |
| [0003](0003-wasm-module-granularity.md) | Wasm module granularity             | **Accepted** — region-per-module with `br_table` dispatch, on measured evidence                      |
| [0004](0004-guest-ram-model.md)         | Guest RAM model                     | **Accepted** — one shared 4 GiB lazily reserved memory; no Memory64; register file in a control page |
| [0005](0005-disk-layout.md)             | Disk layout                         | Proposed — ext4 on virtio-blk, chunked base + OPFS COW overlay; awaits Spike C                       |
| [0006](0006-kernel.md)                  | Kernel                              | Proposed — stock Debian default, tuned `wasmnux` kernel opt-in from a signed apt repo                |
| [0007](0007-gpu-path.md)                | GPU acceleration path               | Proposed — deliberately undecided; software baseline mandatory, A/B/C spiked in Phase 6              |
| [0008](0008-networking.md)              | Networking                          | Proposed — user-space TCP/IP in Wasm over a relay; Direct Sockets in the IWA build                   |
| [0009](0009-terminal.md)                | Terminal                            | Proposed — custom WebGPU renderer; xterm.js as bootstrap only                                        |
| [0010](0010-cross-origin-isolation.md)  | Hosting / headers                   | **Accepted** — COOP/COEP with a service-worker fallback                                              |
| [0011](0011-licensing.md)               | License                             | **Accepted** — Apache-2.0 core, GPL components isolated as data                                      |
| [0012](0012-debian-tracking.md)         | Debian tracking                     | **Accepted** — track stable; testing/sid by script; upgrades inside the guest                        |
| [0013](0013-core-language.md)           | Core language _(not in ROADMAP §3)_ | **Accepted with a Phase 1 review gate** — TypeScript host-side core, Wasm as the hot path            |

ADR-0013 is an addition to the ROADMAP's list of twelve. It records a deviation
from §2 ("emulator core: Rust → Wasm") that Phase 0 made in order to measure the
JIT, and which the measurements then justified.

## Conventions

- One file per decision, numbered, never renumbered. A reversed decision gets a
  new ADR that marks the old one Superseded.
- Every ADR states its **Status** (`Proposed` / `Accepted` / `Superseded` /
  `Deprecated`), the alternatives it rejected _and why_, and the consequences it
  is willing to own.
- An ADR whose status is Accepted on evidence cites the artefact: a spike
  document, a benchmark result file under `benchmarks/results/`, or a test.
- An ADR whose status is Proposed lists the measurements that would make it
  Accepted, so it is clear which spike owes what.
- Numbers in an ADR come from a committed result file, not from memory. Re-run
  the benchmark and update the ADR rather than editing a number by hand.

## Spike → ADR map

| Spike                                           | Phase | Settles                                                              | Status        |
| ----------------------------------------------- | ----- | -------------------------------------------------------------------- | ------------- |
| [A — JIT feasibility](../spikes/spike-a-jit.md) | 0     | 0001, 0002, 0003, 0004, 0013                                         | **done — GO** |
| B — SMP                                         | 0     | 0004 (shared memory, `Atomics.wait` idle), 0002 (per-worker engines) | not started   |
| C — Storage                                     | 0     | 0005                                                                 | not started   |
| D — Display + GPU                               | 0/6   | 0007, 0009                                                           | not started   |
| E — Network                                     | 0     | 0008                                                                 | not started   |
| F — Terminal                                    | 0     | 0009                                                                 | not started   |
