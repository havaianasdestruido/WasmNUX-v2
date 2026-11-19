/**
 * Orchestrator for the SMP spike (Spike B).
 */
import { Worker } from 'node:worker_threads';
import { performance } from 'node:perf_hooks';
import type { Job, JobResult } from './vcpu-worker.js';
import { GuestMemory } from './guest-atomics.js';

export interface ScalingPoint {
  workers: number;
  wallMs: number;
  /** wall(1) / wall(n) */
  speedup: number;
  /** speedup / workers */
  efficiency: number;
  correct: boolean;
}

function workerUrl(): URL {
  return new URL('./vcpu-worker.js', import.meta.url);
}

export function spawnJob(job: Job): Promise<JobResult> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(workerUrl());
    worker.on('message', (msg: { t: string; result?: JobResult; message?: string }) => {
      if (msg.t === 'done') { worker.terminate(); resolve(msg.result!); }
      else if (msg.t === 'error') { worker.terminate(); reject(new Error(msg.message)); }
    });
    worker.on('error', reject);
    worker.postMessage({ t: 'start', job });
  });
}

export async function amoAddScaling(maxWorkers: number, iterationsPerWorker: number): Promise<ScalingPoint[]> {
  const points: ScalingPoint[] = [];
  let baseWall = 0;
  for (let n = 1; n <= maxWorkers; n++) {
    const buffer = new SharedArrayBuffer(16);
    const epochs = new GuestMemory(16).epochsBuffer;
    const t0 = performance.now();
    await Promise.all(Array.from({ length: n }, () =>
      spawnJob({ kind: 'amoadd', buffer, epochs, counterAddr: 0, iterations: iterationsPerWorker })));
    const wallMs = performance.now() - t0;
    const got = new BigInt64Array(buffer)[0]!;
    const correct = got === BigInt(n * iterationsPerWorker);
    if (n === 1) baseWall = wallMs;
    points.push({ workers: n, wallMs, speedup: baseWall / wallMs, efficiency: baseWall / wallMs / n, correct });
  }
  return points;
}

export async function spinlockScaling(maxWorkers: number, iterationsPerWorker: number, criticalWork: number): Promise<ScalingPoint[]> {
  const points: ScalingPoint[] = [];
  let baseWall = 0;
  for (let n = 1; n <= maxWorkers; n++) {
    const buffer = new SharedArrayBuffer(64);
    const epochs = new GuestMemory(64).epochsBuffer;
    const i32 = new Int32Array(buffer);
    const t0 = performance.now();
    await Promise.all(Array.from({ length: n }, () =>
      spawnJob({ kind: 'spinlock', buffer, epochs, lockAddr: 0, plainCellAddr: 8, iterations: iterationsPerWorker, criticalWork })));
    const wallMs = performance.now() - t0;
    const cell = i32[2]!; // plainCellAddr 8 -> i32 index 2
    const correct = cell === n * iterationsPerWorker;
    if (n === 1) baseWall = wallMs;
    points.push({ workers: n, wallMs, speedup: baseWall / wallMs, efficiency: baseWall / wallMs / n, correct });
  }
  return points;
}

export interface HashScalingResult {
  workers: number;
  wallMs: number;
  speedup: number;
  efficiency: number;
  hash: string;
}

export async function hashScaling(maxWorkers: number, totalIterations: number): Promise<HashScalingResult[]> {
  const points: HashScalingResult[] = [];
  let baseWall = 0;
  for (let n = 1; n <= maxWorkers; n++) {
    const perWorker = Math.floor(totalIterations / n);
    const t0 = performance.now();
    const results = await Promise.all(Array.from({ length: n }, (_, i) =>
      spawnJob({ kind: 'hash', start: i * perWorker, iterations: perWorker })));
    const wallMs = performance.now() - t0;
    // combine: xor of sub-hashes (order-independent; a workload checksum, not a correctness oracle)
    let h = 0n;
    for (const r of results) if (r.kind === 'hash') h ^= BigInt('0x' + r.hash);
    if (n === 1) baseWall = wallMs;
    points.push({ workers: n, wallMs, speedup: baseWall / wallMs, efficiency: baseWall / wallMs / n, hash: h.toString(16) });
  }
  return points;
}

export interface WakeResult {
  wokeNs: number;          // latency from notify to wake (hrtime delta)
  waitResult: string;      // 'ok' | 'not-equal' | 'timed-out'
  attempts: number;        // attempts until a parked ('ok') measurement was obtained
}

/**
 * Measures the wake latency of a worker parked in Atomics.wait. The worker
 * announces 'waiting' right before parking; the parent only stores+notifies
 * after receiving it. Runs where the worker still wins the race against the
 * store ('not-equal') are retried, since they measure nothing.
 */
export async function measureWakeLatency(maxAttempts = 5): Promise<WakeResult> {
  for (let attempts = 1; attempts <= maxAttempts; attempts++) {
    const buffer = new SharedArrayBuffer(16);
    const i32 = new Int32Array(buffer);
    const worker = new Worker(workerUrl());
    const clock: { t0: bigint } = { t0: 0n };
    const result = await new Promise<JobResult>((resolve, reject) => {
      worker.on('message', (msg: { t: string; result?: JobResult; message?: string }) => {
        if (msg.t === 'waiting') {
          clock.t0 = process.hrtime.bigint();
          Atomics.store(i32, 0, 1);
          Atomics.notify(i32, 0, 1);
        } else if (msg.t === 'done') {
          resolve(msg.result!);
        } else if (msg.t === 'error') {
          reject(new Error(msg.message));
        }
      });
      worker.on('error', reject);
      worker.postMessage({ t: 'start', job: { kind: 'wait', buffer, controlAddr: 0, timeoutMs: 2000 } satisfies Job });
    });
    await worker.terminate();
    if (result.kind !== 'wait') throw new Error('unexpected result');
    if (result.result === 'ok') {
      return { wokeNs: Number(BigInt(result.wokeAtNs) - clock.t0), waitResult: 'ok', attempts };
    }
  }
  return { wokeNs: 0, waitResult: 'not-equal', attempts: maxAttempts };
}

export interface LitmusResult {
  kind: 'litmus-sb' | 'litmus-lb';
  rounds: number;
  /** rounds where the forbidden outcome was observed */
  forbidden: number;
  /** rounds where both threads read each other's store (SB: both fresh; LB: both fresh) */
  bothFresh: number;
  bothStale: number;
  mixed: number;
}

export async function runLitmus(kind: 'litmus-sb' | 'litmus-lb', rounds: number): Promise<LitmusResult> {
  // i32 layout: [trace0: 1..rounds][trace1: rounds+1..2*rounds][x][y]
  const xIdx = 2 * rounds + 1;
  const yIdx = 2 * rounds + 2;
  const buffer = new SharedArrayBuffer((2 * rounds + 3) * 4);
  const [r0, r1] = await Promise.all([
    spawnJob({ kind, buffer, xIdx, yIdx, traceBase: 0, role: 0, rounds }),
    spawnJob({ kind, buffer, xIdx, yIdx, traceBase: rounds, role: 1, rounds }),
  ]);
  void r0; void r1;
  const i32 = new Int32Array(buffer);
  let forbidden = 0, bothFresh = 0, bothStale = 0, mixed = 0;
  for (let r = 1; r <= rounds; r++) {
    const a = i32[r]!;         // role-0 read (value seen: 0/stale or round epoch)
    const b = i32[rounds + r]!; // role-1 read
    const freshA = a >= r;
    const freshB = b >= r;
    if (freshA && freshB) bothFresh++;
    else if (!freshA && !freshB) bothStale++;
    else mixed++;
    if (kind === 'litmus-sb') {
      if (!freshA && !freshB) forbidden++;   // both read stale: forbidden under seq_cst
    } else {
      if (freshA && freshB) forbidden++;     // both read fresh: forbidden under seq_cst
    }
  }
  return { kind, rounds, forbidden, bothFresh, bothStale, mixed };
}
