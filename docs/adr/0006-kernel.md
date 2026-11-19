# ADR-0006: Kernel — stock Debian default, tuned `wasmnux` kernel as an option

- **Status:** Accepted (Phase 0: no kernel changes — ABI surface only)
- **Date:** 2026-11

## Context

Product principle 3 requires unmodified Debian to work (`apt install linux-*`
must not become a trap). A fully paravirtualised, tickless, trimmed kernel
would boot faster and idle better, but a custom-only kernel breaks Debian's
kernel management.

## Decision

1. **Compatibility default: the stock Debian riscv64 kernel.** WasmNUX's
   machine model (QEMU-`virt`-compatible, ADR-0001) is chosen so the stock
   kernel boots as-is.
2. **Optional tuned `wasmnux` kernel** shipped from a signed WasmNUX apt
   repo: trimmed config, tickless (`nohz_full`-style where applicable),
   paravirt-friendly — installable/removable through normal `apt` means.
3. **Phase 0 scope:** kernel *bring-up* is Phase 1. Phase 0 pins the ABI
   contract the kernel will see: syscall surface (exit/write implemented,
   everything else `ENOSYS` until Phase 1), Sv39 MMU, LR/SC + AMO semantics
   (ADR-0004/0002 notes), CSR set (`IMPLEMENTED_CSRS`).

## Evidence (Phase 0)

- Interpreter/JIT agree on traps and ecall behaviour (jit + cpu tests).
- Spike B litmus validates the atomics the kernel's locking depends on.

## Consequences

- Any kernel divergence from stock must arrive with a benchmark (ROADMAP
  principle: *Stock where possible*).
- KQoS toggles (tickless etc.) are apt packages, not forks.
