# ADR-0003: Compile Wasm regions rather than one module per guest block

**Status:** Accepted direction.

**Decision.** Batch related hot blocks into bounded Wasm modules using intra-function branches and `br_table` where a region needs PC dispatch. Return at side exits and safepoints using the shared CPU-state ABI. Use interpreter fallback on evicted modules, invalidated pages and unrecognized exits. Cache validated Wasm bytes keyed by code identity, guest ISA, ABI and feature set; browser engine-native code persistence is not assumed.

**Alternatives.** A module per block is simple but adds compile/instantiate and host boundary costs. A single giant module has invalidation and latency problems. Region size, linking and cache bounds remain tuning parameters.

**Evidence and revisit.** The bounded self-loop probe removes repeated JS↔Wasm transitions under identical arithmetic and validated fuel semantics. It is not a multi-block `br_table`, TLB, or invalidation benchmark. Measure warm and cold instantiation percentiles, code footprint, indirect exits and invalidation before fixing production region limits.
