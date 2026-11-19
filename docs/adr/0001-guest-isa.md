# ADR-0001: Guest ISA — riscv64 on a QEMU-virt-compatible machine

## Status

accepted

## Date

2026-11-19

## Context

WasmNUX boots an unmodified distribution in a browser tab, JIT-compiling guest
code to WebAssembly. The guest ISA choice dominates JIT complexity (decoding,
flags, calling convention), package availability, and how faithful "real
Debian" can be.

Options evaluated:

- **amd64**: maximal package coverage (the reference Debian architecture) but
  the heaviest JIT target: conditional flags (EFLAGS), complex addressing
  modes, x87/SSE state, segmentation. Prior art (v86) shows a workable but
  sprawling implementation; a faithful amd64 JIT is a multi-quarter effort.
- **arm64**: full Debian archive (secondary architecture); moderate JIT
  complexity (no condition codes, but rich immediate forms and SIMD).
- **riscv64**: official Debian port. The simplest ISA to JIT of the three:
  no condition codes, uniform instruction encodings, few exceptions, and a
  growing but real package set. QEMU's `virt` machine is a stable target model
  whose device layout we can mirror with virtio.

Measured/verified 2026-11: Debian 13 "Trixie" (released 2025-08-09) is the
**first Debian stable release with an official riscv64 port** — kernel 6.12
LTS, ~69,830 packages in the archive, >17,000 built for riscv64, with a
5-year support window. A riscv64-based WasmNUX is therefore booting *stock
Debian stable*, not an experimental image.

## Decision

**Guest ISA: riscv64** on a QEMU-virt-compatible machine model, using the
stock Debian 13 ("trixie") riscv64 kernel and userland as the default guest.

The JIT backend abstraction (RV64 decode → IR → Wasm) keeps the door open for
a second backend (arm64, later amd64) without re-architecting the compiler.

Known exclusions (measured, not hypothetical): Debian riscv64 lags amd64 on
package count (>17k vs ~69k). Phase 0 measured the risk, not the full list;
the compatibility harness (Phase 8) will publish exact exclusions. Common
heavy apps with missing riscv64 builds are the expected gaps, not core tools:
`build-essential`, Python, Node, nginx, PostgreSQL, OpenSSH are all present in
trixie riscv64.

## Consequences

- JIT complexity is minimized where we can least afford mistakes; spike A
  validated an end-to-end RV64→Wasm path (`spikes/spike-a-jit/`).
- Debian-first decision aligns with ADR-0012 (track stable).
- Users needing amd64-only binaries get them via explicit opt-in
  translation (post-1.0), never silently.
- "Every apt app" is not literally true on riscv64; ROADMAP KPI wording will
  say "every app with a riscv64 build in the Debian archive", measured in
  Phase 8 with a published exclusion list.
- Spike E's network stack and spike C's storage device are ISA-agnostic and
  reusable for a future arm64 backend.
