# ADR-0001: Guest ISA

- **Status:** Accepted
- **Date:** 2026-11-19

## Context
WasmNUX needs a guest ISA that boots stock Debian stable, has clean semantics for a JIT targeting WebAssembly, and supports SMP atomics.

## Decision
Use **riscv64** on a QEMU-`virt`-compatible machine model.

## Rationale
- Official Debian port (`riscv64`) with full `apt` archive support.
- Clean fixed-width 32-bit instruction encoding (with optional C-extension), no condition-code flags, and straightforward LR/SC + AMO atomics.
- Spike A demonstrated **56.81× speedup** (3,579 MIPS JIT vs 63 MIPS interpreter) with an 84-byte Wasm module compiled in 0.60 ms.
- Shared JIT IR keeps the door open for an `amd64` or `arm64` backend later.

## Alternatives Considered
- **amd64:** Maximum package coverage, but far heavier JIT (flags, segmentation, x87, SSE/AVX).
- **arm64:** Full archive, moderate JIT complexity, but more complex decoding than RV64.
