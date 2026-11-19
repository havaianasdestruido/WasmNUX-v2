# WasmNUX-v2

**A complete Debian Linux system running inside a browser tab.** One
fullscreen terminal, a WebGPU-accelerated display, a persistent disk, and real
hardware access through Chromium's Web APIs — a VM that needs no install and
starts instantly.

> Status: **Phase 0 complete** — foundations, spikes, ADRs, and calibrated
> KPIs. Debian does not boot yet; that is v0.1 (Phase 1). See
> [`ROADMAP.md`](ROADMAP.md) for the full plan and
> [`docs/kpi-calibration.md`](docs/kpi-calibration.md) for measured numbers.

## What's here

| Path | What |
|---|---|
| `ROADMAP.md` | The plan: architecture, KPIs, phases 0–9, risks |
| `docs/adr/` | ADR-0001 … ADR-0012 (ISA, JIT, granularity, RAM model, disk, kernel, GPU, network, terminal, hosting, license, Debian tracking) |
| `docs/spikes/` | Per-spike writeups with measured results |
| `docs/kpi-calibration.md` | Every KPI row: measurement + calibration action |
| `spikes/` | Executable spikes A (JIT), B (SMP), C (Storage), D (Display/GPU), E (Network), F (Terminal) — 49 tests |
| `benchmarks/` | Vendored CoreMark + Dhrystone, host harness, committed results |
| `web/probe/` | Browser-only probes (WebGPU scanout) |
| `scripts/lib/` | CI check scripts (`check_adrs.mjs`, `check_shell.sh`) |
| `.github/workflows/ci.yml` | CI: build, tests, results validation, ADR/shell/license checks |

## Quick start

```bash
npm ci
npm run build
npm test                 # 49 tests across all spikes
npm run bench            # CoreMark + Dhrystone (+ pending sysbench/fio)
npm run validate:results # schema-check committed benchmark results
```

Requirements: Node ≥ 20 (22.x recommended), `gcc` + `make` for the C
benchmarks. Browser probes (`web/probe/`) need Chrome/Edge/Safari with
WebGPU where applicable.

## Key Phase 0 findings

- **JIT → Wasm is GO** (ADR-0002): RV64 blocks compile to ~131–168-byte Wasm
  regions running ~6,000–8,500 effective MIPS vs ~8–10 MIPS interpreter
  (600–1500×); best existing in-browser emulator (v86_64) is ~530 MIPS.
- **SMP works with caveats** (spike B): shared-memory atomics validated by
  litmus tests; contended-cacheline scaling is negative (0.79×) — recalibrate
  around partitioned workloads (1.93× on 2 cores); `Atomics.wait` parks idle
  vCPUs (~85 µs wake).
- **Software rendering is viable** (spike D/F): Wasm SIMD ≈ `typedArray.set`
  (~14.8 GB/s); 2-line damage redraw ≈ 9,300 fps; WebGPU (where shipped)
  lifts GUI to 60+ FPS at 1080p; no WebGPU on Linux yet, so the SIMD path is
  the floor.
- **Storage**: OPFS sync-access-handle design validated (COW overlay,
  A/B superblock crash recovery); browser numbers pending Phase 1.
- **Debian 13 "trixie" (riscv64)** is the guest base — first stable with an
  official riscv64 port.

## License

Apache-2.0 for the core (see `NOTICE`); GPL components (kernel, firmware,
images) are distributed separately under their own licenses. Vendored
benchmarks keep their licenses in `benchmarks/c/*/`. See
[`docs/adr/0011-license.md`](docs/adr/0011-license.md).
