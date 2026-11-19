# ADR-0005: Disk Layout

- **Status:** Accepted
- **Date:** 2026-11-19

## Decision
Use an **ext4 rootfs on `virtio-blk`**, backed by a lazy-fetched, content-addressed base image + **OPFS Copy-on-Write (COW) overlay** with 64 KiB–256 KiB chunks.

## Rationale
Spike C showed 256 KiB chunks achieve **334.6 MB/s** sequential write, **2,548 MB/s** sequential read, and **~1.2M** 4 KiB random read IOPS in-memory, while avoiding `overlayfs` over EROFS complexity so `apt dist-upgrade` works natively.
