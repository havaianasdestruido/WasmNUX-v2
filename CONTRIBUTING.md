# Contributing to WasmNUX

Thanks for helping. Phase 0 is about **measured decisions**: every risk-killing
spike ships with tests and numbers.

## Ground rules

1. **Follow `ROADMAP.md`.** It is the contract: phase checklists, KPIs, ADR
   table. If you need to deviate, write/update an ADR first.
2. **Tests are mandatory.** New code lands with vitest coverage
   (`packages/*/test`, `spikes/*/test`); JIT changes must keep the
   differential fuzz suite green.
3. **Numbers, not vibes.** Bench-affecting changes run
   `npm run bench` + `npm run phase0:report` and include the delta in the PR.
4. **One branch per session/PR**; keep diffs reviewable.

## Workflow

```bash
npm install
npm test && npm run typecheck && npm run lint
# ...hack...
npm run bench && npm run phase0:report
git commit -m "..."   # conventional-ish messages: feat/test/docs/bench/ci
```

Open a PR against `main`. CI re-runs typecheck/lint/tests/benches and uploads
the result artifact.

## License

By contributing you agree your contributions are dual-licensed
**MIT OR Apache-2.0** (ADR-0011), the same as the rest of the repository.

## Code style

- TypeScript strict; ESM with explicit `.js` extensions on relative imports.
- Prefer small, measured modules: `spikes/*` may be throwaway, `packages/*`
  is forever.
- No GPL code in `packages/`, `spikes/`, or `host/` — guest-image licensing
  is handled in `image/` with NOTICE entries only.
