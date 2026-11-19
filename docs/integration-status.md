# Integration status — work in progress, not merge-ready

## 1. Executive summary

The integration uses the RV32 TypeScript emulator and benchmark harness from
PR #5 as its foundation. It adds an experimental walker inspired by the MMU
work in PR #4, and a Node worker prototype informed by PR #3. This is **not** a
complete implementation of the original integration request. It must remain a
draft until the gaps below are addressed and reviewed.

## 2. Architecture and implementation status

| Area                                               | Status                 | Evidence and limitations                                                                                                                                                                                                                                              |
| -------------------------------------------------- | ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| RV32IMA interpreter, assembler, JIT                | Partial                | `core/src/cpu`, `core/src/jit`; differential corpus exists, but counter mismatches remain.                                                                                                                                                                            |
| Sv32 walker / TLB                                  | Experimental           | `core/src/mmu`, `core/test/mmu.test.ts`; no complete privileged CPU, trap delegation, SUM/MXR, or JIT translation. 34-bit physical addresses are rejected rather than aliased.                                                                                        |
| Sv39 walker                                        | Experimental / partial | Some superpage cases are tested; RV64 CPU and full-width virtual/physical address support are not implemented.                                                                                                                                                        |
| SMP                                                | Experimental           | `core/src/smp` runs interpreter harts in Node workers with shared RAM and a reservation table; tests cover atomic increments, LR/SC lock, and invalidation. Device state, host memory writes, IPIs, WFI coordination, browser workers and JIT SMP are not integrated. |
| Host, OPFS, display, network, relay, terminal, IWA | Planned / unsupported  | `host` and `relay` remain placeholders; no production subsystem from the other PRs has been integrated.                                                                                                                                                               |
| Browser                                            | Partial                | Demo exists; tests in `web/test` run in Node, not an actual browser.                                                                                                                                                                                                  |
| Debian/kernel/virtio                               | Unsupported            | No bootable guest environment.                                                                                                                                                                                                                                        |

MMU privilege is currently a manually configured walker property, not a complete
RISC-V privilege architecture. Cross-hart atomicity only applies when all writes
are routed through the interpreter and the same `SmpChannel`; direct host or
JIT memory accesses bypass the channel. Do not use this for untrusted guests.

## 3. PR-by-PR disposition

- **#1**: spike prototypes and ADR skeleton audited; not incorporated as a
  second competing runtime.
- **#2**: OPFS, GPU, relay, web isolation and host prototypes audited; not
  integrated without a full correctness and persistence review.
- **#3**: SMP and benchmarking prototypes audited; worker and atomics design
  informed the new experimental runtime. DNS/TCP/IP and vendored benchmarks are
  not integrated.
- **#4**: page-table and concurrency primitives audited; the walker and tests
  incorporate the superpage and fetch-translation ideas, not the duplicate CPU.
- **#5**: selected as the core/JIT, tests, benchmark harness, ADR and workspace
  foundation. Its host and relay packages are placeholders.

## 4. Discarded/deferred approaches

The other PRs' duplicate CPU implementations and host prototypes are deferred,
not represented as integrated features. Audit findings include storage journal
interleaving and DNS compression cycles; avoiding those prototypes does not
constitute a production storage or networking implementation.

## 5. Fixes and unresolved correctness work

Tests cover physical composition for selected Sv32/Sv39 superpages, fetch
translation, legal `sfence.vma` operands, faulting `mepc`, unretired faulting
instructions, invalid R/W PTEs, physical address wrap rejection, LR/SC
invalidation and interpreter AMOs. Regression coverage is in `core/test/mmu.test.ts`,
`core/test/smp.test.ts` and `core/test/interp.test.ts`.

**Still required:** comprehensive JIT division/remainder and counter fixes;
full-width RV64 addresses and PCs; full privileged architecture; storage
crash-consistency; bounded copies and buffers; cyclic DNS pointers; branch and
assembler range checks; thorough independent SMP/AMO stress tests; additional
MMU fault, permission, TLB and JIT interactions. The current test results do not
prove these are correct. A sliced nested-loop regression exposed and fixed a JIT block-order retirement
accounting error. After the fix, a one-sample JIT benchmark showed matching
counts for memory-copy, matrix and calls, but device-poll still differed
(interpreter 100007, JIT globals/trap 100001); further investigation is required.

## 6. Compatibility changes

The machine keeps the original RV32 execution API. Paging uses an interpreter
fallback. The Node SMP runtime creates a separate machine per hart and does not
claim browser support. The active Arena branch name is fixed and differs from
the originally requested branch name.

## 7. Test results

See the PR description for the latest run. The project currently has **no**
`test:browser` or `build` npm scripts; attempts to run them fail with “Missing
script”. `web/test` runs in Node and is not a substitute for browser testing.

## 8. Benchmark results

`npm run bench` ran on Node 22.22.3, Linux x64, 2 vCPUs on a dirty checkout on
2026-11-19. It printed best-of-sample results with reported sample spreads as
high as 1017%, and different retired counts for several JIT variants. A later
`--suite jit --reps 1` run after the block-order fix still showed a device-poll
count mismatch; it was run concurrently with tests and is not a clean performance
measurement. These numbers are **not** accepted as validated KPIs. No browser benchmarks were
run. A reproducible, warmed multi-sample run with median and dispersion, a
separate validation phase, and matching architectural counters is still needed.

## 9. Risks and limitations

This is not a full Linux machine or a security boundary. No OPFS crash recovery,
real network/relay security, browser SMP, or full RISC-V privileged ISA has been
validated. Earlier ADRs and Phase 0 reports are historical, not evidence of
these missing capabilities. Do not merge on the strength of the passing unit
suite alone.

## 10. Roadmap

Resolve the correctness gaps with regression tests; integrate and test one
implementation per host subsystem; add a real browser suite and build; run
clean-install/security and reproducible benchmark validation; update ADRs and
subsystem docs to match the actual architecture; obtain independent review
before considering merge.
