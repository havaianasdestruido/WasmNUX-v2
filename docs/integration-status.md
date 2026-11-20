# Integration status — partial follow-up, draft required

## Starting point

GitHub reported PR #6 **MERGED**, merged at 2026-11-20T16:27:40Z with commit
`27b89e622eb8c474629d4b8351529a4c32b16bd7`. This session's
`arena/a4978d81-wasmnux-v2` started at that exact commit; ancestry was checked.
PRs #1–#5 and their review comments were consulted, not merged or closed.

This follow-up does **not** complete the requested integration. The substantial
remaining work is implementation work, not merely missing credentials or a test
runner. Keep the PR draft; no kernel or Debian boot has been executed.

## Current status

| Area                                       | Status                  | Evidence / remaining work                                                                                                                                                                                                                                    |
| ------------------------------------------ | ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| RV32 CPU, assembler, JIT                   | Partial                 | Existing differential, DIV/REM, budget, trap, assembler and memory suites pass; no independent architecture conformance run.                                                                                                                                 |
| RV64 / full privileged CPU                 | Not supported           | Still RV32 registers/PCs; no complete S/U modes, delegation, CSR legality or RV64 assembler/decoder/JIT.                                                                                                                                                     |
| MMU                                        | Experimental            | Sv32 and low-32-bit Sv39 walker; new high-address rejection, reserved PTE, access-fault, SUM/MXR and TLB-hit permission tests. SUM/MXR are walker properties, not status CSR integration. Full Sv39 addresses remain unsupported.                            |
| SMP                                        | Experimental            | One interpreter hart entry shared by Node and browser transports. Real browser four-hart AMO/LRSC stress. JIT, shared devices/IPIs and WFI remain absent. Explicit host writes and syscall input now share the reservation barrier; raw views remain unsafe. |
| OPFS snapshots                             | Experimental            | Real bounded atomic whole-file replacement, Web Locks, worker failure and concurrency tests. A bounded transactional sector backend is now layered on snapshots; still not a guest disk, chunk overlay or durability proof.                                  |
| Browser                                    | Partial                 | Builds demo and hart worker; tests demo, SMP and OPFS in Chromium. No Firefox/Safari evidence.                                                                                                                                                               |
| Display/GPU, terminal, network, relay, IWA | Planned / not supported | No operational implementations added. DNS pointer cycles are not an active parser surface because there is no DNS parser.                                                                                                                                    |
| Virtio, kernel, Debian                     | Not supported           | No bootable guest environment or boot claim.                                                                                                                                                                                                                 |

## Prototype disposition after reviewing current diffs and comments

- **#1:** retain the existing design history, not a second CPU/host API. Reviewed
  storage metadata, GPU ring and glyph-slot findings. Current COW code still
  has fixed metadata capacity and in-place update concerns; no format imported.
- **#2:** actual OPFS worker/probe ideas informed browser tests. The inspected
  block backend writes chunks in place and assumes a serialized caller; it is
  not used as a transactional snapshot backend. GPU/relay prototypes are deferred,
  not called production-ready. The SMP timing comment has a recorded fix.
- **#3:** SMP ideas already inform the base. Its reviewed fresh-slot COW revision
  addresses the earlier overwrite finding, but explicitly never reclaims arena
  slots and bounds its map in one metadata sector. It is not copied into this
  snapshot API. RV64 prototype/JIT and network code are not imported; their
  wider-address/DIV and DNS findings need independent end-to-end review.
- **#4:** keep the base's selected MMU/reservation design, now harden it. The
  current chunk-store diff serializes writes (the older review finding was fixed),
  but that is not full disk integration or proof of bounded journal recovery.
  No duplicate CPU, chunk store or echo network stack is incorporated.
- **#5:** remains the core/workspace/JIT/benchmark foundation selected by #6.
  The GitHub full-diff endpoint exceeded its line limit; the incorporated source
  and tests are available in this checkout. No second implementation is added.

## Mandatory audit checklist

- Workspace/lockfile: clean `npm ci` passes; no new runtime dependencies.
- Persistence: added failure-before-publication/reopen and real worker kill
  tests; physical crash, eviction, quota-exhaustion and guest fsync remain open.
- Address/copy bounds: memory tests retained; MMU no longer narrows a high VA to
  low RAM or exposes a truncated root table. Full RV64 remains unimplemented.
- DIV/REM, retirement and JIT budgets: existing BigInt-oracle and differential
  regressions retained and rerun. No claim of exhaustive correctness.
- LR/SC/AMOs: same channel in both transports; real browser contention added.
  Direct host writes and per-hart device coherence remain blockers.
- DNS cycles / packet buffers: no network parser incorporated; network security
  and relay resource budgets remain unimplemented, not considered solved.
- LUI, branches, relocations: existing assembler regressions retained and rerun.
- MMU fetch/superpages/mepc/sfence: existing regressions retained; reserved PTE,
  page-table access-fault and permission-cache regressions added.

## Compatibility and security

See [host runtime](host-runtime.md) for limits, API examples and publication
semantics. Node SMP public types are re-exported from their previous location.
MMU `invalidateVpn` and `rootTable` now throw RangeError for unsupported widths;
`translate` returns a fault with the original tval, rather than silently aliasing.
Callers must pass unsigned RV32 addresses and handle failure, not mask a wider
address to make it pass. Inaccessible page-table memory now returns an access
fault instead of a page fault. The interpreter's supported valid-address API
is unchanged. None of this is an untrusted-guest security boundary.

## Verification

See [follow-up verification](follow-up-verification.md) for exact commands,
environment, results and measurement limitations. The full requested integration
still requires RV64/privileged CPU, full MMU/JIT, coherent system SMP, a real guest
disk, display/network/relay/terminal/IWA, virtio and validated kernel boot.

## Continuation after review

- Fixed the reviewed unaligned RAM-base acceptance in a shared validator used by
  Node and browser; tests include the exact reported input and successful execution
  from a word-aligned non-page-aligned base. Node page rounding remains supported.
- Added OPFS sector backend with whole-image atomic read-modify-write and explicit
  create/open, bounded geometry, corruption rejection, discard and real concurrent
  browser tests. SnapshotStore now limits outstanding work and supports updates.
- Added coordinated `Machine.writeHostBytes` and routed syscall input through it;
  tested cross-hart LR/SC invalidation including ABA, copy bounds and JIT patches.
  Read/write syscall work is capped at 64 KiB per instruction (retry partial I/O).
- Hardened ELF input validation and validate-before-write loading; SMP uses e_entry.
  Removed incorrect EM_MIPS acceptance; only static ELF32 RISC-V RV32IMA is accepted.
- Prior CI for 29a51a8 passed all jobs; it is evidence for that earlier revision,
  not proof of completeness of this continuation. The revised verification is in
  the follow-up report. Full requested functionality remains incomplete.

Review automation also supplied commit `70ba343` with 65 additional MMU/SMP/OPFS
tests. These were merged into the continuation, not discarded during single-
commit consolidation. Combined local suite: 465 tests across 24 files.
