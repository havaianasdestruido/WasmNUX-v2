# ADR-0013: Core language — TypeScript host-side core, Wasm as the hot path

- **Status:** Accepted (Phase 0) with a mandatory review gate at the end of Phase 1
- **Related:** ADR-0001, ADR-0002, ADR-0003, ADR-0004
- **Deviation:** ROADMAP §2 lists the emulator core as "Rust → Wasm (`no_std`-style, SIMD + threads)". This ADR replaces that for the host-side core.
- **Evidence:** [`docs/spikes/spike-a-jit.md`](../spikes/spike-a-jit.md)

## Context

§2 of the ROADMAP assigns languages per component: Rust→Wasm for the emulator
core, TypeScript for host glue, Rust for the guest agent and the relay. Spike A
built the emulator core — interpreter, CFG recovery, translator, Wasm binary
encoder, tiering engine, device models — in TypeScript instead, because the
spike's whole purpose was to find out whether the JIT design works, and doing it
in a language we could iterate on in seconds was the fastest way to an answer.

It worked, and it produced numbers, so the question is now whether to keep them.

The load-bearing observation is that **the JIT's output is Wasm no matter which
language the JIT is written in**. The generated code — the thing that runs
billions of times — is identical. The host language therefore only affects:

- the Tier-0 interpreter;
- CFG recovery, translation, and optimisation (run once per region);
- host transitions (MMIO, syscalls, exits — run per exit, ≈1 µs each);
- device models.

## Decision

**The host-side emulator core is TypeScript, compiled by `tsc`, running directly
in the page/worker — not compiled to Wasm. Rust remains the language for the
guest agent (`wnxd`), the `wnx` CLI, the relay, and the image builder, per §2.**

Measured justification:

| what                                                       | measured                                                  |
| ---------------------------------------------------------- | --------------------------------------------------------- |
| JIT throughput, TypeScript core                            | **1.0–3.2 GIPS** (1038–2216 MIPS on the comparator suite) |
| vs best in-browser comparator (`8086emu` 1.5.1, Rust→Wasm) | **6.8–14.8×** — KPI is ≥3×                                |
| vs our own TypeScript interpreter                          | 23–65×                                                    |
| our TypeScript interpreter vs the Rust→Wasm comparator     | **0.4×**                                                  |
| region translation cost                                    | ≈500 ns per guest instruction                             |
| region compile+instantiate                                 | 0.05–0.29 ms                                              |

The KPI is met comfortably by the JIT path. The one number that argues for Rust
is the last-but-two: our interpreter is 0.4× of a Rust-to-Wasm interpreter. That
matters only where the interpreter is the steady state — cold boot, and
device-heavy or syscall-heavy phases — and ADR-0002's tier-down heuristic exists
to keep those phases short.

Reasons beyond throughput:

1. **No Wasm-in-Wasm boundary.** A Rust core compiled to Wasm would have to
   _instantiate JIT modules from inside a Wasm module_, then call into them.
   Cross-module calls are indirect and the host transition cost (≈1 µs, measured)
   would sit on every MMIO access and every region exit — exactly the seam
   Spike A found most bug-prone. In TypeScript, the core _is_ the host: it
   constructs a `WebAssembly.Module`, imports the shared memory, and calls it.
2. **Synchronous module construction is a host-language API.**
   `new WebAssembly.Module(bytes)` / `compileSync` are available to JS directly;
   a Wasm-compiled core reaches them only through imports, which is the same
   boundary as (1).
3. **One toolchain for core + host glue + terminal + benchmarks.** The
   differential tests, the assembler used to write guest workloads, the benchmark
   harness, and the browser runner are all the same language as the thing they
   test, and all of it is debuggable in browser devtools with source maps.
4. **The hot path is already Wasm.** The performance-critical code is generated;
   the language that generates it is not on the hot path.

**Rejected: Rust core compiled to Wasm (the ROADMAP's plan).** Better interpreter
tier and SIMD-friendly device models, at the cost of the boundaries in (1)–(2),
a second toolchain in the browser, a Wasm build step in front of every test, and
no measurable gain on the JIT path — which is the path that runs.

**Rejected: Rust core with the JIT emitting Wasm from Rust, called from TS.**
This is (1) again, and additionally splits the JIT across a language boundary
exactly where its state synchronisation is subtle.

**Rejected: keep both (TypeScript prototype now, Rust port later).** Two
implementations of the same semantics, with the differential tests rewritten
against whichever one is authoritative. Spike A already found three
retire-accounting defects and a state-sync direction bug in one implementation;
maintaining two is how correctness work stops happening.

## Consequences

**Positive**

- Everything measured in Spike A is measured on the real code path, not on a
  prototype of it: `core/src/jit` is the design, not a model of the design.
- Contributors need one toolchain (`npm install && npm test`) to run 288 tests.
- The core is embeddable as a plain npm package (§1.7) with no Wasm artefact to
  serve, version, or CSP-allow.

**Negative / risks**

- **The interpreter tier stays slow** (45–68 MIPS, 0.4× of the comparator). Cold
  boot is interpreted until regions get hot, so boot time is the exposure. This
  is the review gate below.
- **Device models in TypeScript are per-call expensive** and will need Wasm SIMD
  for memcpy/blit/checksum/compression (Phase 3 lists this) — which means
  writing those specific pieces in Rust or C and importing them, a partial
  reversal of this ADR at a much smaller scope.
- **No `no_std`-style allocation discipline for free.** §2's "no allocations in
  the run loop" has to be enforced by review and by benchmark, not by the type
  system. The engine allocates per region (typed arrays, block lists), which is
  fine, but the per-instruction path must not — GC pauses in a JIT loop are
  invisible in a best-of-N benchmark and visible to a user.
- **Single-threaded core, multi-worker SMP.** Each vCPU worker gets its own
  engine instance sharing the one memory (ADR-0004). That is the design anyway,
  but it means the core must be free of module-level mutable state. It is not
  fully audited for that yet.
- **`Number` is a double.** RV32 arithmetic must be forced to int32 everywhere
  (`|0`, `Math.imul`, `Int32Array`), and RV64 (ADR-0001) will need `BigInt` or
  a hi/lo pair — a real cost that Rust would not have. Several bugs found in
  Spike A were of this shape (a 20-bit immediate, an `expandLi` truncation).

## Review gate (mandatory, end of Phase 1)

This ADR is revisited with data, not opinion, once a real kernel boots:

1. Measure **cold boot to login** with the interpreter tier as the steady state
   (JIT disabled) and with tiering enabled. If interpreted boot dominates the
   ≤5 s KPI and the gap to a Rust interpreter would close it, port **the
   interpreter tier only** to Rust/Wasm and import it — a bounded, testable
   change, since the differential tests already pin its exact semantics.
2. Measure **device-model cost** during boot (virtio-console, virtio-blk, CLINT
   timer). If any single device exceeds ~10% of boot time, that device is a
   candidate for Wasm SIMD, independent of the core language.
3. Record GC behaviour: longest pause during a JIT-heavy workload.

If neither (1) nor (2) fires, this ADR becomes Accepted without a gate and the
ROADMAP §2 table is updated.
