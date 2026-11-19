# WasmNUX

Debian Linux in a browser tab. A RISC-V machine — CPU, MMU-less memory model,
CLINT/PLIC, virtio devices — emulated in WebAssembly, running a stock Debian
userland where `apt` works and the UI is a terminal.

The whole design is in [ROADMAP.md](ROADMAP.md). This repository is Phase 0: the
parts of that roadmap that had to be _measured_ before anything else could be
built.

```
npm install
npm test          # 288 tests
npm run bench -- --all
```

## Status

**Phase 0 — foundations and spikes.** Spike A (JIT feasibility) is done and its
answer is **GO**; ADR-0001…0013 are written; the benchmark harness, three
suites, a per-commit result store and a CI regression gate exist and run.

What is _not_ here yet: an MMU, privilege modes, a bootable kernel, virtio-blk,
networking, a terminal renderer. Those are Phase 1+ and each has an ADR saying
what it will take.

## What works today

A complete RV32IMA execution stack in TypeScript, differentially tested:

| layer          | where                          | what it does                                                         |
| -------------- | ------------------------------ | -------------------------------------------------------------------- |
| ISA            | `core/src/cpu/encoding.ts`     | RV32IMA encode/decode/disassemble, `Decoded` cache                   |
| Assembler      | `core/src/cpu/asm.ts`          | two-pass, labels, `.balign`, `.word`, constant folding, `--define`   |
| Interpreter    | `core/src/cpu/interp.ts`       | Tier 0, 1 IPC cycle model, `MachinePort` for MMIO/syscalls           |
| CFG recovery   | `core/src/jit/cfg.ts`          | basic blocks, mid-block truncation, loop headers, regions            |
| Translator     | `core/src/jit/codegen.ts`      | RV32IMA → Wasm, incl. atomics, LR/SC, precise faults                 |
| Wasm encoder   | `core/src/jit/wasm/encoder.ts` | module/function/memory/table/atomic emission from scratch            |
| Tiering engine | `core/src/jit/engine.ts`       | heat → compile → run → optimise, code cache, invalidation, tier-down |
| Memory         | `core/src/machine/memory.ts`   | one lazily-reserved `WebAssembly.Memory`, optional control page      |
| ELF            | `core/src/machine/elf.ts`      | ELF32-LE loader (EM_RISCV / EM_MIPS)                                 |
| Devices        | `core/src/devices/`            | UART, CLINT, PLIC, sifive_test finisher, device bus                  |
| Machine        | `core/src/machine/machine.ts`  | QEMU-`virt`-shaped machine, Linux syscall ABI, M-mode interrupts     |
| Benchmarks     | `benchmarks/`                  | harness, 3 suites, result store, gate, browser runner                |

## Numbers

Measured on Node 22 / V8, linux-x64, 2 vCPUs (a shared CI-class box). Guest
throughput in millions of instructions per second; full tables, methodology and
caveats in [`docs/spikes/spike-a-jit.md`](docs/spikes/spike-a-jit.md), raw
samples in `benchmarks/results/`.

|                         | interpreter | JIT (best config) |  speedup |
| ----------------------- | ----------: | ----------------: | -------: |
| ALU loop                |          59 |              3203 |  **54×** |
| memory copy             |          45 |              2901 |  **65×** |
| div/rem LCG             |          62 |              2491 |  **40×** |
| unpredictable branches  |          52 |              1181 |  **23×** |
| matrix scale            |          55 |              2472 |  **45×** |
| atomics (shared memory) |          43 |               637 |  **15×** |
| recursive fib(24)       |          42 |               285 | **6.8×** |
| UART polling            |          48 |                27 |    0.56× |

Against `8086emu` 1.5.1 — a Rust-to-Wasm RV32IM interpreter, used as the
"existing in-browser emulator" comparator from ROADMAP §4 — the JIT is
**6.8–14.8×** faster on the same guest bytes. The KPI was ≥3×. The interpreter
alone is 0.4× of it, which is the reason the JIT is not optional.

The last row is the interesting one: a device-polling loop is _slower_ compiled,
because every poll exits to the host. That is why the interpreter is a permanent
tier and why the engine tiers regions back down (§4.5 of the spike).

## Decisions

Every architectural decision is an ADR in [`docs/adr/`](docs/adr/README.md).
Four are Accepted on measured evidence from Spike A:

- [ADR-0001](docs/adr/0001-guest-isa.md) — riscv64, with RV32IMA built and measured first
- [ADR-0002](docs/adr/0002-execution-strategy.md) — three tiers; the interpreter is a tier, not a fallback
- [ADR-0003](docs/adr/0003-wasm-module-granularity.md) — one Wasm module per region, `br_table` dispatch inside it
- [ADR-0004](docs/adr/0004-guest-ram-model.md) — one shared 4 GiB lazily-reserved memory; no Memory64; register file in a control page
- [ADR-0013](docs/adr/0013-core-language.md) — TypeScript core (deviates from ROADMAP §2, with a Phase 1 review gate)

The rest are Proposed, each listing the spike that would settle it.

## Layout

```
core/          emulator core: ISA, assembler, interpreter, JIT, devices, machine
host/          host runtime (Phase 1+): vCPU workers, storage, display, net
relay/         wnx-relay (Phase 4+): network egress and signalling
benchmarks/    harness, suites, per-commit results, baselines, browser runner
docs/          ADRs, spikes, KPI reports
ROADMAP.md     the specification this repository implements
```

Workspaces are `core`, `host`, `relay`, `benchmarks`; Node ≥ 22.12. `web/` is
the dev server and demo page, not a workspace.

## Try it in a browser

```sh
npm run serve      # http://localhost:8080
```

`web/dev-server.ts` bundles the core with esbuild and serves a page that
assembles two guest programs, runs each interpreted and through the JIT, and
prints throughput, engine counters and whether the two engines agree. It sets
COOP/COEP, so `SharedArrayBuffer` — and therefore shared guest RAM and Wasm
atomics — actually exist there (ADR-0010), and it says so on the page when they
do not. The compute path is DOM-free and tested in Node (`web/test/demo.test.ts`).

## Commands

```sh
npm test                                  # vitest, 288 tests
npm run test:watch
npm run lint                              # prettier --check + tsc
npm run format

npm run bench -- --all                    # measure every suite
npm run bench -- --suite jit --reps 3
npm run spike -- a                        # the suites tagged for Spike A
npm run bench:record -- --all --baseline  # write results/ and refresh baselines/
npm run bench:gate -- --suite jit         # regression gate vs baselines/ (exit 1 on >20%)
npm run report -- --md                    # render the latest results as markdown
npm run bench:browser -- --suite jit,wasm # the same suites in a real browser
npm run serve                             # browser demo on :8080 (COOP/COEP)
```

`npm run bench -- --help` lists every flag. The browser runner needs a Chromium
binary: `npx playwright install chromium`, or point `WNX_BROWSER` at one.

## Testing

Correctness is differential, not by inspection. `core/test/jit.test.ts` runs a
corpus of programs — ALU loops, all seven AMOs, LR/SC success and both failure
modes, a CAS retry loop, division corners, calls and indirect jumps, every
load/store width, MMIO, CSR, nested loops — under **eight** JIT configurations
and requires identical registers, guest RAM, stop reason, `minstret`, and MMIO
read counts versus the interpreter. `benchmarks/suites/*.verify()` runs the same
check before any timing, so a suite whose variants disagree refuses to measure.

Not yet covered, and tracked as such: `riscv-tests`, `riscv-arch-test`, QEMU-TCG
differential fuzzing, and browser-engine runs. All four need tooling this
sandbox does not have; all four are CI work in Phase 1.

## Licence

Apache-2.0 — see [LICENSE](LICENSE) and [ADR-0011](docs/adr/0011-licensing.md).
Debian's contents (kernel, glibc, the archive) are distributed under their own
terms and are never linked into this code.

Contributing: [CONTRIBUTING.md](CONTRIBUTING.md).
