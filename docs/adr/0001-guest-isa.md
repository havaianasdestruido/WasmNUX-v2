# ADR-0001: Start with a riscv64 guest

**Status:** Provisional.

**Context.** amd64 has the broadest binary compatibility, but segmentation, lazy flags, x87 and SSE/AVX materially expand JIT and machine-model work. arm64 also has broad Debian support, but increases decoder and translation scope relative to RV64. RISC-V is an official Debian 13 (`trixie`) architecture; its regular integer instruction encoding and existing `virt` machine model make it a tractable first target.

**Decision.** Target a `riscv64` QEMU `virt`-compatible platform with SBI, the extensions required by Debian's baseline, stock kernel and virtio. Keep host primitives, benchmark protocols, and the future JIT IR ISA-agnostic. Do not promise amd64 binaries or identical package availability across architectures.

**Evidence and revisit.** The RV64 arithmetic/branch subset matches the interpreter, but says nothing about privilege, MMU, floating point or full workloads. Run official ISA tests, boot an unmodified Debian kernel, and use `benchmarks/coverage.py` on matching Debian binary indices to publish exclusions versus amd64 and arm64. Compare QEMU-TCG on the same host. Reconsider the ISA if package coverage, stock kernel compatibility or throughput is unacceptable.
