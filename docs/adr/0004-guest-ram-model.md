# ADR-0004: Guest RAM Model

- **Status:** Accepted
- **Date:** 2026-11-19

## Decision
Use a **shared `WebAssembly.Memory`** (Wasm threads) with Memory64 where available, and **explicit software TLB checks** in generated code.

## Rationale
WebAssembly lacks `mprotect` / guard-page trap handling, so guest virtual-to-physical translation must go through an explicit software TLB lookup in JITed code. Shared `WebAssembly.Memory` enables zero-copy SMP across vCPU Web Workers (validated in Spike B).
