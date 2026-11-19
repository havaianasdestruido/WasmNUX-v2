# ADR-0012: Debian tracking — stable by default, testing/sid by script, upgrades in-guest

- **Status:** Accepted (Phase 0: policy only — first image is Phase 1)
- **Date:** 2026-11

## Context

Debian's three tracks trade freshness against breakage. A browser-hosted
distro must keep `apt` trustworthy for non-technical users while still
letting contributors chase newer packages.

## Decision

1. **Track Debian `stable`** for the shipped base image and all default
   apt sources — the compatibility promise (ADR-0001/0006) is anchored to
   stable's freeze discipline.
2. **`testing`/`sid` via an explicit script** (`scripts/`), never default:
   contributors opt in knowingly; the script records the sources change in
   the snapshot manifest for reproducibility.
3. **Release upgrades happen inside the guest** (`apt dist-upgrade` when
   stable moves) — the base image stays a bootstrap; upgrades are normal
   Debian operations (ADR-0005's immutable base + COW overlay makes them
   cheap and reversible via snapshot rollback).
4. **Rolling images are rejected** as a default (alternatives row): they
   break the "stock Debian" story and make bug reports irreproducible.

## Evidence (Phase 0)

- Policy recorded; image pipeline (Phase 1) will stamp
  `/etc/debian_version` + sources into the snapshot manifest; no guest image
  exists yet in Phase 0 (KPI rows for boot/QoS reserved).

## Consequences

- CI image builds (Phase 1) pin `stable` point releases for reproducible
  benchmarks; `scripts/image/` carries the sources-switch helper.
- WasmNUX-specific packages (tuned kernel, ADR-0006) target the same stable
  baseline to avoid dependency skew.
