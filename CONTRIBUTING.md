# Contributing

WasmNUX is Phase 0: an emulator core, a benchmark harness, and a set of
decisions. [ROADMAP.md](ROADMAP.md) is the specification; [`docs/adr/`](docs/adr/README.md)
records what has been decided and why. Read the ADR that covers the area you are
changing before changing it — several of them exist because a plausible-looking
alternative was measured and lost.

## Setup

```sh
nvm use            # Node >= 22.12, see .nvmrc
npm ci             # workspaces: core, host, relay, benchmarks
npm test           # unit and differential tests
npm run lint       # prettier --check + tsc --noEmit
```

There is no build step for development: everything is TypeScript executed
directly by `vitest` and `tsx`, with `.ts` extension imports (Node's ESM
resolver requires the extension, and `allowImportingTsExtensions` is on).

## Before you open a PR

1. Run `npm ci`, `npm run lint`, `npm test`, `npm run build`,
   `npm run test:browser`, `npm run bench`, `npm audit`, and `git diff --check`.
   Browser tests require Chromium (`WNX_BROWSER` can select an installed binary)
   and exercise actual OPFS and module workers, not mocks alone.
2. Benchmark results must pass verification before timing, include warm-up and
   multiple samples, and report median and dispersion plus environment. Do not
   regenerate a baseline to hide a regression or use hardware-specific baselines
   as hosted CI gates. The optional local gate is diagnostic only.

3. New behaviour gets a test in the same PR. For anything in the JIT, that test
   should be **differential** — run it interpreted and run it compiled, compare
   architectural state — not an assertion about the JIT's internals.
4. If your change contradicts an ADR, the PR updates the ADR. Superseding a
   decision is a normal thing to do here; silently diverging from one is not.

## How this codebase is organised

- **`core/src/cpu/`** — the ISA. `encoding.ts` is tables and decode; `asm.ts` is
  the assembler used by every test and benchmark; `state.ts` is `CpuState` and
  the exit/cause/CSR constants; `interp.ts` is the Tier-0 interpreter.
- **`core/src/jit/`** — `cfg.ts` recovers blocks and regions, `codegen.ts`
  translates a region to Wasm, `engine.ts` owns tiering and all state
  synchronisation, `regfile.ts` is the register-file layout, `wasm/encoder.ts`
  emits module bytes, `wasm/features.ts` probes the runtime.
- **`core/src/machine/`** — `memory.ts` (one `WebAssembly.Memory`, ADR-0004),
  `elf.ts`, `machine.ts` (devices + syscall ABI + interrupts).
- **`core/src/devices/`** — UART, CLINT, PLIC, sifive_test, and the bus.
- **`benchmarks/`** — `src/harness.ts` measures, `src/store.ts` persists and
  gates, `suites/*` are the workloads.
- **`web/`** — the dev server (`npm run serve`), the browser demo, the static
  build published to GitHub Pages (`npm run build`, `web/build.ts`), and
  `web/coi-serviceworker.js`, which gives static hosts the COOP/COEP headers
  they cannot send (ADR-0010). The demo's compute path is in `web/demo.ts` and
  has no DOM dependency, so it is tested in Node; `web/main.ts` is only
  rendering. Asset URLs in `web/index.html` must stay relative: GitHub Pages
  serves the demo from `/<repo>/`, not from the origin root.

Browser-reachable core, host and web modules may not import Node built-ins.
The Node SMP transport (`core/src/smp/runtime.ts`, `worker.ts`) is explicitly
Node-only; shared `hart.ts` must remain browser-safe. Web build/test tooling and `benchmarks/src/store.ts` and
`cli.ts` may (they are the Node-side tools); `benchmarks/src/harness.ts` and
`browser-entry.ts` may not, because the same harness runs inside a browser
bundle. That constraint is what makes `npm run bench:browser` possible and it is
easy to break by accident — if you need host information, inject it
(`withHostInfo`) rather than importing `node:os`.

## Rules that exist because of bugs

These are all load-bearing. Each one is a defect that was found, fixed, and
tested; the comment in the code says which.

- **Retire accounting lives in `engine.ts` exactly once.** Blocks charge their
  instruction count up front; the host corrects on the way out. A second
  `cpu.instret++` anywhere double-counts, and `retireCorrection()` going
  negative means an exit path charged a budget the region never reported.
- **After the JIT hands control back, `cpu` is authoritative.** Pushing the
  register file back into the engine re-executes one instruction — which reads an
  MMIO register twice and rewinds an `ecall` pc. The single exception is the
  "no compiled successor" branch, where the register file is ahead of `cpu`.
- **Retiring a region must not decline its pcs.** Declining a pc is for code the
  engine has decided never to compile; retiring is for code that must be
  recompiled. Conflating them permanently downgraded a UART polling loop and
  livelocked the machine.
- **Truthiness dispatch on funct tables drops encodings.** `funct3 === 0` is
  `lb`, `sb`, `beq`, `addi`. Always compare `!== undefined`.
- **`blt`/`bne`/`beq` take registers only**; `addi` immediates are 12 bits;
  a branch or jump target must be word-aligned (`.balign 4` around data). The
  assembler's error messages name the line — read them.
- **Straight-line code never gets hot.** Heat accrues on control transfers, so a
  benchmark asserting `jitInstructions > 0` on a straight-line program is
  asserting something false.
- **Never trust a JIT number without checking `jitInstructions > 0`** _and_ that
  the retire count equals the interpreter's. Phase-lock bugs produce beautiful
  throughput for code that never ran.

## Benchmarks

Suites are registered in `benchmarks/suites/index.ts` and tagged with the spike
they produce evidence for (`npm run spike -- a`). A suite has cases, a case has
variants, and **the first variant is the reference** that speedups are computed
against.

A case may declare a `verify()` that runs before any timing. Use it: a benchmark
whose variants disagree is measuring a bug, and the harness refuses to time it.

Sampling is adaptive. `--reps` is a _minimum_; the harness keeps sampling until
the fastest sample is at least 20 ms, up to 25 repetitions, because a 3 ms
measurement on a shared runner is mostly noise. `--quick` opts out for
iteration. Baselines live in `benchmarks/baselines/` and are host-specific —
record them on the machine (or CI runner class) that will enforce them.

Two known-noisy situations:

- **Do not compare across hosts.** `benchmarks/results/` files record the
  environment (runtime, CPUs, memory, git commit, Wasm feature probes) for
  exactly this reason.
- **A gate failure on a loaded machine is usually noise.** Re-run before
  believing it. If a case is genuinely bimodal, give it a per-row `tolerance`
  rather than widening the global one.

Results are data, not prose: `npm run report -- --md` renders the latest result
file, and numbers quoted in a document should name the result file they came
from.

## Style

Prettier enforces the format (`printWidth` 110, single quotes, trailing commas);
`npm run format` fixes it. There is no ESLint: `npm run lint` is
`prettier --check` plus `tsc --noEmit`, and the type checker is strict
(`noUncheckedIndexedAccess` included), so most of what a linter would catch is
already an error.

Comments explain **why**, and name the measurement or the bug that motivated the
line. This codebase has a lot of them for that reason: several decisions look
arbitrary until you know what the alternative measured.

Commits are conventional-ish (`feat(core/jit):`, `fix(benchmarks):`,
`test(core):`) and scoped to one logical change. Do not commit
`benchmarks/results/` churn from local runs unless the numbers are being cited.

## Licensing

Everything here is Apache-2.0 ([ADR-0011](docs/adr/0011-licensing.md)). By
submitting a PR you agree to license your contribution under the same terms.
Dependencies must be permissively licensed (Apache-2.0, MIT, BSD, ISC, Unicode);
GPL code belongs in the guest image, not in this repository, and GPL _benchmark
comparators_ must stay devDependencies that are never shipped.

## What is genuinely open

Good first contributions, in rough order of size:

- CI jobs for `riscv-tests` and `riscv-arch-test` (needs a RISC-V toolchain in
  the runner; the differential harness to compare against already exists).
- The browser benchmark run in CI (needs `npx playwright install chromium`),
  which is the first step to answering whether Spike A's configuration ranking
  holds outside V8-in-Node.
- A return-address inline cache for `jalr`/`ret` — `calls` reaches only 6.8×
  because every return exits to the host (spike §4.4).
- `CpuState.regs` as a view onto the control page, removing ~64 property
  accesses per host transition (spike §4.2).
