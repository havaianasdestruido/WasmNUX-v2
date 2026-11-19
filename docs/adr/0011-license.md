# ADR-0011: License — Apache-2.0 core; GPL isolated; CoreMark AUP honored

## Status

accepted

## Date

2026-11-19

## Context

WasmNUX ships (a) its own emulator core and host runtime, (b) Debian guest
images and their GPL/LGPL components (kernel, glibc, firmware), (c) vendored
benchmark suites, (d) future optional kernel/mesa components. One license for
everything is not viable and not desirable:

- The **emulator core** should be maximally embeddable (ROADMAP goal 6 —
  `@wasmnux/core` for other sites): copyleft on the core would block adoption.
- **The Linux kernel, firmware, and much of Debian** are GPL/LGPL; they can be
  *distributed* with the VM but must not be "derived into" the core.
- **CoreMark** is vendored in `benchmarks/c/coremark/` under Apache-2.0 plus
  the EEMBC Acceptable Use Agreement (trademark-only restrictions; running it
  for measurement is the Licensed Use). Its LICENSE.md is preserved in-tree;
  results must carry the required notices.
- **Dhrystone 2.1** is effectively public-domain (Weicker); vendored with
  provenance notes.

## Decision

- **Core (`core/`, `host/`, `relay/`, `benchmarks/harness/`, this repo's
  original work): Apache-2.0.** Chosen over MIT for the explicit patent grant;
  NOTICE preserved per Apache-2.0 §4(d) (see NOTICE).
- **GPL components are isolated artifacts, never merged into the Apache-2.0
  core**: guest images, the stock kernel, firmware, and any wasmnux-tuned
  kernel are separate distributions under their own licenses (GPL-2.0-only for
  the kernel; respective firmware licenses), with source offers fulfilled via
  public Debian mirrors and (for the wasmnux kernel repo) a public source
  package + build reproducibility.
- **Derivative kernel/Mesa policy**: any WasmNUX-modified kernel or Mesa keeps
  upstream license notices; modifications are distributed as source; no
  "laundering" through the Apache-2.0 core.
- **Vendored third-party code** keeps its license file in-tree and is listed
  in NOTICE. New vendored code requires the same treatment in the same commit.
- **Contributions**: DCO-style sign-off + inbound = outbound (Apache-2.0);
  no CLA. See CONTRIBUTING.md.
- Trademarks: "WasmNUX" and the CoreMark name are used per their respective
  policies; no implied endorsement.

## Consequences

- Apache-2.0 core + GPL guest payload is the same separation model used by
  containers/VMs everywhere; legally boring, which is the goal.
- Every new file carries the copyright/license header or a directory-level
  README statement; CI spot-checks NOTICE completeness (check in Phase 1).
- If a future component genuinely needs to link GPL (e.g., linking a GPL guest
  agent into the host runtime), it is built as a separate process/IPC, not as
  a library.
- Contributors must not add copyleft dependencies to the core workspace —
  reviewers enforce; the license check fails the build on new GPL in core.
