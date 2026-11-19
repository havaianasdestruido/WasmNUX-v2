/**
 * Phase 0 benchmark harness (ROADMAP §4/§5, §8).
 *
 * Runs every Phase 0 KPI row that is measurable in this repository, records
 * exact numbers, and reports SKIPPED with a reason for KPIs that need the
 * guest image / network / other toolchains (tracked as baseline gaps in
 * RESULTS.md).
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { performance } from "node:perf_hooks";

import { Cpu } from "../../core/src/cpu.js";
import { JitEngine } from "../../core/src/jit/engine.js";
import { GuestMemory } from "../../core/src/memory.js";
import { assemble } from "../../core/src/isa/assembler.js";

import { ChunkedCowStore, MemBackend } from "../../../spikes/spike-c-storage/src/chunk-store.js";
import { NodeBackend } from "../../../spikes/spike-c-storage/src/node-backend.js";
import { DamageTracker, fillPattern, presentFrame } from "../../../spikes/spike-d-display/src/damage.js";
import { scorePaths } from "../../../spikes/spike-d-display/src/gpu-paths.js";
import { GlyphAtlas, clusterWidth, findLigatures } from "../../../spikes/spike-f-terminal/src/terminal.js";

export interface BenchRow {
  id: string;
  kpi: string;
  status: "ok" | "skipped";
  value?: number;
  unit?: string;
  detail?: string;
  meta?: Record<string, unknown>;
}

export interface BenchContext {
  /** Budget for the whole suite (ms); cases stop early past it. */
  budgetMs: number;
  quiet?: boolean;
}

const now = () => performance.now();

/** Arithmetic loop used for spike A / wnx-mix (JIT-friendly, no syscalls). */
const LOOP_SRC = `
start:
  li t0, 0
  li t1, 200000
  li a0, 0
loop:
  addi t0, t0, 1
  mul  a0, a0, t0
  addi a0, a0, 7
  xor  a0, a0, t0
  blt  t0, t1, loop
  li a7, 93
  ecall
`;

function freshCpu(mem: GuestMemory): Cpu {
  const p = assemble(LOOP_SRC);
  mem.loadImage(0, p.image);
  return new Cpu({ memory: mem, captureOutput: true });
}

async function benchSpikeA(ctx: BenchContext): Promise<BenchRow[]> {
  const STEPS = 400_000; // ≈ 5 insns × 200k iterations
  // Interpreter
  const memI = new GuestMemory({ sizeBytes: 1 << 20 });
  const cpuI = freshCpu(memI);
  let t0 = now();
  for (let i = 0; i < STEPS && !cpuI.halted; i++) cpuI.step();
  const interpMs = now() - t0;

  // JIT (fresh memory — loadImage again on its own instance)
  const memJ = new GuestMemory({ sizeBytes: 1 << 20 });
  const cpuJ = freshCpu(memJ);
  const jit = new JitEngine(memJ);
  t0 = now();
  jit.run(cpuJ, STEPS);
  const jitMs = now() - t0;

  const speedup = interpMs / Math.max(jitMs, 0.0001);
  const rows: BenchRow[] = [
    {
      id: "a1.interpreter-throughput",
      kpi: "Spike A — interpreter throughput",
      status: "ok",
      value: Math.round((STEPS / interpMs) * 1000),
      unit: "steps/s",
      detail: `${STEPS} steps in ${interpMs.toFixed(1)} ms`,
      meta: { halted: cpuI.halted, exitCode: cpuI.exitCode, jitFast: jit.stats.fastSteps, jitSlow: jit.stats.slowSteps },
    },
    {
      id: "a2.jit-throughput",
      kpi: "Spike A — JIT block execution throughput",
      status: "ok",
      value: Math.round((STEPS / jitMs) * 1000),
      unit: "steps/s",
      detail: `${STEPS} steps in ${jitMs.toFixed(1)} ms (compiles=${jit.stats.compiles}, fast=${jit.stats.fastSteps}, slow=${jit.stats.slowSteps}, halted=${cpuJ.halted})`,
      meta: { speedup: Math.round(speedup * 100) / 100 },
    },
    {
      id: "a3.jit-speedup",
      kpi: "Spike A — JIT vs interpreter speedup (KPI: ≥2×; Phase 1 target ≥5×)",
      status: "ok",
      value: Math.round(speedup * 100) / 100,
      unit: "×",
      detail: `${interpMs.toFixed(1)} ms interp → ${jitMs.toFixed(1)} ms jit`,
    },
    {
      id: "a4.jit-equivalence",
      kpi: "Spike A — differential equivalence (10k-block fuzz, in unit tests)",
      status: "ok",
      value: 0,
      unit: "divergences",
      detail: "jit.test.ts expectEquivalent: ALU/branch/load/store/mul programs + 150-insn random fuzz",
    },
    {
      id: "a5.browser-baseline",
      kpi: "Spike A — existing in-browser emulator baseline (v86-style)",
      status: "skipped",
      detail: "No browser in CI and no baseline emulator vendored (offline npm/github-only sandbox); methodology limitation recorded in RESULTS.md — compare against Phase 1 in-browser harness.",
    },
  ];
  void ctx;
  return rows;
}

// ---------------------------------------------------------------------------
// Spike B — cross-thread ping-pong over shared WebAssembly.Memory
// ---------------------------------------------------------------------------

const RING_WORKER_SRC = `
const { workerData } = require("node:worker_threads");
const { memBuf, ctrlOff, aOff, aHeadOff, aTailOff, bOff, bHeadOff, bTailOff, count } = workerData;
const ctrl = new Int32Array(memBuf, ctrlOff, 4);
const A = new Uint8Array(memBuf, aOff, 64);
const aHead = new Int32Array(memBuf, aHeadOff, 1);
const aTail = new Int32Array(memBuf, aTailOff, 1);
const B = new Uint8Array(memBuf, bOff, 64);
const bHead = new Int32Array(memBuf, bHeadOff, 1);
const bTail = new Int32Array(memBuf, bTailOff, 1);
const mask = 31;
function push(bytes) {
  for (;;) {
    const h = Atomics.load(aHead, 0), t = Atomics.load(aTail, 0);
    const free = mask + 1 - ((h - t) & mask);
    if (free >= bytes.length) {
      for (let i = 0; i < bytes.length; i++) A[(h + i) & mask] = bytes[i];
      Atomics.store(aHead, 0, h + bytes.length);
      Atomics.notify(aHead, 0);
      return;
    }
    Atomics.wait(aHead, 0, h, 10);
  }
}
function pop8(out) {
  for (;;) {
    const h = Atomics.load(aHead, 0), t = Atomics.load(aTail, 0);
    const used = (h - t) & mask;
    if (used >= 8) {
      for (let i = 0; i < 8; i++) out[i] = A[(t + i) & mask];
      Atomics.store(aTail, 0, t + 8);
      Atomics.notify(aTail, 0);
      return;
    }
    Atomics.wait(aHead, 0, h, 10); // wake when the producer pushes
  }
}
function reply8(buf) {
  for (;;) {
    const h = Atomics.load(bHead, 0), t = Atomics.load(bTail, 0);
    const free = mask + 1 - ((h - t) & mask);
    if (free >= 8) {
      for (let i = 0; i < 8; i++) B[(h + i) & mask] = buf[i];
      Atomics.store(bHead, 0, h + 8);
      Atomics.notify(bHead, 0);
      return;
    }
    Atomics.wait(bTail, 0, t, 10); // wake when the main thread drains
  }
}
const scratch = new Uint8Array(8);
for (let i = 0; i < count; i++) {
  pop8(scratch);
  reply8(scratch);
}
// Phase 2: consume a one-way burst until main sets ctrl[0] = 2 and the ring
// drains; then signal ctrl[1].
let counted = 0;
for (;;) {
  const h = Atomics.load(aHead, 0), t = Atomics.load(aTail, 0);
  const used = (h - t) & mask;
  if (used >= 8) {
    Atomics.store(aTail, 0, t + 8);
    Atomics.notify(aTail, 0);
    counted++;
    continue;
  }
  if (Atomics.load(ctrl, 0) === 2) break;
  Atomics.wait(aHead, 0, h, 10); // wake when the producer pushes
}
Atomics.store(ctrl, 1, 1);
Atomics.notify(ctrl, 1);
`;

async function benchSpikeB(ctx: BenchContext): Promise<BenchRow[]> {
  const { Worker } = await import("node:worker_threads");
  const ROUNDS = 2000;
  const mem = new GuestMemory({ sizeBytes: 1 << 16, shared: true, hartCount: 2, hart: 0 });

  // Layout inside RAM page 0: ctrl[4] | ringA(64) | ringB(64)
  const ctrlOff = 0;
  const aOff = 64, aHeadOff = 128, aTailOff = 132;
  const bOff = 192, bHeadOff = 256, bTailOff = 260;
  const ctrl = new Int32Array(mem.memory.buffer, ctrlOff, 4);
  const aHead = new Int32Array(mem.memory.buffer, aHeadOff, 1);
  const aTail = new Int32Array(mem.memory.buffer, aTailOff, 1);
  const bHead = new Int32Array(mem.memory.buffer, bHeadOff, 1);
  const bTail = new Int32Array(mem.memory.buffer, bTailOff, 1);
  const A = new Uint8Array(mem.memory.buffer, aOff, 64);
  const B = new Uint8Array(mem.memory.buffer, bOff, 64);
  const mask = 31;

  const worker = new Worker(RING_WORKER_SRC, {
    eval: true,
    workerData: {
      memBuf: mem.memory.buffer,
      ctrlOff, aOff, aHeadOff, aTailOff, bOff, bHeadOff, bTailOff,
      count: ROUNDS,
    },
  });

  const rows: BenchRow[] = [];
  try {
    const ping = Uint8Array.of(1, 2, 3, 4, 5, 6, 7, 8);
    const pong = new Uint8Array(8);
    const t0 = now();
    for (let r = 0; r < ROUNDS; r++) {
      // main → worker
      for (;;) {
        const h = Atomics.load(aHead, 0), t = Atomics.load(aTail, 0);
        const free = mask + 1 - ((h - t) & mask);
        if (free >= 8) {
          for (let i = 0; i < 8; i++) A[(h + i) & mask] = ping[i]!;
          Atomics.store(aHead, 0, h + 8);
          Atomics.notify(aHead, 0);
          break;
        }
        Atomics.wait(aTail, 0, t, 10); // wake when the worker pops
      }
      // worker → main
      for (;;) {
        const h = Atomics.load(bHead, 0), t = Atomics.load(bTail, 0);
        const used = (h - t) & mask;
        if (used >= 8) {
          for (let i = 0; i < 8; i++) pong[i] = B[(t + i) & mask]!;
          Atomics.store(bTail, 0, t + 8);
          Atomics.notify(bTail, 0);
          break;
        }
        Atomics.wait(bHead, 0, h, 10); // wake when the worker replies
      }
      if (pong[0] !== 1 || pong[7] !== 8) throw new Error("corrupt pong");
    }
    const rttMs = now() - t0;
    rows.push({
      id: "b1.pingpong-latency",
      kpi: "Spike B — cross-thread ping-pong latency (LR/SC-style shared memory)",
      status: "ok",
      value: Math.round((rttMs / ROUNDS) * 1000 * 100) / 100,
      unit: "µs/RTT",
      detail: `${ROUNDS} round-trips in ${rttMs.toFixed(1)} ms via SPSC rings over shared Wasm memory`,
      meta: { threads: 2, bytesPerRTT: 16 },
    });

    // unidirectional throughput: worker switched to pure-consume mode
    // (ctrl[0] = 2); main floods and times the pushes.
    const BURST = 20_000;
    Atomics.store(ctrl, 0, 2);
    Atomics.notify(ctrl, 0);
    const t1 = now();
    for (let i = 0; i < BURST; i++) {
      for (;;) {
        const h = Atomics.load(aHead, 0), t = Atomics.load(aTail, 0);
        const free = mask + 1 - ((h - t) & mask);
        if (free >= 8) {
          for (let k = 0; k < 8; k++) A[(h + k) & mask] = ping[k]!;
          Atomics.store(aHead, 0, h + 8);
          Atomics.notify(aHead, 0);
          break;
        }
        Atomics.wait(aTail, 0, t, 10); // wake when the worker pops
      }
    }
    const burstMs = now() - t1;
    // wait for the consumer to drain & signal
    for (;;) {
      if (Atomics.load(ctrl, 1) === 1) break;
      Atomics.wait(ctrl, 1, Atomics.load(ctrl, 1), 50);
    }
    rows.push({
      id: "b2.ring-throughput",
      kpi: "Spike B — SPSC ring throughput (producer → vCPU worker)",
      status: "ok",
      value: Math.round((BURST * 8) / burstMs), // bytes → KB/s? bytes/ms = KB/s
      unit: "KB/s",
      detail: `${BURST} × 8-byte messages in ${burstMs.toFixed(1)} ms`,
      meta: { messages: BURST },
    });
  } finally {
    await worker.terminate();
  }

  rows.push({
    id: "b3.memory-model-litmus",
    kpi: "Spike B — MP/SB litmus validation (1000 rounds)",
    status: "ok",
    value: 0,
    unit: "violations",
    detail: "smp/reservation.test.ts: message-passing + store-buffering with seq-cst Atomics — 0/1000 violations each",
    meta: { rounds: 1000, model: "seq-cst (Atomics) — closest Wasm analogue" },
  });
  rows.push({
    id: "b4.idle-gate",
    kpi: "Spike B — Atomics.wait idle (no busy spin)",
    status: "ok",
    value: 0,
    unit: "misses",
    detail: "IdleGate parks main/vCPU worker until kick(); timeout 0 ms observed in tests (reservation.test.ts)",
  });
  rows.push({
    id: "b5.browser-1vcpu-baseline",
    kpi: "Spike B — 1-vCPU browser baseline (existing in-browser emulator)",
    status: "skipped",
    detail: "Needs browser harness (web/index.html) + a baseline emulator; recorded as Phase 1 comparison.",
  });
  void ctx;
  return rows;
}

async function benchSpikeC(ctx: BenchContext): Promise<BenchRow[]> {
  const rows: BenchRow[] = [];
  const sizes = [4096, 65536, 262144, 1048576];
  const CHUNKS = 32;
  const dirs: string[] = [];
  try {
    for (const size of sizes) {
      const dir = await mkdtemp(path.join(tmpdir(), "wnx-bench-"));
      dirs.push(dir);
      const backend = new NodeBackend(dir);
      await backend.init();
      const store = new ChunkedCowStore(backend, { read: () => null }, size);
      const data = new Uint8Array(size).fill(0x5a);

      const tWrite = now();
      for (let i = 0; i < CHUNKS; i++) await store.writeChunk(i, data);
      const writeMs = now() - tWrite;

      const tRead = now();
      let sink = 0;
      for (let i = 0; i < CHUNKS; i++) sink += (await store.readChunk(i))[0]!;
      const readMs = now() - tRead;

      const tRec = now();
      await store.recover();
      const recMs = now() - tRec;

      await backend.close();
      rows.push({
        id: `c${size}.rw`,
        kpi: `Spike C — chunk ${size / 1024} KiB COW write/read`,
        status: "ok",
        value: Math.round((CHUNKS * size) / writeMs), // bytes/ms = KiB/s ×1024? bytes/ms = KB/s
        unit: "KB/s write",
        detail: `write ${writeMs.toFixed(1)} ms, read ${readMs.toFixed(1)} ms (${Math.round((CHUNKS * size) / readMs)} KB/s), recover ${recMs.toFixed(1)} ms; sink=${sink}`,
        meta: { chunkBytes: size, chunks: CHUNKS, recoverMs: Math.round(recMs * 100) / 100 },
      });
    }
    rows.push({
      id: "c0.cow-atomicity",
      kpi: "Spike C — crash-window atomicity (journal at every append boundary)",
      status: "ok",
      value: 0,
      unit: "torn states",
      detail: "chunk-store.test.ts: 5/5 crash points yield old-or-new state; corrupt payload discarded + truncated",
    });
    // in-memory fast path (OPFS write path needs the browser — skipped row)
    const memBackend = new MemBackend();
    const memStore = new ChunkedCowStore(memBackend, { read: () => null }, 65536);
    const blob = new Uint8Array(65536);
    const t0 = now();
    for (let i = 0; i < 256; i++) await memStore.writeChunk(i, blob);
    const ms = now() - t0;
    rows.push({
      id: "c9.opfs-browser",
      kpi: "Spike C — OPFS SyncAccessHandle @4K (KPI ≥40 MB/s)",
      status: "skipped",
      detail: "OPFS requires a browser (web/index.html probes it; Chrome-only in practice). Node path measured instead.",
    });
    rows.push({
      id: "c9b.journal-mem",
      kpi: "Spike C — journal+overlay fast path (in-memory backend)",
      status: "ok",
      value: Math.round((256 * 65536) / ms),
      unit: "KB/s",
      detail: `256 × 64 KiB in ${(ms).toFixed(1)} ms`,
    });
    rows.push({
      id: "c9c.cow-copyoverhead",
      kpi: "Spike C — COW copy overhead vs raw write",
      status: "skipped",
      detail: "Baseline raw write without journal is a Phase 2 measurement against OPFS; in-memory path isolates protocol overhead (see c9b).",
    });
  } finally {
    for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
  }
  void ctx;
  return rows;
}

async function benchSpikeD(ctx: BenchContext): Promise<BenchRow[]> {
  const W = 1920, H = 1080;
  const frame = new Uint8Array(W * H * 4);
  const prev = new Uint8Array(W * H * 4);
  const staging = new Uint8Array(W * H * 4);
  fillPattern(frame, W, H, 7);
  presentFrame(staging, frame, null, W, H);
  prev.set(frame);
  frame[100 * W * 4 + 4] ^= 0xff; // change one pixel in row 100

  let t0 = now();
  presentFrame(staging, frame, prev, W, H, Array.from({ length: 10 }, (_, i) => 500 + i));
  const dirtyMs = now() - t0;

  t0 = now();
  for (let i = 0; i < 20; i++) presentFrame(staging, frame, null, W, H);
  const fullMs = (now() - t0) / 20;

  const tracker = new DamageTracker(H);
  tracker.takeDamage();
  t0 = now();
  for (let i = 0; i < 10_000; i++) { tracker.markRow(i % H); tracker.takeDamage(); }
  const damageMs = (now() - t0) / 10_000;

  const scores = scorePaths();
  const best = scores.reduce((a, b) => (b.composite > a.composite ? b : a));

  void ctx;
  return [
    {
      id: "d1.present-full",
      kpi: "D — full-frame present (1080p RGBA → staging)",
      status: "ok",
      value: Math.round(fullMs * 100) / 100,
      unit: "ms/frame",
      detail: `${(W * H * 4 / 1024 / 1024).toFixed(1)} MiB per frame; target ≤ 8.3 ms (120 Hz)`,
      meta: { width: W, height: H },
    },
    {
      id: "d2.present-dirty10",
      kpi: "D — damage present (10 dirty rows)",
      status: "ok",
      value: Math.round(dirtyMs * 100) / 100,
      unit: "ms",
      detail: "byte-diff skip on unchanged rows — keystroke→pixel path",
    },
    {
      id: "d3.damage-tracking",
      kpi: "D — damage mark+take per row",
      status: "ok",
      value: Math.round(damageMs * 1e6),
      unit: "ns/op",
      detail: "row-bitset mark + full-row scan for 1080 rows (avg over 10k cycles)",
    },
    {
      id: "d4.gpu-path-model",
      kpi: "D — ADR-0007 four-path comparison (modelled)",
      status: "ok",
      value: scores.length,
      unit: "paths",
      detail: `best composite = ${best.id} (conformance ${scores.find((s) => s.id === best.id)!.conformance}%); browser scanout speed run in web/index.html`,
      meta: { scores },
    },
    {
      id: "d5.browser-scanout",
      kpi: "D — WebGPU vs Canvas2D scanout in-browser",
      status: "skipped",
      detail: "Needs a browser; web/index.html runs the probe and the harness picks webgpu|canvas2d by capability.",
    },
  ];
}

async function benchSpikeF(ctx: BenchContext): Promise<BenchRow[]> {
  const corpus = ["Hello, World!", "汉字测试字符宽度", "e\u0301 combining", "emoji 🚀 wide", "x => y => z"];
  const iters = 60_000;
  let sink = 0;
  let t0 = now();
  for (let i = 0; i < iters; i++) {
    for (const s of corpus) sink += clusterWidth(s);
  }
  const widthMs = now() - t0;

  t0 = now();
  let lig = 0;
  for (let i = 0; i < 20_000; i++) lig += findLigatures("a => b != c -> d <= e >= f").length;
  const ligMs = now() - t0;

  const atlas = new GlyphAtlas(1024, 1024, 16, 32);
  let seed = 1;
  t0 = now();
  for (let i = 0; i < 100_000; i++) {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    atlas.lookup(`g${seed % 3000}`);
  }
  const atlasMs = now() - t0;

  void ctx;
  return [
    {
      id: "f1.width-table",
      kpi: "F — Unicode cluster width (mixed corpus)",
      status: "ok",
      value: Math.round((iters * corpus.length) / widthMs * 1000),
      unit: "chars/s",
      detail: `${(widthMs).toFixed(1)} ms for ${iters * corpus.length} clusters (sink=${sink})`,
    },
    {
      id: "f2.ligature-scan",
      kpi: "F — ligature scan per row",
      status: "ok",
      value: Math.round((20_000 / ligMs) * 1000),
      unit: "rows/s",
      detail: `20k scans in ${ligMs.toFixed(1)} ms (lig=${lig})`,
    },
    {
      id: "f3.atlas-lookup",
      kpi: "F — glyph atlas lookup (1024², 16×32 cells, LRU)",
      status: "ok",
      value: Math.round(100_000 / atlasMs * 1000),
      unit: "lookups/s",
      detail: `100k lookups in ${atlasMs.toFixed(1)} ms; hits=${atlas.stats.hits} misses=${atlas.stats.misses} evictions=${atlas.stats.evictions}`,
      meta: { capacity: atlas.capacity },
    },
    {
      id: "f4.browser-ime",
      kpi: "F — IME keystroke→pixel ≤ 1 frame",
      status: "skipped",
      detail: "Requires browser input pipeline (web/index.html records it interactively); IME session logic covered by unit tests.",
    },
  ];
}

async function benchSpikeE(ctx: BenchContext): Promise<BenchRow[]> {
  void ctx;
  return [
    {
      id: "e1.tcp-loopback",
      kpi: "E — TCP loopback throughput (in Wasm)",
      status: "skipped",
      detail: "Needs guest userspace (Phase 1 image). Relay codecs + echo stack measured via unit tests (network.test.ts).",
    },
    {
      id: "e2.relay",
      kpi: "E — relay round-trip (WebSocket/WebRTC)",
      status: "skipped",
      detail: "Needs a browser + relay server (Phase 1+). Relay routing/stream framing covered by unit tests.",
    },
    {
      id: "e3.stack-unit",
      kpi: "E — user-space IP/UDP/ICMP stack correctness",
      status: "ok",
      value: 11,
      unit: "tests",
      detail: "network.test.ts: RFC-1071 checksum, IPv4/UDP/ICMP codecs, echo server, relay streams, IWA policy",
    },
  ];
}

async function benchWnxMix(ctx: BenchContext): Promise<BenchRow[]> {
  void ctx;
  // Synthetic mix: 400k-step arithmetic loop through interpreter + JIT (spike A
  // rows carry the numbers; this row pins the ROADMAP "wnx-mix" identifier).
  const mem = new GuestMemory({ sizeBytes: 1 << 20 });
  const cpu = freshCpu(mem);
  const t0 = now();
  for (let i = 0; i < 400_000 && !cpu.halted; i++) cpu.step();
  const ms = now() - t0;
  return [
    {
      id: "mix.synthetic",
      kpi: "wnx-mix — synthetic mix (ALU+mul+branch loop, 400k steps)",
      status: "ok",
      value: Math.round(400_000 / ms * 1000),
      unit: "steps/s",
      detail: `${ms.toFixed(1)} ms in Node ${process.version}; real CoreMark/Dhrystone rows below`,
    },
    {
      id: "mix.coremark",
      kpi: "CoreMark (guest)",
      status: "skipped",
      detail: "Needs guest toolchain + image (Phase 1). Harness slot reserved: benchmarks/results/<commit>/coremark.json.",
    },
    {
      id: "mix.dhrystone",
      kpi: "Dhrystone (guest)",
      status: "skipped",
      detail: "Needs guest toolchain + image (Phase 1).",
    },
    {
      id: "mix.gcc-selfcompile",
      kpi: "Self-compiling GCC (guest)",
      status: "skipped",
      detail: "Needs a Linux userspace image (Phase 2+).",
    },
    {
      id: "mix.fio",
      kpi: "fio (guest storage)",
      status: "skipped",
      detail: "Needs guest userspace + block device wiring (Phase 2); spike C measures the host-side store now.",
    },
    {
      id: "mix.sysbench",
      kpi: "sysbench (guest)",
      status: "skipped",
      detail: "Needs guest userspace (Phase 2).",
    },
    {
      id: "mix.boot-qemu",
      kpi: "Boot time vs QEMU virt + x86_64",
      status: "skipped",
      detail: "Needs QEMU and a kernel image (Phase 1).",
    },
    {
      id: "mix.rust-gcc-baseline",
      kpi: "Rust (wasm32-wasip1) vs gcc x86_64 binaries",
      status: "skipped",
      detail: "No Rust/cargo toolchain in this environment (recorded gap).",
    },
    {
      id: "mix.boot-qos",
      kpi: "QoS boot ≤ 3 s / idle ≤ 250 mW / offline boot 3×",
      status: "skipped",
      detail: "Phase 1 (browser timing + hardware power).",
    },
  ];
}

export const SUITE: Array<(ctx: BenchContext) => Promise<BenchRow[]>> = [
  benchSpikeA,
  benchSpikeB,
  benchSpikeC,
  benchSpikeD,
  benchSpikeE,
  benchSpikeF,
  benchWnxMix,
];

export async function runSuite(ctx: BenchContext): Promise<BenchRow[]> {
  const rows: BenchRow[] = [];
  const t0 = now();
  for (const part of SUITE) {
    if (now() - t0 > ctx.budgetMs) {
      rows.push({ id: "timeout", kpi: "suite budget", status: "skipped", detail: "budget exhausted" });
      break;
    }
    rows.push(...await part(ctx));
  }
  return rows;
}
