# Spikes

Phase 0 exists to kill the biggest risks before building the real thing
(ROADMAP §5). Each spike is a _question with a budget_, not a feature: it ends
in a go/no-go, a set of numbers, and amendments to one or more ADRs. Code written
for a spike is production code where it survives — the JIT that Spike A produced
is `core/src/jit`, not a throwaway — and is deleted where it does not.

| Spike                                     | Question                                                                                  | Settles                      | Status        |
| ----------------------------------------- | ----------------------------------------------------------------------------------------- | ---------------------------- | ------------- |
| [**A — JIT feasibility**](spike-a-jit.md) | Can hot guest code be translated to Wasm fast enough, and correctly?                      | ADR-0001/0002/0003/0004/0013 | **done — GO** |
| B — SMP                                   | Do N vCPU workers on one shared memory scale, and do guest atomics map onto Wasm atomics? | ADR-0004, ADR-0002           | not started   |
| C — Storage                               | Is OPFS fast and durable enough to be a block device?                                     | ADR-0005                     | not started   |
| D — Display + GPU                         | Which GPU path, and what does scanout cost?                                               | ADR-0007, ADR-0009           | not started   |
| E — Network                               | Which transport, and which user-space stack?                                              | ADR-0008                     | not started   |
| F — Terminal                              | Can a WebGPU renderer hit the frame budget and Unicode?                                   | ADR-0009                     | not started   |

## What a spike report must contain

Spike A is the template:

1. **The question**, quoted from the ROADMAP, with the KPI it is supposed to
   satisfy.
2. **What was built**, with file paths, so the code can be reviewed as part of
   the answer.
3. **Results** as tables of measured numbers, with the environment (runtime,
   engine, CPU count, OS) stated, because every number here is host-dependent.
4. **Findings**, including the ones that contradict the plan. Spike A's §4.5
   ("compiled code is not automatically better") and §4.2 ("the register file
   belongs in guest memory") both overturned assumptions the ROADMAP had already
   written down.
5. **What was _not_ measured**, explicitly. A spike that does not list its gaps
   gets read as a proof.
6. **Decisions it feeds**, per ADR.
7. **Follow-ups** as checkboxes, and **reproduction commands**.

Numbers in a spike report come from a committed result file under
`benchmarks/results/`, and the report names the file. A number that cannot be
reproduced by a committed command does not go in the report.

## Running the spikes

```sh
npm install
npm test                                  # 255 tests: 242 core + 13 harness
npm run spike -- a                        # the benchmark suites tagged for Spike A
npm run bench -- --all                    # every suite
npm run bench:record -- --all --baseline  # write results/ and refresh baselines/
npm run bench:gate -- --suite jit         # CI regression gate
npm run bench:browser -- --suite jit,wasm # same suites in a real browser (needs Chromium)
```

`npm run bench -- --help` lists every flag. Suites are registered in
`benchmarks/suites/index.ts`; a new spike adds a suite there and tags itself.

### Environment caveats that apply to every number in this directory

- All Phase 0 numbers so far are **Node/V8 on a 2-vCPU shared Linux box**.
  Browser engines compile Wasm differently; Spike A's §4.2 finding in particular
  (control-page register file beats imported globals) must be re-measured in
  Chromium, Firefox and WebKit before it is treated as settled.
- **No Chromium in the sandbox**, so the browser path is built and unit-tested
  but unexercised end to end. CI runs it.
- **No RISC-V toolchain, no QEMU**, so `riscv-tests`, `riscv-arch-test` and the
  QEMU-TCG differential oracle are CI-only. Local correctness is differential
  against our own interpreter plus an independent model of each workload.
- **Memory64 validates but does not run** in Node 22, which is why ADR-0004 does
  not use it.
- Timing on a shared 2-vCPU box is noisy: the harness keeps sampling until the
  fastest sample is at least 20 ms (up to 25 repetitions), and the gate's 20%
  tolerance is calibrated against that. A single short measurement here is not
  evidence of anything.
