# ADR-0001: Guest ISA — riscv64

- **Status:** Accepted
- **Date:** 2026-11

## Context

"Every apt app" is the product promise, but no guest ISA gives that literally:
package coverage, JIT complexity, and kernel availability trade off against
each other (ROADMAP §12 risk table). The chosen ISA becomes the ABI the whole
system is built on, so it is decided first.

## Decision

**riscv64 on a QEMU-`virt`-compatible machine model.**

- **Official Debian port** — stock Debian kernel and userland boot unmodified
  (product principle 3: *Real Debian*); `apt` works for the riscv64 archive.
- **Simplest ISA to JIT** — regular 32-bit fixed-width encodings, no flags
  register, no microarchitectural legacy; spike A confirms a clean mapping of
  RV64I ALU/branch/load/store/mul onto Wasm (0 divergences vs interpreter).
- **QEMU-`virt` compatibility** — the reference machine is well understood;
  Phase 1 brings up devices (virtio-blk/net/gpu) against it.

## Alternatives considered

- **amd64** — maximum package coverage, but a far heavier JIT (flags,
  segmentation, x87/SSE/AVX) and no stock "simple machine" story.
- **arm64** — full archive and moderate JIT complexity; still more ISA
  surface (IT blocks, narrow encodings) than riscv64 for equal benefit.

The shared JIT infrastructure keeps a second backend (amd64/arm64) open as a
future, non-goal-for-now option.

## Consequences

- Package-coverage gaps vs amd64 are measured and published (foreign-arch
  translation is a later opt-in), per the Phase 0 KPI table.
- Phase 0 implements RV64IMAZicsr + privileged subset; M/A extensions are
  in-tree from day one because Linux userspace expects them.
- All spikes assume riscv64 (SMP litmus, storage block device, display
  scanout) — no re-architecting expected.
