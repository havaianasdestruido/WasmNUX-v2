# ADR-0010: Use native cross-origin isolation headers by default

**Status:** Accepted direction.

**Decision.** Serve the PWA over HTTPS with `Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy: require-corp`. Serve worker, Wasm, font and image resources same-origin or with matching CORS/CORP. Keep CSP strict, avoid third-party executable assets and validate signed image manifests. The test fixture's v86-specific `blob:` worker allowance is not the production default.

**Alternatives.** Headers-only is simpler but excludes static hosting without header control. Provide a separately tested, pinned `coi-serviceworker` fallback on hosts where the controlled first reload is acceptable. Do not represent it as a way to override embedding or browser security boundaries. If cross-origin isolation is absent, detect it and explain the limitation rather than starting shared-memory workers.

**Validation.** Chromium asserts cross-origin isolation on the Phase 0 fixture. Test deployment headers on workers/dynamic paths, offline/first-navigation reloads, cache invalidation, upgrades and embedding constraints before shipping the fallback.
