# ADR-0001: Guest ISA

- **Status:** Accepted (Phase 0)
- **Deciders:** maintainers
- **Supersedes:** —
- **Related:** ADR-0002, ADR-0003, ADR-0004, ADR-0013

## Context

WasmNUX runs a stock Debian userland in the browser. The guest ISA determines
package coverage, JIT complexity, kernel availability, and how much of the
browser's own capability model we can lean on. ROADMAP §3 lists riscv64 as the
leading option with amd64 and arm64 as alternatives.

Three constraints bear on the choice and none of them is about the ISA's
elegance:

1. **It must JIT cleanly to Wasm.** Wasm is a 32/64-bit register machine with no
   flags register, no condition codes, no segmented addressing, and
   fixed-width typed memory accesses. An ISA whose semantics map onto that
   without a large translation tax wins.
2. **It must have a Debian port that is actually maintained**, with a kernel we
   can boot unmodified (Phase 1's exit criterion is `gcc hello.c` inside the
   tab, which means a real toolchain, not a toy).
3. **The performance KPI must be reachable.** ROADMAP §4 requires ≥3× the best
   existing in-browser emulator. Spike A measured a RISC-V backend at 6.8–14.8×
   ([`docs/spikes/spike-a-jit.md`](../spikes/spike-a-jit.md) §3.1).

## Decision

**riscv64 (RV64GC) on a QEMU-`virt`-compatible machine model**, with **RV32IMA
built and measured first** as the proving ground for the shared translator.

The RV32IMA backend that exists today is not a downgrade of this decision or a
fallback target; it is the first slice of the same translator. It is complete
enough to be measured (`core/src/cpu`, `core/src/jit`, 132 differential tests)
and it settled the questions that RV64 would otherwise have had to answer blind:

- RV32IMA exercises every hard part of the Wasm translation — atomics and
  LR/SC, division corner cases, precise faults on MMIO, indirect control flow,
  region formation — and it does so with 32-bit addresses, which is what Wasm
  memory natively provides.
- RV64 adds the `C` (compressed) extension, 64-bit arithmetic, and 64-bit
  addresses. The first two are additive to the existing decoder/translator. The
  third is handled by ADR-0004: guest RAM stays below 4 GiB and the translator
  subtracts `ramBase`, so **RV64 does not require Wasm Memory64**. That matters
  because Memory64 validated but would not run in our measurement environment
  (§3.3 of the spike) and its browser support is narrower than plain memory32.

Why riscv64 over the alternatives, concretely:

- **amd64**: largest package coverage, but the JIT pays for flags/condition
  codes (every `add` becomes an explicit flag computation), partial-register
  writes, variable-length decoding that cannot be pre-decoded into blocks
  without a decoder cache, segmentation, and x87/SSE state. Spike A shows
  indirect control flow — not arithmetic — is already the bottleneck at 5–7×;
  an ISA that adds a flags dependency to _every_ ALU op would make that worse.
- **arm64**: full archive, moderate JIT complexity, condition flags still
  present but regular. The realistic alternative; kept open.
- **riscv64**: official Debian port, fixed-length base encoding (trivial
  block-scoped decoding), no flags register at all (branches compare registers
  directly — which is why `branchy` reaches 22.9× in the spike), explicit
  memory ordering that maps onto Wasm atomics one-for-one, and a machine model
  (QEMU `virt`) with public, stable device addresses that we already implement
  in `core/src/devices`.

## Consequences

**Positive**

- The translator's hard parts are measured, not assumed. The go/no-go that
  Phase 0 exists to produce is answered with numbers.
- No flags register means ALU ops translate 1:1; measured 40–65× over the
  interpreter on ALU/memory/matrix shapes.
- `ramBase` subtraction keeps the guest inside a 32-bit Wasm memory, so
  ADR-0004's lazy 4 GiB reservation works for both RV32 and RV64.
- QEMU `virt` compatibility means stock Debian kernels boot unmodified.

**Negative / costs**

- Package coverage on riscv64 is below amd64; ROADMAP §12 already lists this as
  a risk. ADR-0001 does not resolve it — it defers to Phase 8's compatibility
  harness to publish the real number, plus foreign-arch translation opt-in.
- We now owe an RV64 decoder, `C`-extension support (variable 2/4-byte
  instruction lengths, which breaks the current "block = words" accounting in
  `jit/cfg.ts` and the retire accounting in `jit/engine.ts`), and 64-bit
  arithmetic on a 32/64-bit dual-width Wasm target.
- The RV32 code that exists must not calcify: anything that hardcodes "one
  instruction = 4 bytes" or "register = 32 bits" is technical debt now. The
  retire-accounting and block-splitting code in `core/src/jit/engine.ts` are the
  two places this bites.

**Explicitly out of scope:** amd64/arm64 backends (post-1.0, ROADMAP §13);
hardware virtualisation; anything requiring Memory64 at runtime.

## Evidence

- [`docs/spikes/spike-a-jit.md`](../spikes/spike-a-jit.md) — GO, with throughput tables.
- `core/src/cpu/{encoding,asm,interp,state}.ts` — the RV32IMA implementation.
- `core/test/jit.test.ts` — 132 differential tests, interpreter vs 8 JIT configurations.
- `benchmarks/suites/jit.ts`, `benchmarks/suites/baseline.ts` — workload shapes and the 8086emu comparator.

## 2026-11-20 implementation checkpoint

RV64GC remains the target, not the implemented ISA. The current MMU API accepts
unsigned RV32 virtual addresses only, even when its experimental Sv39 walker
is selected. Unsupported high addresses now fault rather than aliasing low RAM;
this is a safety restriction, **not** full-width Sv39 support. Walker SUM/MXR
controls do not implement privileged CPU status CSRs. The historical external
comparator ratios above are not validated equivalent-work evidence; see the
current [integration status](../integration-status.md) and verification report.
