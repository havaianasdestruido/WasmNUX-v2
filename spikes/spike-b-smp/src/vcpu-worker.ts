/**
 * vCPU worker entry point (Spike B). Each worker models one guest hart.
 * Protocol (worker_threads messages):
 *   parent -> worker: { t: 'start', job: Job }
 *   worker -> parent: { t: 'done', result: JobResult } | { t: 'error', message: string }
 */
import { parentPort } from 'node:worker_threads';
import { GuestMemory, Reservation, guestSpinLock, guestSpinUnlock } from './guest-atomics.js';

export type Job =
  | { kind: 'amoadd'; buffer: SharedArrayBuffer; epochs?: SharedArrayBuffer; counterAddr: number; iterations: number }
  | { kind: 'spinlock'; buffer: SharedArrayBuffer; epochs?: SharedArrayBuffer; lockAddr: number; plainCellAddr: number; iterations: number; criticalWork: number }
  | { kind: 'hash'; start: number; iterations: number }
  | { kind: 'litmus-sb'; buffer: SharedArrayBuffer; xIdx: number; yIdx: number; traceBase: number; role: 0 | 1; rounds: number }
  | { kind: 'litmus-lb'; buffer: SharedArrayBuffer; xIdx: number; yIdx: number; traceBase: number; role: 0 | 1; rounds: number }
  | { kind: 'wait'; buffer: SharedArrayBuffer; controlAddr: number; timeoutMs: number };

export type JobResult =
  | { kind: 'amoadd'; done: number }
  | { kind: 'spinlock'; done: number }
  | { kind: 'hash'; hash: string }
  | { kind: 'litmus-sb'; done: number }
  | { kind: 'litmus-lb'; done: number }
  | { kind: 'wait'; wokeAtNs: string; result: string };

parentPort!.on('message', (msg: { t: string; job: Job }) => {
  try {
    const job = msg.job;
    let result: JobResult;
    switch (job.kind) {
      case 'amoadd': {
        const g = GuestMemory.wrap(job.buffer, job.epochs);
        for (let i = 0; i < job.iterations; i++) g.amoAdd(job.counterAddr, 1n);
        result = { kind: 'amoadd', done: job.iterations };
        break;
      }
      case 'spinlock': {
        const g = GuestMemory.wrap(job.buffer, job.epochs);
        const res = new Reservation();
        const i32 = new Int32Array(job.buffer);
        const idx = job.plainCellAddr / 4;
        for (let i = 0; i < job.iterations; i++) {
          guestSpinLock(g, res, job.lockAddr);
          i32[idx] = i32[idx]! + 1; // unprotected plain RMW: only correct under the guest lock
          for (let w = 0; w < job.criticalWork; w++) {
            i32[idx] = i32[idx]! - 1;
            i32[idx] = i32[idx]! + 1;
          }
          guestSpinUnlock(g, job.lockAddr);
        }
        result = { kind: 'spinlock', done: job.iterations };
        break;
      }
      case 'hash': {
        // Element-independent SplitMix64 fold: worker i hashes keys
        // [start, start+iterations) and xor-combines, so the combined
        // checksum is IDENTICAL for any worker count (verified by bench).
        let h = 0n;
        const M1 = 0x9E3779B97F4A7C15n, M2 = 0xBF58476D1CE4E5B9n, M3 = 0x94D049BB133111EBn;
        for (let k = 0n; k < BigInt(job.iterations); k++) {
          let x = BigInt.asUintN(64, (BigInt(job.start) + k) * M1 + 0x12345678n);
          x = BigInt.asUintN(64, (x ^ (x >> 30n)) * M2);
          x = BigInt.asUintN(64, (x ^ (x >> 27n)) * M3);
          x = x ^ (x >> 31n);
          h ^= x;
        }
        result = { kind: 'hash', hash: h.toString(16) };
        break;
      }
      // Free-running Herlihy-style litmus with per-round epoch tags: locations
      // carry the round number instead of 1, so no reset between rounds is needed.
      // Each thread records the value it read into its trace slot; the parent
      // pairs the two traces post-hoc to detect forbidden outcomes.
      case 'litmus-sb': {
        const i32 = new Int32Array(job.buffer);
        for (let r = 1; r <= job.rounds; r++) {
          if (job.role === 0) {
            Atomics.store(i32, job.xIdx, r);
            i32[job.traceBase + r] = Atomics.load(i32, job.yIdx);
          } else {
            Atomics.store(i32, job.yIdx, r);
            i32[job.traceBase + r] = Atomics.load(i32, job.xIdx);
          }
        }
        result = { kind: 'litmus-sb', done: job.rounds };
        break;
      }
      case 'litmus-lb': {
        const i32 = new Int32Array(job.buffer);
        for (let r = 1; r <= job.rounds; r++) {
          if (job.role === 0) {
            i32[job.traceBase + r] = Atomics.load(i32, job.xIdx);
            Atomics.store(i32, job.yIdx, r);
          } else {
            i32[job.traceBase + r] = Atomics.load(i32, job.yIdx);
            Atomics.store(i32, job.xIdx, r);
          }
        }
        result = { kind: 'litmus-lb', done: job.rounds };
        break;
      }
      case 'wait': {
        const i32 = new Int32Array(job.buffer);
        parentPort!.postMessage({ t: 'waiting' });
        const r = Atomics.wait(i32, job.controlAddr / 4, 0, job.timeoutMs);
        result = { kind: 'wait', wokeAtNs: process.hrtime.bigint().toString(), result: String(r) };
        break;
      }
      default: {
        const never: never = job;
        throw new Error(`unknown job ${JSON.stringify(never)}`);
      }
    }
    parentPort!.postMessage({ t: 'done', result });
  } catch (e) {
    parentPort!.postMessage({ t: 'error', message: String(e) });
  }
});
export {};
