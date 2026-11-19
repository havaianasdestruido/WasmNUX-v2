# ADR-0006: Kernel — stock Debian kernel by default, tuned `wasmnux` kernel as an opt-in

- **Status:** Proposed (Phase 0)
- **Related:** ADR-0001, ADR-0005, ADR-0011, ADR-0012

## Context

The guest needs a Linux kernel. Debian ships one per architecture, maintained by
the Debian kernel team, delivered through `apt`, with security updates on
Debian's schedule. We could also build our own, trimmed for the virtual machine:
no drivers we cannot present, tickless, paravirt clock, `zram`/`zswap`.

The tension is between two of the project's own goals: _"Real Debian"_ (§1.3 —
unmodified userland, `apt` works) and _"Absolute performance"_ (§1.1 — budgets
are release gates). A stock kernel is the compatibility anchor and the thing
that makes the "every apt app" claim honest; a tuned kernel is where the
emulator's peculiarities (no real timer hardware, a browser-throttled main
thread, a host that can freeze the tab at any moment) stop costing performance.

There is also a distribution question: a kernel we build is a kernel we sign,
version, and support, and shipping it through a channel `apt` does not manage
breaks `apt upgrade linux-image-*`.

## Decision

**Both, with stock as the default.**

- **Default: the stock Debian kernel** for the guest architecture, installed by
  `apt` from the base image. It boots unmodified on the QEMU-`virt`-compatible
  machine model (ADR-0001), which is the Phase 1 exit criterion. Nothing in the
  emulator is allowed to require a patched kernel.
- **Optional: a `wasmnux` kernel** — trimmed config, tickless, paravirt clock,
  `zram`/`zswap`, and any paravirt devices we add — built reproducibly and
  shipped from a **signed WasmNUX apt repository** as
  `linux-image-wasmnux`. Installing it is an ordinary `apt` operation, and
  removing it returns the instance to the stock kernel.
- **The tuned kernel is justified per change, with a benchmark.** §1's
  engineering principle ("divergence must be justified by an ADR and a
  benchmark") applies to each config delta, not just to the decision to have
  one. A delta that cannot show a number does not ship.
- **Kernel/firmware/bootloader packages are handled with `equivs` stubs and apt
  pinning** (ROADMAP §5, Phase 8) so that `apt` never tries to install a
  firmware blob or a bootloader the virtual machine does not use.

**Rejected: custom kernel only.** It breaks `apt` kernel management, makes every
Debian security update our build problem, and destroys the "real Debian" claim —
the guest would be running a kernel no Debian user can reproduce from the
archive.

**Rejected: no tuned kernel ever.** Some costs are structural and cannot be
fixed from userspace: a periodic tick that wakes a vCPU worker for nothing, a
clocksource that reads a device we emulate in JS, and swap that writes to an
OPFS-backed disk. Phase 3 lists these explicitly.

**Rejected: patching the stock kernel in place.** A fork that is not an `apt`
package is worse than either option: no upgrades, no provenance, no removal path.

## Consequences

**Positive**

- Compatibility is anchored to something Debian maintains; security updates
  arrive through `apt` on Debian's schedule for anyone who wants them.
- The tuned kernel is opt-in and reversible, so a performance regression in it
  cannot strand a user.
- Shipping it from our own signed apt repo means the _same_ mechanism serves
  guest-side Mesa drivers (ADR-0007), `wnxd`, and the WM/DE scripts' package
  pins — one distribution channel, not four.

**Negative / costs**

- **Two kernels to test.** CI must boot both, and any bug report needs to say
  which one it happened on.
- **A build pipeline we own**: reproducible kernel builds, signing
  (minisign/sigstore, §10), versioning that satisfies `apt`, and an ABI story
  for out-of-tree modules users may install.
- **Paravirt devices in a tuned kernel mean guest-side code we maintain**, and
  they are only useful if `wnxd` and the host agree — a cross-component contract
  that needs versioning.
- The stock kernel will carry drivers for hardware we do not present. That is
  wasted image bytes and boot time, mitigated by ADR-0005's lazy chunk fetch
  rather than by trimming.

## Open questions

- Does the stock kernel's clocksource selection pick something expensive to
  emulate? (Measure before building anything.)
- Boot time delta between stock and tickless on the same host — this is the
  number that decides whether the tuned kernel is worth its pipeline.
- How does `apt` handle two kernels providing `linux-image-*`? Pinning policy
  needs to be written down with the repo.
