# WasmNUX

**A complete Debian Linux system running inside a browser tab** — persistent
by default, `apt` works, real hardware access with consent.

This repository is at **Phase 0**: foundations, risk-killing spikes, and
decisions. See [`ROADMAP.md`](ROADMAP.md) for the full plan and
[`docs/phase0/RESULTS.md`](docs/phase0/RESULTS.md) for measured numbers.

## Principles

1. **It just works** — no flags, no config, no user-visible tiers.
2. **It's fast** — keystroke→pixel ≤ 1 frame; 60 fps desktop.
3. **Real Debian** — unmodified userland, `apt` for the riscv64 archive.
4. **Persistent by default** — state survives reloads/crashes; data loss is P0.
5. **Real hardware** — through browser APIs, explicit consent per device.

## Layout

| Path | What |
|---|---|
| `packages/core` | RV64 interpreter + block JIT, Sv39 MMU, shared-memory guest RAM, SMP primitives |
| `packages/host` | Workers, bridges, terminal, storage, net (Phase 1+) |
| `packages/benchmarks` | KPI harness (`npm run bench`), Phase 0 report generator |
| `spikes/*` | Spike A–F sources + tests (JIT, SMP, storage, display, network, terminal) |
| `docs/adr` | ADR-0001…0012 |
| `web/` | Browser probe harness (COOP/COEP dev server, capability JSON) |
| `benchmarks/results` | Per-commit benchmark JSON (tracked) |

## Develop

```bash
npm install
npm test            # all spike + core suites (vitest)
npm run typecheck   # tsc --noEmit
npm run bench       # KPI rows → benchmarks/results/latest.json
npm run phase0:report   # regenerate docs/phase0/RESULTS.md
node web/serve.mjs  # browser probe on :8080 with COOP/COEP
```

Requires Node ≥ 20 (CI uses 22).

## Deployment headers (ADR-0010)

`SharedArrayBuffer` needs cross-origin isolation. For static hosting either:

- set headers: `Cross-Origin-Opener-Policy: same-origin`,
  `Cross-Origin-Embedder-Policy: require-corp`, or
- fall back to [`coi-serviceworker`](https://github.com/gzuidhof/coi-serviceworker).

`node web/serve.mjs` does the right thing locally.

## License

Dual **MIT OR Apache-2.0** ([`LICENSE-MIT`](LICENSE-MIT),
[`LICENSE`](LICENSE-2.0-compatible Apache text)) — see [`docs/adr/0011-license.md`](docs/adr/0011-license.md).
GPL components (kernel, Mesa, firmware) live only inside the guest image and
are listed in [`NOTICE`](NOTICE).
