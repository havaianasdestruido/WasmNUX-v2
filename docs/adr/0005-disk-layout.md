# ADR-0005: Disk layout — ext4 rootfs, lazy chunked base image + OPFS COW overlay

- **Status:** Accepted (Phase 0 proved the overlay/journal; OPFS numbers in browser harness)
- **Date:** 2026-11

## Context

The guest needs a real Debian rootfs with `apt`, persistence across reloads
and crashes (data loss = P0), and fast cold starts. Storage APIs in the
browser (OPFS, Storage Buckets) have different durability/eviction profiles
and no POSIX `O_DIRECT`.

## Decision

1. **Guest view:** ext4 rootfs on a virtio-blk device. `apt dist-upgrade`
   is the upgrade path (no base-image mutation).
2. **Host view:** a **lazy chunked base image** (immutable chunks, fetched
   on demand — supports the ≤ 30 MB first-visit byte budget) plus a
   **copy-on-write overlay** of written chunks in
   `FileSystemSyncAccessHandle` files (OPFS), chunk size swept 4 KiB–1 MiB.
3. **Crash consistency:** every overlay write is journaled
   `BEGIN(payload, crc) → COMMIT → flush → chunk file` (write-ahead).
   Recovery replays only CRC-valid committed records and truncates torn
   tails — proven at every append boundary in spike C (0 torn states).
4. **Snapshot integration** (ADR-0004 of this repo's Phase-0 notes): the
   snapshot manifest commits through the same journal.

## Evidence (Phase 0)

- `spike-c-storage`: atomicity tests (5/5 crash points), corrupt-payload
  discard, Node fsync path round-trip, chunk-size sweep —
  4 KiB: 3.9 MB/s write (fsync-bound), 64 KiB: 52 MB/s, 1 MiB: 170 MB/s
  (rows `c4096`…`c1048576`); in-memory journal fast path 20 MB/s row `c9b`.
- OPFS ≥ 40 MB/s KPI row reserved for the browser harness (`c9`).

## Consequences

- Chunk size is a Phase 1 tuning knob against real OPFS numbers (sweep
  harness already parameterised).
- Storage Buckets (durable vs best-effort eviction) map to tiered placement:
  overlay = durable bucket; cache = best-effort (risk table §12).
- Base-image chunks are content-addressed → dedup across snapshots falls out
  of the design.
