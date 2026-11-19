# ADR-0010: Hosting and Cross-Origin Isolation Headers

- **Status:** Accepted
- **Date:** 2026-11-19

## Decision
Require **COOP/COEP headers** (`Cross-Origin-Opener-Policy: same-origin`, `Cross-Origin-Embedder-Policy: require-corp`) for `SharedArrayBuffer`, with a **`coi-serviceworker` fallback** for static hosts that cannot set custom headers.
