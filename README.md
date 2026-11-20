# WasmNUX

The goal is Debian Linux in a browser tab. This repository is an experimental
RISC-V emulator foundation; it does **not** yet boot Debian or provide virtio
devices, a network stack, persistent storage, or a terminal renderer.

The whole design is in [ROADMAP.md](ROADMAP.md). This repository is Phase 0: the
parts of that roadmap that had to be _measured_ before anything else could be
built.

```
npm ci
npm test
npm run bench -- --all
```

## Status

**Integration in progress — not ready to merge.** The RV32 interpreter and
JIT are the foundation, with an experimental page-table walker and Node-only
SMP worker prototype. Privilege modes and the host subsystems are not complete.
See [integration status](docs/integration-status.md) for evidence and blockers.

## What works today

An RV32IMA prototype in TypeScript, with differential tests (not a complete
privileged architecture implementation):

| layer          | where                          | what it does                                                         |
| -------------- | ------------------------------ | -------------------------------------------------------------------- |
| ISA            | `core/src/cpu/encoding.ts`     | RV32IMA encode/decode/disassemble, `Decoded` cache                   |
| Assembler      | `core/src/cpu/asm.ts`          | two-pass, labels, `.balign`, `.word`, constant folding, `--define`   |
| Interpreter    | `core/src/cpu/interp.ts`       | Tier 0, 1 IPC cycle model, `MachinePort` for MMIO/syscalls           |
| CFG recovery   | `core/src/jit/cfg.ts`          | basic blocks, mid-block truncation, loop headers, regions            |
| Translator     | `core/src/jit/codegen.ts`      | RV32IMA → Wasm; fault and counter correctness under review           |
| Wasm encoder   | `core/src/jit/wasm/encoder.ts` | module/function/memory/table/atomic emission from scratch            |
| Tiering engine | `core/src/jit/engine.ts`       | heat → compile → run → optimise, code cache, invalidation, tier-down |
| Memory         | `core/src/machine/memory.ts`   | one lazily-reserved `WebAssembly.Memory`, optional control page      |
| ELF            | `core/src/machine/elf.ts`      | ELF32-LE loader (EM_RISCV / EM_MIPS)                                 |
| Devices        | `core/src/devices/`            | UART, CLINT, PLIC, sifive_test finisher, device bus                  |
| Machine        | `core/src/machine/machine.ts`  | QEMU-`virt`-shaped machine, Linux syscall ABI, M-mode interrupts     |
| Benchmarks     | `benchmarks/`                  | harness, 3 suites, result store, gate, browser runner                |

## Numbers

Historical Phase 0 samples are in `benchmarks/results/` and the original spike
notes. Regression tests now cover the observed JIT retirement mismatch in device
polling; the benchmark preflight also checks retired counts and MMIO effects.
Earlier measurements showed high sample spread. Do not treat its speedups
as correctness-validated or compare them across hosts. See
[integration status](docs/integration-status.md).

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
npm test                                  # vitest tests
npm run test:watch
npm run build                             # browser demo only, output in dist/web
npm run test:browser                      # Chromium demo smoke test (requires Chromium)
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
binary: `npx playwright-core install chromium`, or point `WNX_BROWSER` at one.

## Testing

Correctness is differential, not by inspection. `core/test/jit.test.ts` runs a
corpus of programs — ALU loops, all seven AMOs, LR/SC success and both failure
modes, a CAS retry loop, division corners, calls and indirect jumps, every
load/store width, MMIO, CSR, nested loops — under **eight** JIT configurations
and requires identical registers, guest RAM, stop reason, `minstret`, and MMIO
read counts versus the interpreter. The JIT benchmark preflight also checks stop reason, retired count, and MMIO
read/write counts; it is not a substitute for full architectural comparison.

Not yet covered, and tracked as such: `riscv-tests`, `riscv-arch-test`, QEMU-TCG
differential fuzzing, and browser-engine runs. All four need tooling this
sandbox does not have; all four are CI work in Phase 1.

## Licence

Apache-2.0 — see [LICENSE](LICENSE) and [ADR-0011](docs/adr/0011-licensing.md).
Debian's contents (kernel, glibc, the archive) are distributed under their own
terms and are never linked into this code.

Contributing: [CONTRIBUTING.md](CONTRIBUTING.md).
