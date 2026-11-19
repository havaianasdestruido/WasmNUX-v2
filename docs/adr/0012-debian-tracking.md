# ADR-0012: Debian Tracking

- **Status:** Accepted
- **Date:** 2026-11-19

## Decision
Track **Debian stable** (currently Debian 13 "trixie") for base images; support `testing`/`sid` via opt-in guest script. Release upgrades happen inside the guest via `apt dist-upgrade`.
