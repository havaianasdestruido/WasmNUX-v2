# Contributing to WasmNUX

Thank you for contributing to WasmNUX!

## Principles

1. **No hot-path work on the main thread.** Main thread = input + permissions only.
2. **Zero-copy where possible.** Use `SharedArrayBuffer` rings (`Atomics`) between workers.
3. **Paravirtual over emulated.** Prefer `virtio` devices everywhere.
4. **Measure first.** Every performance claim must have a benchmark in `benchmarks/`.
5. **Stock where possible.** Prefer unmodified Debian kernel/userland; justify divergence with an ADR.

## Development Setup

- Node.js >= 22.0.0
- Run all tests: `npm test`
- Run benchmark harness: `npm run bench`
- Run individual Phase 0 spikes: `npm run spike:a` through `npm run spike:f`

## Architecture Decision Records (ADRs)

All major architectural decisions are documented in `docs/adr/NNNN-title.md`.
New decisions or reversals require a new ADR or an amendment PR.

## License

Core components are licensed under Apache-2.0 (see `LICENSE` and `docs/adr/0011-license.md`).
