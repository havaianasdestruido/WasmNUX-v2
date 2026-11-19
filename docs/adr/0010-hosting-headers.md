# ADR-0010: Hosting — COOP/COEP headers with `coi-serviceworker` fallback

- **Status:** Accepted (Phase 0: harness + probe page in place)
- **Date:** 2026-11

## Context

SharedArrayBuffer — the substrate for SMP (ADR-0004), the relay, and the
display worker — requires cross-origin isolation
(`Cross-Origin-Opener-Policy: same-origin` +
`Cross-Origin-Embedder-Policy: require-corp`). Static hosts that cannot set
headers must still work.

## Decision

1. **Primary:** deploy with COOP/COEP headers (documented in `web/` and the
   README deployment section). `credentialless`/`require-corp` chosen so
   first-party assets load without per-tag CORS churn.
2. **Fallback:** ship `coi-serviceworker` for hosts without header access —
   it rewrites responses to inject the headers. Documented as a fallback,
   not the default (service-worker caching has its own footguns).
3. **Feature probe:** `web/index.html` checks
   `crossOriginIsolated`, WebGPU, OPFS sync handles, OffscreenCanvas,
   `navigator.hardwareConcurrency` and surfaces results as JSON for the
   Phase 1 harness; non-isolated builds get a clear doctor-style warning
   instead of a cryptic `Atomics` failure.

## Evidence (Phase 0)

- Spike B runs on shared memory in Node (proves protocol); the browser probe
  page asserts `crossOriginIsolated` before starting workers.
- `DirectSocketPolicy`-style capability gating reused for isolation gating.

## Consequences

- CI serves the probe page with headers enabled (static file server config
  in `web/`); the fallback path is tested manually when the service worker
  changes.
- Any third-party asset must be CORP/CORS-clean under COEP — dependency
  policy note in CONTRIBUTING.
