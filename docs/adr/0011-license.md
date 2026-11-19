# ADR-0011: License — permissive core (MIT / Apache-2.0), GPL isolated

- **Status:** Accepted (Phase 0 implemented)
- **Date:** 2026-11

## Context

The repo mixes original code with, later, Debian/GPL components (kernel,
 Mesa, firmware). Distribution risk must be contained without scaring off
 contributors or downstream packagers.

## Decision

1. **Core (this repository's code): dual MIT OR Apache-2.0.**
   - `LICENSE-MIT` — MIT text (short, maximally compatible).
   - `LICENSE` — Apache-2.0 (patent grant, explicit NOTICE obligations).
   - `package.json` `"license": "MIT OR Apache-2.0"`; README points at both.
2. **GPL components stay isolated:** guest kernel, Mesa stacks, and
   firmware live in the guest image with their own licenses and
   `NOTICE`/attribution files — never linked into the host-side Wasm code.
3. **NOTICE file** collects third-party attributions as they arrive
   (Phase 1 image build).

## Evidence (Phase 0)

- `LICENSE` (Apache-2.0) already upstream; `LICENSE-MIT` + `NOTICE` added
  in this phase; CI lint checks for the license files' presence.

## Consequences

- Contributors grant the dual license (CONTRIBUTING states this explicitly).
- Any future vendoring of GPL code requires an isolation review before it
  enters `image/` (risk table: *Licensing (GPL kernel, Mesa, firmware)*).
