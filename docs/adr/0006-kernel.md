# ADR-0006: Kernel — stock Debian kernel as compat default; tuned kernel from signed repo later

## Status

accepted

## Date

2026-11-19

## Context

WasmNUX does not emulate physical machines faithfully; it implements the
devices a virtio guest needs. Two kernel strategies are possible:

1. **Stock Debian riscv64 kernel** (`linux-image-riscv64`), exactly what
   `apt` installs, updated by `apt upgrade` to Debian security timelines.
   Pros: unmodified Debian promise holds for the kernel too; zero divergence
   to maintain; security fixes arrive with everyone's mirrors. Cons: carries
   drivers/configs a browser VM never uses (larger image, slower boot).
2. **Custom `wasmnux` kernel** (trimmed config, tickless, paravirt hints,
   virtio-only): faster boot, smaller footprint, but now WasmNUX maintains a
   kernel fork and the "real Debian" claim weakens — kernels are the most
   patch-sensitive component Debian ships.

## Decision

- **Compat default: stock Debian 13 ("trixie") `linux-image-riscv64`** from
  the standard archive, unmodified. This is what Phase 0–3 measure and what
  ships in the default image.
- A **tuned `wasmnux` kernel** (allnoconfig-ish virtio: virtio-blk, virtio-net,
  virtio-gpu, virtio-input, 9p/virtiofs, cgroups minimal, tickless) may ship
  later **only** from a signed WasmNUX apt repository, installed explicitly
  (`wnx kernel install wasmnux`), never into the default image, always
  replaceable by `apt install --reinstall linux-image-riscv64`.
- Any tuned kernel must pass the Phase 8 compatibility suite before the repo
  publishes it; if it can't, it doesn't ship.
- Guest ABI: virtio devices only (blk, net, gpu, input, snd), QEMU-virt
  compatible layout; no emulated physical hardware.

## Consequences

- Boot-time KPI (≤ 5 s cold, warm cache) is measured against the **stock**
  kernel first; the tuned kernel is upside, not the gate.
- Image size starts ~30–40% larger than a minimal build; accepted as the cost
  of the "real Debian" promise.
- Kernel CVEs follow Debian's cadence without WasmNUX action.
- No kernel patches in Phase 0–3. The first allowed kernel work is the
  wasmnux tuned repo, post-Phase 5, and only behind this ADR's rules.
