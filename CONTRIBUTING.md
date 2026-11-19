# Contributing to WasmNUX

Welcome. WasmNUX is a browser-tab Debian VM built on WebAssembly and WebGPU.
Phase 0 (this branch) establishes the foundations: spikes, ADRs, benchmarks,
and CI. Contributions in later phases build directly on these.

## Ground rules

1. **Follow ROADMAP.md.** The phase exit criteria are hard gates. If your
   change doesn't advance the current phase, open an issue instead of a PR.
2. **Measure first.** Any performance claim needs a script in `benchmarks/`
   or `spikes/` that reproduces it. Speculation goes in issues, not docs.
3. **ADRs for decisions.** Any cross-cutting technical decision gets an ADR in
   `docs/adr/` (see the template at the bottom). `npm run check:adrs` enforces
   the format in CI.
4. **Tests.** All code under `spikes/*/test/` runs with `npm test` and must
   pass. New subsystems ship with tests, not after.
5. **License discipline.** The core is Apache-2.0. Do not add copyleft
   dependencies to `core/`, `host/`, `relay/`, or `benchmarks/harness/`.
   See `docs/adr/0011-license.md` and `NOTICE`.

## Getting set up

```bash
npm ci              # install workspace dependencies
npm run build       # tsc -b tsconfig.build.json (all spikes)
npm test            # build + node --test for every spike
npm run bench       # screening host benchmark run (CoreMark, Dhrystone, ...)
npm run bench:quick # alias
npm run validate:results   # schema-check benchmarks/results/host-*.json
npm run check:adrs  # ADR presence/format check
npm run check:shell # bash -n + hygiene for scripts/**/*.sh
```

Requires Node ≥ 20 (developed on 22.x) and a C toolchain for the host
benchmarks (`gcc`, `make`).

## Repository layout (Phase 0)

```
spikes/            Spike deliverables (A..F) — self-contained TS packages
benchmarks/c/      Vendored CoreMark + Dhrystone (licenses preserved)
benchmarks/harness/run.mjs   Host benchmark harness (JSON results)
benchmarks/results/*.json    Committed measurement snapshots
docs/adr/          Architecture Decision Records (NNNN-kebab-slug.md)
docs/spikes/       Per-spike writeups and numbers
docs/kpi-calibration.md      Phase 0 KPI evidence + calibration actions
web/probe/         Browser-only probe pages (WebGPU scanout)
scripts/lib/       CI check scripts (check_adrs.mjs, check_shell.sh)
```

## Spike conventions

- Each spike is a standalone npm workspace (`spikes/spike-x-name/`) with
  `src/`, `test/`, `README.md` optional, and its own results JSON committed
  to `benchmarks/results/spike-x-*-draft.json`.
- Node is fine for spikes that don't touch browser APIs; browser-only paths
  (OPFS, WebGPU, IWA Direct Sockets) ship a detection shim + an HTML probe
  page under `web/probe/`, and document what could not be measured in CI.
- **Never commit benchmark output that was run in a misleading configuration**
  (e.g., page-cache-inflated I/O) without labeling it as such in the JSON
  `note`/`proxy` field.

## ADR template

```markdown
# ADR-NNNN: Title

## Status

proposed | accepted | deprecated | superseded

## Date

YYYY-MM-DD

## Context

## Decision

## Consequences
```

## Commit & PR conventions

- Small, reviewable commits; one logical change per commit.
- Imperative subject line, ≤ 72 chars (`spike-e: add relay session pairing`).
- PR description: what changed, why, how it was measured/tested, and which
  ROADMAP checkbox or ADR it advances.
- CI must be green: build, tests, `validate:results`, `check:adrs`,
  `check:shell`.

## Security

Do not report security issues publicly. Open a private GitHub Security
Advisory on this repository instead. The threat model lives in ROADMAP §10
("The VM is the sandbox boundary").
