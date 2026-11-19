# ADR-0004: Shared Wasm guest RAM with explicit translation checks

**Status:** Accepted direction.

**Decision.** Use shared `WebAssembly.Memory` in cross-origin-isolated contexts and worker-local CPU state. Start with Memory32 and a RAM budget below the architectural 4 GiB ceiling; capability-detect shared Memory64 as a separate ABI when dependable. JIT-generated accesses perform explicit TLB/access/alignment checks and exit to the slow path for MMIO, faults or unresolved translations. Do not rely on guard pages or host `mprotect`.

**Trade-offs.** Sequentially consistent (SC) Wasm atomics are a conservative starting point, not a full proof of RVWMO. The probe's 64-bit (32-bit version + 32-bit value) per LR.W reservation is a synthetic ABI; it doubles storage, requires all writers to cooperate, wraps after 2³² updates and cannot directly model byte or DMA writes. Do not adopt it verbatim for guest RAM.

**Validation.** Workers park with `Atomics.wait`. Message-passing and repeated SC store-buffering litmus tests pass for the probed path. Extend to `.D`, guest ordering bits/fences, aliases, overlapping writes, device DMA and herd/architectural litmus coverage before claiming SMP correctness.
