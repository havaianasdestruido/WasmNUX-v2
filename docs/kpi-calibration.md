# KPI calibration — Phase 0 (2026-11-19)

> ROADMAP §4 targets are **proposals**. Phase 0 attaches measured evidence to
> every row it can measure, and marks the rest as **pending** with the exact
> probe that will measure it. Numbers with `*` are page-cache/JS-proxy
> inflated (Node `pread/pwrite` instead of OPFS) and are **directional only** —
> they must be re-measured in a real browser before release gates use them.
>
> Host for all Phase 0 numbers: 2× Intel Xeon @ 2.60 GHz, 3.8 GB RAM,
> Debian 12.2.0, Node v22.22.3 (in-browser probes noted separately).

## Startup

| Metric | Target | Stretch | Phase 0 measurement | Calibration |
|---|---|---|---|---|
| Resume from snapshot | ≤ 500 ms | ≤ 250 ms | **pending** — needs snapshot machinery (Phase 3) and guest image | Keep proposal. Spike A shows warm region JIT modules instantiate in ~0.9–1.2 ms (uncached); persistent code cache should make resume dominated by memory restore, not compile. |
| Cold boot, warm cache | ≤ 5 s | ≤ 3 s | **pending** — needs guest image (Phase 1) | Keep proposal. Watch: stock trixie kernel size is the biggest risk to the 3 s stretch; ADR-0006 mitigates via tuned kernel repo. |
| First visit, bytes before prompt | ≤ 30 MB | ≤ 15 MB | **pending** — needs image packager (Phase 1) | Keep proposal. Lazy-fetched chunks (ADR-0005) make ≤ 30 MB feasible; ~69,830-package trixie base trimmed to virtio + coreutils is the Phase 1 budget exercise. |

## CPU

| Metric | Target | Stretch | Phase 0 measurement | Calibration |
|---|---|---|---|---|
| Single-thread vs QEMU-TCG (same host) | ≥ 50% | ≥ 75% | **not directly measurable yet** (no guest). Host reference: CoreMark 29,689–32,008 iter/s @ -O2; Dhrystone 55.6M/s; gcc 12.2 compiling 5 CoreMark TUs in 337 ms | Keep proposal. Spike A effective JIT throughput ~6,160–6,969 MIPS vs RV64 interpreter ~7.8–10.2 MIPS (**670–1190×**). Translating to guest vs TCG requires Phase 1; the prior-art band (v86_64 ~530 MIPS ≈ 6× interpreted) suggests ≥ 50% of TCG is realistic, not guaranteed. |
| Throughput vs best in-browser emulator | ≥ 3× | ≥ 5× | Spike A kernels show **600–1500× vs own interpreter**; v86_64 ≈ 530 MIPS is the competitive bar | Keep proposal; re-derive precisely in Phase 3 vs v86_64/WebVM once we have a full guest. Baseline artifacts live in `benchmarks/results/`. |

## SMP

| Metric | Target | Stretch | Phase 0 measurement | Calibration |
|---|---|---|---|---|
| Scaling on parallel workloads (≤ 8 vCPUs) | ≥ 0.8× per core | ≥ 0.9× | **0.79×** contended AMO counter (1→2 workers); **0.83×** spinlock; **1.93×** partitioned hash; `Atomics.wait` parked wake ≈ **85 µs**; SB/LB litmus 0 forbidden/100k | Proposal too optimistic for contended workloads on 2 cores. **Recalibrate target to "≥ 0.7× per core contended, ≥ 0.85× partitioned" pending 8-vCPU measurements.** 0.8× remains the goal for `make -j` (mostly independent translation units) — plausible since partitioned work scaled ~1.93×. |

## Disk

| Metric | Target | Stretch | Phase 0 measurement | Calibration |
|---|---|---|---|---|
| Sequential read / write (with flush) | ≥ 300 / 100 MB/s | ≥ 1 GB/s / 300 MB/s | *1,028–5,240 MB/s read; 1,033–2,292 MB/s write (256 MiB file, Node proxy)* | Keep proposal with ≥ 300/100 as the gate (already exceeded by proxy numbers); **re-measure under real OPFS in-browser (Phase 1) before enabling CI gate**. Stretch only meaningful on browsers with real OPFS write-through. |
| 4 KiB random read IOPS | ≥ 50k | ≥ 150k | *~295k–615k IOPS (4 KiB→1 MiB chunk sweep, Node proxy)* | Keep proposal (50k gate is comfortably above; browser OPFS will be worse). Stretch 150k plausible in-browser. |

## Terminal

| Metric | Target | Stretch | Phase 0 measurement | Calibration |
|---|---|---|---|---|
| Keystroke → pixel latency | ≤ 1 frame | ≤ 8 ms | Full-frame CPU blit ~167 fps (1280×768); 2-row damage redraw ~9,300 fps; damage area after a 2-line scroll = **4.2%** of grid | Keep proposal. Input path is CPU-cheap; risk is composition/IME plumbing, not rasterization. |
| Throughput (`cat` of large file) | saturates display, never blocks vCPU | n/a | Ligature-aware ingest ~1.71M cells/s (~12.8k lines/s); plain ~7.54M cells/s (~55.9k lines/s); atlas hit rate **99.99%**; scrollback push ~5.85M lines/s | Keep proposal. Measured ingest exceeds a 4K display's cell rate by ~10×; vCPU blocking risk is the damage/attach logic — verify in Phase 2 integration. |

## GUI

| Metric | Target | Stretch | Phase 0 measurement | Calibration |
|---|---|---|---|---|
| Desktop compositing | 60 FPS @1080p | 120 FPS | CPU-equivalent blit ceiling ~1,784–1,802 full-1080p frames/s (Wasm SIMD ≈ `typedArray.set` ≈ 14.8–14.9 GB/s); manual JS 1,357 MB/s — SIMD mandatory | Keep 60/120 proposal pending WebGPU probe (`web/probe/webgpu-scanout.html`). Note: Linux lacks WebGPU today (ADR-0007) — CPU path is the floor and it already exceeds 60 FPS at 1080p for blit-bound frames. |
| Input → photon latency | ≤ 2 frames | ≤ 1 frame | Damage redraw ~9,300 fps (0.11 ms CPU); input routing is main-thread event → Atomics → display worker | Keep proposal; measure in Phase 2 E2E with headless Chromium. |

## Memory

| Metric | Target | Stretch | Phase 0 measurement | Calibration |
|---|---|---|---|---|
| Idle guest host-side footprint | ≤ 200 MB | ≤ 128 MB | **pending** — guest image (Phase 1). Host baseline: Wasm module per region 131–168 B + shared memory (Memory32 up to 4 GB ceiling, Memory64 where available) | Keep proposal. Watch `AddressSanitizer`-class leaks in the worker pool; measure with `measureUserAgentSpecificMemory()` once available. |

## Snapshots

| Metric | Target | Stretch | Phase 0 measurement | Calibration |
|---|---|---|---|---|
| Idle snapshot size (compressed) | ≤ 50 MB | ≤ 25 MB | **pending** — Phase 3. Base COW design (ADR-0005) implies snapshot = dirty chunk set + memory pages; compression (zstd) not yet implemented | Keep proposal. RISC-V TLB/page sharing across idle guests is the lever; calibrate after Phase 3 prototype. |

## Reliability

| Metric | Target | Stretch | Phase 0 measurement | Calibration |
|---|---|---|---|---|
| Data loss on tab kill / power loss | 0 corrupted filesystems | n/a | COW A/B superblock crash-recovery **verified by unit tests** (spike C, 8/8 pass); durability worker path implemented | Keep proposal — "0 corrupted filesystems" stays absolute. Phase 2 adds fault injection (kill workers mid-flush, fsck after); Phase 3 revalidates per commit. |

## Summary of calibration actions

1. **SMP row recalibrated**: 0.8×/core is not supported by contended-kernel
   measurements (0.79×); treat as stretch for contended workloads, keep as
   gate for parallel (partitioned) builds. 8-vCPU re-measurement required
   before final gates.
2. **Disk rows flagged `*`**: Node-proxy numbers are directional; browser OPFS
   re-measurement is a Phase 1 exit activity and will feed the CI gate.
3. **Startup, memory, snapshot rows**: genuinely unmeasurable until the
   guest exists — marked pending with the measuring phase, unchanged targets.
4. **JIT go/no-go**: explicit GO (ADR-0002). The "≥ 3× vs best in-browser
   emulator" row is the only CPU row with a hard in-browser competitor
   reference point; expect Phase 3 to confirm or adjust the 3× figure using
   v86_64/WebVM as baselines.
5. All boot-probe rows are wired into the harness schema (`bootCold`,
   `bootResume`, `bytesFirstPrompt`) as `skipped` with precise reasons, so
   CI gates flip on automatically when the guest lands.
