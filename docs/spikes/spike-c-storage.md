# Spike C — Storage: OPFS sync-access-handle block device (+ COW overlay)

**Deliverable:** `spikes/spike-c-storage/` · **Results:** `benchmarks/results/spike-c-storage-draft.json`

## What was built

- `src/opfs-block-device.ts` — OPFS SyncAccessHandle path (browser workers) *and* file-backed Node proxy (`node-file-block-device.ts`) for CI
- `src/cow-overlay.ts` — copy-on-write overlay, A/B superblocks, **fresh-slot arena data**: every write lands in a new arena slot and only then commits metadata, so a crash before commit leaves the last committed chunk bytes intact (previously, overwriting a present chunk in place could strand valid metadata on torn data)
- `src/durability.ts` — Storage Buckets durability path detection
- Chunk-size sweep 4 KiB … 1 MiB; 10/10 tests

## Measured (Node proxy — page-cache inflated, directional only)

| Chunk | Seq write | Seq read | 4 KiB randread IOPS |
|---|---|---|---|
| 4 KiB | 1,033 MB/s | 1,028 MB/s | 295k |
| 64 KiB | 1,999 | 4,253 | 456k |
| 128 KiB | 2,198 | 5,240 | 588k |
| 1 MiB | 2,292 | 4,381 | — |

Durability: A/B superblock recovery verified; bucket eviction surfaced as
a typed signal (guest pause + user prompt), never silent data loss.

## Known gaps (fixed in Phase 2 scope)

- COW metadata capped at one sector of records — needs a B-tree/extent journal
  before multi-GB images are safe. Tracked in ADR-0005.
- Arena slots are never reclaimed: rewriting hot chunks leaks slots (the
  current `stats().arenaLeakedBytes` exposes the watermark). Phase 2 needs
  compaction or a free list.
- Discards outside the logical size are rejected up front (post-review fix).

**Browser re-measurement is mandatory** before KPI numbers leave this file.
