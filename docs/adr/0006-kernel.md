# ADR-0006: Stock Debian kernel first

**Status:** Accepted.

**Decision.** Boot the unmodified stock Debian kernel and track its normal security updates. Make QEMU `virt` compatibility, SBI/direct kernel boot and in-tree virtio drivers the compatibility baseline. Do not require a fork to boot or install normal packages. A tuned kernel can later ship in a signed WasmNUX apt repository as an opt-in with a pinned stock rollback path.

**Trade-offs.** A custom-only kernel might trim latency and memory but costs security maintenance, package compatibility and observability. Stock-first exposes missing virtual hardware instead of masking it in guest patches.

**Validation.** Phase 1 must boot stock Debian repeatedly and verify initramfs, serial login, package availability and reboot. Require a before/after benchmark and rollback test for each tuned default; Phase 0 images are not supplied.
