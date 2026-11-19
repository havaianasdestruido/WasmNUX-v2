# ADR-0002: Tier execution; retain the interpreter

**Status:** Accepted for prototyping, not a performance sign-off.

**Decision.** Implement a correctness-first interpreter for cold code and fallback, a baseline JIT for hot blocks, and later a region optimizer for loops and predictable edges. Keep register/PC state precise at exits and use bounded fuel and safepoints for interrupts, timers and scheduler cooperation. Translation and instantiation must not block the browser main thread.

**Alternatives.** Interpreter-only is simplest but leaves a large hot-path cost. JIT-only pays cold-start compilation and still needs precise recovery paths. A speculative optimizing-only design compounds compiler and conformance risk.

**Evidence and consequence.** Phase 0 reports matching checksums for the interpreter, block JIT and bounded self-loop region; v86 independently checks the low 32 bits. **GO** to continue the tiered prototype. **NO-GO** on making the measured block-dispatch design the production hot path or promoting the throughput targets. Validate a TLB, real control flow and code invalidation; run architecture/differential tests and real workloads versus QEMU-TCG and browser emulators before enabling performance gates.
