# ADR-0012: Debian tracking — track stable; testing/sid via script; upgrades inside the guest

## Status

accepted

## Date

2026-11-19

## Context

WasmNUX's promise is **real Debian**. Debian ships three concurrent suites
(stable, testing, unstable) plus per-arch rebuild lag. The base image must
pick one default, and the upgrade story must be explicit.

Measured reality (2026-11): Debian 13 "trixie" is stable (released
2025-08-09), kernel 6.12 LTS, first stable release with official riscv64
(~17k riscv64 packages of ~69,830). Trixie is therefore the base for every
Phase 0 measurement and the default image.

Options:

1. **Track rolling/testing/sid** — freshest packages, constant churn: breaks
   reproducible image builds, breaks the "what you measured is what you ship"
   property, and turns every apt upgrade inside the guest into a support
   incident. Rejected as default.
2. **Track stable; testing/sid as opt-in switch** — default images built
   reproducibly from trixie; `scripts/utils/apt/switch_suite.sh testing|sid`
   flips the guest's sources.list; release upgrades (`apt dist-upgrade`) happen
   inside the guest like on any Debian machine. The image builder pins trixie.
3. **Snapshot pinning (snapshot.debian.org) for byte-reproducible images** —
   compatible with option 2, not an alternative to it; used by the release
   image builder for provenance, not by users.

## Decision

- Default and only supported suite for shipped images: **stable (trixie)**.
- testing/sid: available via `scripts/utils/apt/switch_suite.sh`, documented
  as unsupported-for-releases (bug reports accepted, KPIs not promised).
- **Release upgrades happen inside the guest** (`apt full-upgrade`), never by
  replacing the guest image under the user; base image upgrades are a new
  chunked base (ADR-0005) rolling forward with the next Debian stable
  ("trixie+1") on the Debian release schedule (~2 years, LTS to 5).
- Security support: Debian security archive is enabled in the default image;
  `unattended-upgrades` for security-only updates is opt-in via
  `wnx config set security-updates auto|manual`.
- Image builder (Phase 1) records: suite, snapshot timestamp, package list
  hash, and builder version into the signed manifest.

## Consequences

- Debian's ~2-year stable cadence sets WasmNUX's base-image release cadence;
  security updates do not wait for WasmNUX releases.
- sid users are on their own but documented — same contract as Debian itself.
- Image reproducibility is anchored to snapshot.debian.org timestamps; builds
  are hermetic-ish (mirror variance documented, not eliminated).
- KPI/conformance numbers are published per suite; trixie numbers are the
  compatibility baseline.
