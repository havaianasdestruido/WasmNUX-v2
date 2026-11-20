/**
 * Real multi-hart execution on `worker_threads`.
 *
 * One shared `WebAssembly.Memory` and one shared `SmpChannel` are created here
 * and structured-cloned into N hart workers. Each worker runs the same guest
 * image through the interpreter tier, with its own `CpuState` and `hartId`.
 * This is genuine concurrency: the workers run simultaneously and communicate
 * only through shared memory and the channel's atomics.
 *
 * Node-only experimental runtime; a browser worker transport is not yet implemented.
 */

import { Worker } from 'node:worker_threads';
import { SmpChannel } from './channel.ts';

export interface SmpRunOptions {
  harts: number;
  program: Uint8Array;
  entry: number;
  stackTop: number;
  budget: number;
  ramBytes?: number;
  ramBase?: number;
}

export interface SmpHartResult {
  hartId: number;
  stop: string;
  exitCode: number;
  instret: number;
  regs: number[];
}

export interface SmpRunResult {
  harts: SmpHartResult[];
  /** The shared guest RAM, so callers can verify shared-memory effects. */
  memory: WebAssembly.Memory;
}

function workerUrl(): URL {
  return new URL('./worker-bootstrap.mjs', import.meta.url);
}

/**
 * Run `program` on `harts` workers. Resolves with one result per hart, in hart
 * order. Rejects if any worker errors or exits without a result.
 */
export async function runSmp(opts: SmpRunOptions): Promise<SmpRunResult> {
  if (!Number.isInteger(opts.harts) || opts.harts < 1 || opts.harts > 64)
    throw new RangeError('invalid hart count');
  const harts = opts.harts;
  const ramBytes = Math.max(65536, opts.ramBytes ?? 16 << 20);
  const pages = Math.ceil(ramBytes / 65536);
  const memory = new WebAssembly.Memory({ initial: pages, maximum: pages, shared: true });
  const channel = new SmpChannel(SmpChannel.createShared(harts), harts);

  const results = new Array<SmpHartResult | null>(harts).fill(null);
  const workers: Worker[] = [];

  const done = new Promise<void>((resolve, reject) => {
    let pending = harts;
    for (let h = 0; h < harts; h++) {
      const worker = new Worker(workerUrl(), {
        workerData: {
          memory,
          channel: channel.i32.buffer as SharedArrayBuffer,
          harts,
          hartId: h,
          program: opts.program,
          entry: opts.entry,
          stackTop: opts.stackTop,
          budget: opts.budget,
          ramBase: opts.ramBase ?? 0x80000000,
          ramBytes: pages * 65536,
        },
      });
      workers.push(worker);
      worker.on('message', (msg: SmpHartResult & { error?: string }) => {
        if (msg.error) {
          reject(new Error(`hart ${h}: ${msg.error}`));
          return;
        }
        results[msg.hartId] = msg;
        pending--;
        if (pending === 0) resolve();
      });
      worker.on('error', (err) => reject(new Error(`hart ${h} worker: ${err.message}`)));
      worker.on('exit', (code) => {
        if (results[h] === null) {
          reject(new Error(`hart ${h} worker exited with code ${code}`));
        }
      });
    }
  });

  try {
    await done;
    return { harts: results as SmpHartResult[], memory };
  } finally {
    await Promise.all(workers.map((w) => w.terminate()));
  }
}
