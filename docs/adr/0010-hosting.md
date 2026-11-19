# ADR-0010: Hosting/headers — cross-origin isolation with service-worker fallback

## Status

accepted

## Date

2026-11-19

## Context

SharedArrayBuffer + WebAssembly threads — the foundation of SMP (ADR-0004) —
only exist in **cross-origin isolated** contexts in all current browsers.
Cross-origin isolation requires:

- `Cross-Origin-Opener-Policy: same-origin`
- `Cross-Origin-Embedder-Policy: require-corp` (or `credentialless`)

Static file hosts (GitHub Pages, S3, nginx without config changes) usually
**cannot set these headers**. Without isolation, the VM loses SMP; SPSC rings
lose Atomics; Tier-0 single-threaded mode is the only fallback.

Options:

1. **Headers-only** — correct but exiles embedders to header-capable hosts.
2. **coi-serviceworker fallback** — a service worker re-adds COOP/COEP via
   synthetic response headers on static hosts (well-established pattern,
   e.g. Google's `coi-serviceworker`). Cons: extra request hop, registration
   timing quirk, unavailable on `file://`.
3. **Both, with capability detection** — send headers when the host supports
   them; ship the service worker as automatic fallback; `wnx doctor` reports
   which path is active.

## Decision

- Ship **option 3**: COOP/COEP on all official hosts + automatic
  coi-serviceworker on static hosts + `wnx doctor` capability report.
- `require-corp` is the default; `credentialless` is used only where embedding
  third-party images/scripts is unavoidable (documented per deployment).
- **Strict CSP** on all official deployments; **SRI** on all shipped assets;
  **signed image manifests** (ADR-0005/0011 alignment).
- No cross-origin isolation, no SMP: single-vCPU mode is supported but
  degraded and clearly labeled; no silent fallback to fake threading.
- Embedding docs state the isolation requirement up front and provide the
  one-line service worker for embedders.

## Consequences

- Service worker caching must be designed so deployments can roll (versioned
  SW, skipWaiting + clients.claim only on explicit version bump).
- Every CI preview/staging host must set the headers too, or CI exercises a
  different path than production — the CI workflow sets them explicitly.
- `file://` usage is unsupported (no OPFS + no isolation); documented, not
  worked around.
