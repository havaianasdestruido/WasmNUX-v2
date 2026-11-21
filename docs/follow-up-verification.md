# Follow-up verification — 2026-11-20

## Environment and commands

Node 22.22.3, npm 10.9.8, Linux x64, 2 CPUs, 3940 MiB reported RAM.
Chromium 153.0.8010.0 (headless) supplied through `@sparticuz/chromium` in a
**temporary directory outside the repository**, not added to dependencies.
The first browser launch failed because this sandbox lacked `libnspr4.so`.
Extracting the package's bundled AL2023 libraries resolved that failure.
No credentials, browser binary, guest image or temporary dependencies are committed.
The restricted outbound hosts precluded the normal Playwright CDN installation;
CI retains its regular `playwright-core install --with-deps chromium` path.

| Command                                                                          | Actual result                                                                                        |
| -------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `npm ci`                                                                         | Pass, workspace/lockfile unchanged                                                                   |
| `npm run lint`                                                                   | Pass (Prettier and TypeScript)                                                                       |
| `npm test`                                                                       | Pass, 465 tests in 24 files                                                                          |
| `npm run build`                                                                  | Pass, browser demo and module hart worker bundled                                                    |
| `LD_LIBRARY_PATH=/tmp/al2023/lib WNX_BROWSER=/tmp/chromium npm run test:browser` | Pass, Chromium 153.0.8010.0, isolation + demo + OPFS failures/concurrency + SMP stress/error/timeout |
| `npm run bench`                                                                  | Pass, all default suites, 29.4 s measurement total in the final run                                  |
| `npm audit`                                                                      | Pass, 0 vulnerabilities reported (not a security proof)                                              |
| `git diff --check`                                                               | Pass                                                                                                 |

Browser correctness tests are part of the existing blocking `browser-test` CI
job, not the advisory browser benchmark job. No test was skipped or disabled.
The browser host stress tests are correctness tests, not performance claims.

## Reproducible measurement evidence

Additional recorded runs:

```sh
npx tsx benchmarks/src/cli.ts run --suite jit --reps 5 --json
LD_LIBRARY_PATH=/tmp/al2023/lib WNX_BROWSER=/tmp/chromium \
  npm run bench:browser -- --suite wasm --reps 5 --out browser-report.json
```

Raw samples, runtime/browser versions, Wasm capabilities and environment:

- `benchmarks/results/20261120-followup-jit.json`
- `benchmarks/results/20261120-followup-browser.json`

The refreshed files record previous PR revision `29a51a8` **with dirty=true**:
measurements were taken on this continuation before amending the single requested
commit. They are not measurements of pristine main or of pristine `29a51a8`. One untimed warm-up per variant,
at least five samples; Node sampling adapts up to 25. JIT workload preflight
compares results, stop reasons, retirement and MMIO counts before timing.
It does not replace independent architectural validation.

Selected measurements from the recorded runs (not the earlier stdout-only run):

| Runtime / workload / variant              | Samples | Median ms |      Min–max ms | Range / median |
| ----------------------------------------- | ------: | --------: | --------------: | -------------: |
| Node / arith-loop / interpreter           |       5 |   246.457 | 244.648–248.064 |           1.4% |
| Node / arith-loop / jit globals/trap      |      25 |     9.211 |    8.531–13.170 |          50.4% |
| Node / device-poll / interpreter          |      25 |     5.182 |    4.585–11.437 |         132.2% |
| Node / device-poll / jit globals/trap     |      25 |    10.546 |    8.933–14.956 |          57.1% |
| Chromium / atomics-micro / micro x1000000 |       5 |    39.140 |   38.660–41.150 |           6.4% |

Dispersion is high: do not treat these as a portable KPI or a before/after
speedup. The browser micro case is a bundle of host/Wasm atomic measurements,
not guest SMP scaling, and is not comparable to the Node guest workloads.
Legacy best-sample fields remain in the raw schema; use medians and individual
samples. The unverified 8086emu diagnostic from the default suite is not an
oracle and no relative-performance claim is made for it. No hardware baseline
was updated and no hardware-specific CI gate was introduced.

## Explicit missing evidence and acceptance blockers

- No complete RV64 or privileged CPU, full-width Sv39 or translated JIT.
- No independent RISC-V architecture tests or QEMU differential fuzzing.
- No shared system devices or IPI/WFI. Explicit host writes/syscall input now
  invalidate shared reservations; arbitrary raw host/DMA accesses remain unsafe.
- No guest block device, power-loss durability, eviction or physical quota tests.
- No production display/GPU, terminal, network/relay or signed IWA.
- No virtio platform or executed kernel/Debian boot.
- No Firefox/Safari coverage or new-subsystem performance characterization.

These are substantive missing features/evidence. The PR must remain draft,
not be merged based only on the passing tests.

## Continuation verification

The same command matrix above was rerun after the review fix, bounded sector
backend, snapshot admission/update API, host-memory barrier, syscall bounds and
ELF loader changes. Current local result: **465 tests, 24 files**, all commands
successful. Real Chromium coverage includes eight sector writers updating distinct
sectors of one disk and terminating a staged overwrite before publication.
Node tests execute a synthetic ELF in two real hart workers with e_entry distinct
from the flat-image placement option. This is not evidence of kernel boot.

The earlier PR revision had all GitHub CI jobs green (lint, test, bench,
browser-test, browser and CodeRabbit). New checks must be evaluated against the
amended head, not inferred from that earlier result. No CPU cross-compiler or
QEMU RISC-V executable was found in this sandbox's PATH; independent guest
conformance/boot verification was not performed. Missing production subsystems
remain implementation blockers regardless of tooling availability.

The remote review-test commit `70ba343` arrived during this continuation. Its
MMU/SMP/snapshot tests were incorporated intact (the snapshot conflict was
resolved by retaining both test groups). Validation error messages remain
compatible with those tests. The combined suite passes 465 tests in 24 files.
The final single-commit consolidation retains CodeRabbit co-authorship; no
remote test additions were overwritten. Benchmark samples precede these test-only
additions and the validation-message wording adjustment, not the implementation.
