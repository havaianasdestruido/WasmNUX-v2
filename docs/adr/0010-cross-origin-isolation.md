# ADR-0010: Cross-origin isolation — COOP/COEP headers, service-worker fallback

- **Status:** Accepted (Phase 0)
- **Related:** ADR-0004, ADR-0008, ADR-0011

## Context

Everything else in this design depends on `SharedArrayBuffer`: guest RAM is a
shared `WebAssembly.Memory` (ADR-0004), vCPU workers share it (§2 architecture),
device queues are lock-free SAB rings (§1: zero-copy, no `postMessage` on hot
paths), and idle is `Atomics.wait` rather than a spin. Browsers only expose
`SharedArrayBuffer` to a **cross-origin isolated** document.

Cross-origin isolation requires response headers:

```
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```

`require-corp` in turn means every subresource must either be same-origin or
opt in with `Cross-Origin-Resource-Policy: cross-origin` (or be fetched with
`crossorigin` + CORS). Third-party assets — fonts, analytics, CDN-hosted chunks,
the lazily fetched base image from ADR-0005 — all have to satisfy that.

And a great many hosts cannot set headers at all: GitHub Pages, most static
hosting, an embedded `<iframe>` on someone else's docs site. §1.7 of the
ROADMAP makes embeddability a goal, which makes headers-only a non-starter.

## Decision

1. **COOP/COEP headers are the supported, first-class deployment.** The
   reference dev server sets them, and so does the benchmark browser runner
   (`benchmarks/src/browser.ts` serves the bundle with COOP/COEP precisely so
   the same suites can measure atomics in a real browser).
2. **`coi-serviceworker` (or an equivalent we maintain) is the fallback** for
   hosts that cannot set headers: a service worker rewrites responses to add
   them. It costs one extra navigation on first load and it is _not_ a
   performance path — it is a compatibility path.
3. **Cross-origin isolation is capability-detected, never assumed.** The
   environment probe records `crossOriginIsolated` (it reports `null` under Node,
   `true`/`false` in a browser), and `wnx doctor` reports it. When it is false,
   the product must say so in terminal text (§5 Phase 2: errors appear as
   terminal text) rather than failing inside a worker constructor.
4. **Every asset we ship satisfies `require-corp` by construction**: SRI on all
   shipped assets (§10), `Cross-Origin-Resource-Policy: cross-origin` on
   anything served from our origin, and CORS on the base-image chunk endpoint so
   range requests work under COEP.
5. **Strict CSP alongside the headers**, with no `unsafe-eval` — the JIT emits
   Wasm bytes and instantiates them, which CSP allows, and never `eval`s JS.

**Rejected: headers-only.** It makes the project undeployable on the static hosts
most people would try it on, and undeployable as an embeddable widget
(§1.7) — the two audiences least able to configure a server.

**Rejected: no threads, single-worker design.** It would remove the dependency
on cross-origin isolation entirely, and with it SMP (Spike B), the shared-RAM
design (ADR-0004), and lock-free device rings. The measurement in ADR-0004 says
the shared memory model is free to reserve and gives real atomics; giving that
up to avoid two response headers is a bad trade.

## Consequences

**Positive**

- Cross-origin isolation also brings the Spectre mitigations §10 requires, so the
  security story and the performance story are the same mechanism.
- One dev server, one header set, and one probe answer the question "can this
  deployment run WasmNUX?" for every embedder.

**Negative / obligations**

- **Embedders must be told, loudly.** An `<iframe>` needs
  `allow="cross-origin-isolated"` and the embedding page must itself be isolated;
  otherwise the product silently cannot start. This is ROADMAP §12's
  "cross-origin isolation friction for embedders" risk and it is real.
- **The service-worker fallback reloads the page once** and does not work in
  every context (it cannot fix a cross-origin parent frame).
- **Third-party assets become a compatibility burden**: anything we pull from a
  CDN needs CORP or CORS, which is an argument for vendoring and for the signed,
  self-hosted image pipeline.
- **Local `file://` and some dev setups cannot be isolated at all**, so
  contributors need the dev server rather than opening `index.html`.
- **Every browser test in CI must run against a server that sets the headers.**
  A headless Chromium pointed at a static file would fail atomics tests for the
  wrong reason; the benchmark browser runner exists partly to make that
  impossible.

## Evidence

- `web/dev-server.ts` — `npm run serve` bundles the demo page with esbuild and
  serves it with the same headers; the page prints `crossOriginIsolated` and
  warns when it is false.
- `benchmarks/src/browser.ts` — bundles with esbuild and serves with
  `Cross-Origin-Opener-Policy: same-origin` /
  `Cross-Origin-Embedder-Policy: require-corp` so `SharedArrayBuffer` exists.
- `core/src/jit/wasm/features.ts` — `probeWasmFeatures()` reports `threads`,
  `sharedMemoryGrowable`, `atomics`, `atomicWait`, and `crossOriginIsolated`;
  in Node all thread features are present and `crossOriginIsolated` is `null`.
- `benchmarks/suites/wasm.ts` — the `atomics-micro` case only runs when the
  probe says shared memory works, so a non-isolated context reports "unsupported"
  instead of a false failure.

## 2026-11-20 implementation checkpoint

The cross-origin-isolated Chromium suite now runs module-worker SMP and OPFS
transactions with Web Locks in addition to the demo. Missing isolation fails
browser SMP explicitly. This does not implement signed IWA packaging or Direct
Sockets; neither capability is inferred from cross-origin isolation alone.
