# ADR-0005: Disk layout — ext4 virtio-blk, lazy chunked base image + OPFS COW overlay

## Status

accepted

## Date

2026-11-19

## Context

WasmNUX persists a Debian root filesystem in the browser's Origin Private File
System (OPFS) via synchronous access handles in a dedicated storage worker —
the only browser storage API with sync, direct file access from a worker.

Options considered:

1. **overlayfs over EROFS base** — EROFS is an excellent read-only base, but
   stacking it under ext4-in-OPFS duplicates kernel machinery and complicates
   base-image upgrades (a new base invalidates the upper's assumption of lower
   identity). Debian in-guest upgrades (`apt dist-upgrade`) already solve
   upgrade; the guest FS should be the thing apt manages.
2. **ext4 on virtio-blk** with a lazy-fetched chunked base image and an OPFS
   **copy-on-write overlay** for writes: base chunks are content-addressed,
   fetched once, verified by manifest (sigstore-style signing, Phase 1 image
   builder), cached in OPFS; writes allocate fresh COW chunks; reads fall
   through to cache. `fsck` inside the guest stays authoritative.

Spike C measurements (`benchmarks/results/spike-c-storage-draft.json`, Node
file-proxy — page-cache inflated, **relative only; re-measure under real OPFS
in browser before any ADR number is quoted externally**):

- Sequential read: ~1033 MB/s @4 KiB, ~2292 MB/s @1 MiB; write ~1–2.2 GB/s
- 4 KiB random read: ~295k → ~615k IOPS (page-cache assisted)
- COW A/B superblock crash-recovery path verified by unit tests
- Chunk-size sweep (4 KiB … 1 MiB): ≥64 KiB chunks dominated for throughput;
  smaller chunks win only for tiny random writes

Known gap found by the spike, to be fixed in the storage implementation:
the COW overlay's metadata currently caps at one sector of records — it needs
a **B-tree/extent journal** before Phase 2 (tracked in Phase 2 scope, not a
redesign of this ADR).

## Decision

- Guest root filesystem: **ext4** on **virtio-blk** (paravirtual block device,
  no emulated IDE/SATA).
- Base image: chunked, content-addressed, signed manifest; fetched lazily;
  stored in OPFS; shared across instances (same chunks reused).
- Writes: **COW overlay** in OPFS with A/B superblocks and a journal; OPFS
  sync access handles only from the storage worker; Storage Buckets used for
  durability hints where available (`navigator.storage.getDirectory()`
  + `storage.persist()`).
- Eviction pressure: on `QuotaExceededError` or bucket eviction signal, the
  overlay never discards un-checkpointed dirty chunks; the guest is paused and
  the user is told (data loss is a P0 bug, ROADMAP §1).
- Crash consistency (post-review): every overlay write lands in a **fresh
  arena slot** and only then commits metadata; a crash before commit leaves
  the last committed chunk intact, and discards outside the logical size are
  rejected up front. Arena compaction is Phase 2 work.
- Base upgrades ship as new signed chunks; the guest's own package manager is
  the upgrade mechanism — no in-place base rewriting.

## Consequences

- Phase 0 gives relative numbers only; the KPI rows "Sequential read/write"
  and "4 KiB random IOPS" are **not yet calibrated** and stay "pending browser
  OPFS re-measurement" until Phase 1/2 (recorded in the KPI calibration doc).
- Chunk size default: **64 KiB** (sweep knee); snapshot engine (Phase 3)
  re-chunks for compression efficiency.
- COW metadata journal is now load-bearing scope for Phase 2 (plus arena
  compaction — rewriting hot chunks leaks unreferenced slots).
- No EROFS in-guest; the base image is just files + a manifest, which keeps
  the guest kernel completely stock.
