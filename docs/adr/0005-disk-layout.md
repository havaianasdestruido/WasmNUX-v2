# ADR-0005: Disk layout — ext4 on virtio-blk, chunked base image + OPFS COW overlay

- **Status:** Proposed (Phase 0) — to be confirmed by Spike C
- **Related:** ADR-0001, ADR-0012
- **Open evidence:** Spike C (OPFS sync access handles, chunk-size sweep, Storage Buckets durability, eviction)

## Context

The guest needs a real block device: `apt`, `dpkg`, systemd unit files, journal,
`fsck`, and every package's postinst assume POSIX filesystem semantics on a
device. The host offers the Origin Private File System (OPFS), whose
`createSyncAccessHandle()` is the only synchronous, byte-range-addressable
storage primitive available inside a worker — which is exactly what a virtio-blk
backend needs, because the guest blocks on I/O and cannot await a promise.

Two additional facts shape the design. First, a full Debian rootfs is hundreds
of MiB to GiB, and the first-visit budget is a byte budget, not just a time
budget. Second, the browser can evict origin storage at any time, so anything
the user cares about must be either reproducible from the network or explicitly
persisted.

## Decision

- **Filesystem in the guest: ext4**, on a **virtio-blk** device. No guest-visible
  novelty.
- **Two layers, one device.** A read-only, **content-addressed base image**
  fetched lazily in chunks over HTTP range requests, and a **per-instance COW
  overlay in OPFS** with sparse chunks. The block device the guest sees is the
  merge of the two.
- **Chunked, hashed, compressed base.** Chunks are content-addressed (so an
  upgraded base reuses unchanged chunks), range-fetchable (so only touched
  regions are ever downloaded), and listed in a **signed manifest**.
- **Durability is opt-in and monitored.** `navigator.storage.persist()` is
  requested, quota is watched, and low space surfaces as terminal text
  (ROADMAP §5, Phase 2: zero visible UI).
- **Crash consistency is the overlay's problem, not ext4's.** The overlay's
  metadata is journaled so a tab killed mid-write leaves a filesystem that
  `fsck`s clean; `fsync` from the guest must reach a durable OPFS flush before
  it is acknowledged.
- **TRIM/discard** frees overlay chunks, so deleted data actually frees browser
  storage.
- **Multi-tab safety** via a Web Locks single-writer lock: a second tab on the
  same instance gets a clear "instance in use" message rather than corruption.
- **Export/import** as a `.wnx` archive with integrity hashes.

**Rejected: overlayfs over an EROFS base inside the guest.** It complicates base
upgrades (an overlayfs upper layer survives a base swap only if the base's
inodes are stable, which EROFS does not guarantee across rebuilds) and moves a
policy decision into the guest kernel. Debian upgrades already go through `apt
dist-upgrade`, which works on a plain ext4 volume; host-side COW keeps the base
immutable and shareable between instances instead.

**Rejected: IndexedDB for block data.** No synchronous byte-range access from a
worker, and per-record overhead makes 4 KiB random I/O pathological. OPFS sync
access handles are the right primitive.

**Rejected: one big file per instance, no chunking.** It cannot be fetched
lazily, so first visit pays for the whole image, and it cannot be shared between
instances.

## Consequences

**Positive**

- The guest sees an ordinary ext4 disk: every package behaves normally, `fsck`
  works, snapshots are a host-side copy of overlay chunks.
- Lazy chunk fetch makes first-visit cost proportional to what the boot actually
  reads, which is the only way to hit the byte budget.
- Content addressing gives dedup across instances and a cheap integrity story
  (manifest is signed; chunks are their own hash).
- Snapshots and incremental export fall out of the chunk model for free.

**Negative / risks**

- **Sync access handles are Chromium-first.** Firefox and Safari support has
  landed unevenly; Tier-2 browsers may need an async fallback with a request
  queue, which changes latency characteristics. Spike C must measure both.
- **Eviction is outside our control.** `persist()` is a request, not a promise.
  The product has to treat the base image as always re-fetchable and warn before
  the overlay grows beyond what the user is willing to lose.
- **Chunk size is a real trade-off** and is not settled here: small chunks mean
  more requests and more metadata; large chunks mean wasted bytes on a sparse
  read pattern. Spike C sweeps it.
- **COW correctness is subtle.** A torn write that straddles a chunk boundary,
  a read of a partially-written chunk, and discard racing a write all need
  explicit fault-injection tests (ROADMAP §9).
- ext4 in the guest plus COW in the host means two levels of write amplification;
  `noatime`, a large guest `dirty_ratio`, and discard batching are the mitigations.

## What Spike C must answer before this becomes Accepted

1. `createSyncAccessHandle()` throughput and latency for 4 KiB random and
   sequential I/O, in Chromium, Firefox and Safari.
2. Optimal chunk size for a Debian boot read pattern.
3. Storage Buckets durability semantics and eviction behaviour under pressure.
4. Cost of a `flush()`/`close()` per fsync, and whether batching breaks the
   crash-consistency guarantee.
