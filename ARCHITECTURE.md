# Current architecture

This document describes the code on this branch, not the target system in
[ROADMAP.md](ROADMAP.md). The project is experimental and **not merge-ready**
for the full integration request. The more detailed disposition of PRs #1–#5,
remaining acceptance criteria and risks is in [integration status](docs/integration-status.md).
The [ADRs](docs/adr/README.md) are historical design decisions, not proof that
all proposed features are implemented or that their benchmark evidence remains valid.

## Data path

- **Partial — RV32IMA CPU and assembler.** `core/src/cpu` implements encoding,
  assembly, CPU state and the interpreter. `core/test/interp.test.ts` exercises
  instruction behavior; independent architecture-test and QEMU comparison remain
  outstanding. Full RV64 and a complete privileged architecture are unsupported.
- **Partial — region JIT.** `core/src/jit` constructs regions, emits WebAssembly
  and manages tiering. `core/test/jit.test.ts` compares several configurations
  with the interpreter, including trap retirement. `core/test/jit-divrem.test.ts`
  forces baseline and optimized generated code through division edge cases. These
  focused checks do not prove the whole translator correct. Paging and SMP use
  the interpreter instead of the JIT.
- **Experimental — MMU.** `core/src/mmu` provides a walker and TLB with targeted
  Sv32/Sv39 tests (`core/test/mmu.test.ts`). The CPU is RV32; this is not full
  Sv39/RV64, and privilege, delegation, permissions and wider physical addresses
  are incomplete. Out-of-range physical addresses are rejected, not truncated.
- **Experimental — SMP.** `core/src/smp` starts Node `worker_threads` with shared
  Wasm RAM and a reservation table. `core/test/smp.test.ts` covers LR/SC and AMO
  stress and the runtime timeout. All coordinated writes must pass through the
  channel; arbitrary host writes, generated code and devices are not coherent.
  Browser workers and coherent devices/IPIs are not implemented.
- **Partial — machine and memory.** `core/src/machine` connects RAM, interpreter,
  JIT, syscall and limited MMIO handling. `core/test/memory.test.ts` covers RAM
  bounds, physical-address rejection and control-page isolation. It is not an
  untrusted-guest security boundary; public typed views can still be modified by
  callers. `core/src/devices` contains a UART, CLINT and device bus, not a full
  virtio platform.
- **Partial — web.** `web/` builds a demo and `web/test/browser.ts` runs a
  cross-origin-isolated Chromium smoke test. It is not a complete browser host.
- **Planned / unsupported — host systems.** `host/src/index.ts` and
  `relay/src/index.ts` are placeholders. Durable OPFS storage, display/GPU,
  networking, relay, terminal, IWA, virtio and Debian boot are not implemented.
  No storage crash-consistency or network security claim follows from this branch.

## Measurement and verification

`npm ci`, `npm test`, `npm run lint`, `npm run build` and
`npm run test:browser` exercise the current implementation; the browser test
requires Chromium. `npm run bench` checks JIT workload observations before timing,
warmups are separate, and reports include individual samples, median and range.
Existing best-sample metrics and the optional local gate are historical and not a
validated cross-machine KPI. The 8086emu diagnostic does not establish equivalent
execution: its throughput ratios are suppressed. Hosted CI records benchmarks
without hardware-specific performance gates.

## Trust and concurrency boundaries

Guest inputs, devices, the loader and syscalls have not received a complete
security review. The SMP channel only coordinates accesses using that channel.
No browser persistence or remote network isolation guarantee exists. Do not run
untrusted guests or treat these prototypes as production infrastructure.
