# Phase 0 evidence and exit decision

**Phase exit: NO-GO.** The repository now has tested prototypes, per-commit measurements and twelve ADRs, but does not yet have measured numbers for every KPI in [ROADMAP.md §4](../ROADMAP.md#4-performance-budget-and-kpis). No Phase 1 work or production performance promises are implied.

**JIT design: GO for continued tiered prototyping; NO-GO for production one-module/host-dispatch-per-block.** The interpreter gives a correctness reference. The bounded self-loop region is the direction to generalize; it is not a full region dispatcher. See [ADR-0002](adr/0002-execution-strategy.md) and [ADR-0003](adr/0003-wasm-granularity.md).

See [benchmark reproduction](../benchmarks/README.md) and [raw reference reports](../benchmarks/results/).

| Checklist item | Evidence | Remaining validation |
|---|---|---|
| Foundations | npm workspaces, Apache-2.0, contributor docs, CI and tests | Production Rust/TS build and release pipeline belong to later phases |
| Benchmarks | Per-commit Chromium artifact; guest workload, boot, coverage and GPU matrix harnesses | Run real Debian workloads against both WasmNUX and same-host QEMU-TCG; reference host profiles and regression thresholds |
| A: JIT | RV64 ALU/branch checksum against interpreter, plus i386 v86 low-32-bit control; bounded region | Load/store, TLB, branches across regions, Debian workloads, and CPU conformance |
| B: SMP | 1/2/4 workers, shared Wasm i64 atomic load/CAS backing LR.W/SC.W/AMOADD.W; wait/notify and SC litmus | True guest RAM layout, full RVWMO and Linux SMP scaling |
| C: storage | OPFS chunk sweep, flush/reopen, strict bucket request, browser origin-data clearing | Real quota exhaustion and browser-chosen eviction, durability across crashes/power loss, guest ext4/fsck |
| D: display/GPU | WebGPU copy/queue timing and conformance/throughput adapter contract for four paths | Hardware canvas/compositor timing; virgl, Venus, Mesa/WebGPU, and guest software conformance and speed |
| E: network | Two lwIP Wasm stacks through WebSocket, development IWA manifest and loopback echo fixtures | Installed desktop IWA Direct Sockets run, production relay/virtio integration |
| F: terminal | GPU glyph atlas readback, wide glyph and shaped raster checks, Chromium IME pre-edit/commit | Full terminal parser/shaping coverage and key-to-display measurements |
| ADRs | [0001–0012](adr/README.md) | Revisit provisional entries with the required evidence |

## Reference run

[Raw Chromium samples](../benchmarks/results/be5104195011047d0170542122959a4d58391b90.json) were collected from clean source `be51041` on Linux x86-64 (two logical processors available, Chromium 149.0.7827.0, SwiftShader).

- **JIT:** Median for one million iterations: **125.32 ms** interpreter, **12.40 ms** block JIT, **4.29 ms** bounded region, **5.19 ms** v86. The region took about 2.9× less time than the block JIT on the same RV64 workload. Its advantage over v86 on this single mixed-ISA arithmetic fixture is not a system throughput claim.
- **SMP:** In a [follow-up run](../benchmarks/results/35a17fb533bbc17ad0687910fe15c13c4bc6adcb.json), the corrected 1/2/4-worker times were **14.32 / 26.44 / 56.78 ms** for 20,000 contended iterations per worker, measured from wake to the last worker finishing its atomic workload. All workers were notified; all shared totals and both SC litmus checks passed. Four workers oversubscribe the available processors. The older raw report includes post-work validation and message delivery in `elapsedMs`; use the follow-up for worker-count comparisons.
- **Storage:** At 64/256/1024/4096 KiB, 8 MiB reopen/read throughput was **118 / 274 / 542 / 778 MB/s**; flushed write throughput was **55 / 127 / 182 / 244 MB/s**; seeded 4 KiB reads gave **3.6–3.9k IOPS**. This small test includes file-open costs and is not a sustained guest disk benchmark. A strict bucket request and same-session reopen worked; Chrome reported neither durability nor a persistence grant, and the quota override did not induce exhaustion. Simulated origin clear removed the control sector.
- **Graphics/terminal:** Median **11.30 ms** for a 1080p upload+copy into an offscreen GPU texture (canvas interop unavailable), **2.35 ms** for the glyph atlas fixture. Both are queue times, not presented frames. Real Chromium IME pre-edit and commit ordering passed separately.
- **Network:** **3.61 ms** to connect and **577.80 ms** to echo 16 KiB end-to-end through the fixture in this run. These are local measurements, not production network latency.

## KPI gate ledger

All statuses below apply to the **roadmap KPI**, not a prototype. In particular, no prototype queue timing or bandwidth result is a system or release gate pass.

| Roadmap KPI | Status | Needed evidence |
|---|---|---|
| Snapshot resume to usable prompt | Unmeasured | A guest with snapshot/resume and serial readiness |
| Cold boot (warm cache) to login | Unmeasured | Stock Debian boot and serial readiness |
| First visit bytes to first prompt | Unmeasured | Guest boot and a first-visit browser transfer meter |
| CPU vs same-host QEMU-TCG | Unmeasured | Identical build flags and Debian workloads on both engines |
| CPU vs best existing browser emulator | Microbenchmark only | v86 fixture exists; add matched workloads and additional relevant baselines |
| Parallel workload scaling to 8 vCPUs | Synthetic only | Linux SMP and `make -j` wall times, 1/2/4/8 vCPUs on an adequate host |
| Sequential disk read/write with flush | OPFS only | Guest ext4/virtio-blk/fio, sustained and repeated runs |
| 4 KiB random read IOPS | OPFS only | Guest fio comparison across working sets |
| Terminal keystroke → pixel | Unmeasured | Timestamp input through rendered presentation |
| Terminal throughput, no vCPU stalls | Unmeasured | Guest `cat` workload with backpressure and vCPU counters |
| GUI compositor FPS at 1080p | Unmeasured | Live desktop and hardware frame traces |
| GUI input → photon | Unmeasured | Live desktop plus presentation latency measurement |
| Idle guest host memory | Unmeasured | Booted guest and process/worker memory attribution |
| Compressed idle snapshot size | Unmeasured | VM snapshot codec and booted guest |
| No filesystem corruption | Unmeasured | Guest ext4 plus tab-kill/power-loss fault injection and fsck |
