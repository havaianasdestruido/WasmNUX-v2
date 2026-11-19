# ADR-0006: Kernel

- **Status:** Accepted
- **Date:** 2026-11-19

## Decision
Boot the **stock Debian `riscv64` kernel** as the compatibility default, and ship an optional tuned `wasmnux` kernel (trimmed, tickless, paravirt) from a signed WasmNUX `apt` repository.

## Rationale
Using the stock kernel guarantees `apt` kernel management works out of the box; a tuned kernel can be opted into without breaking Debian packaging.
