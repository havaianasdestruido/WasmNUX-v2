# ADR-0005: ext4 over virtio-blk with an OPFS overlay

**Status:** Accepted direction.

**Decision.** Keep an ext4 guest root on virtio-blk. Fetch a signed, content-addressed, chunked base image lazily; persist modifications to a per-instance OPFS copy-on-write overlay. Stage metadata commits with a journal, map guest flush to a durable storage-worker transaction, and use a single-writer lock. Storage Buckets can request strict durability when supported; persistence and export/backup remain necessary because browser storage is not irreplaceable.

**Alternatives.** Overlayfs on EROFS complicates disk identity and base upgrades; keep normal Debian upgrades through apt instead. A single monolithic writable downloaded image increases first-visit bytes and makes snapshot/export expensive.

**Evidence and revisit.** Phase 0 sweeps 64 KiB to 4 MiB chunks and verifies sparse reads and flushed reopen. Browser-origin clearing shows loss of data; it does not measure automatic eviction, actual persistence of a strict durability request or power-loss consistency. Select chunk defaults after larger working sets, write amplification, quota, crash/fsck and multi-tab tests.
