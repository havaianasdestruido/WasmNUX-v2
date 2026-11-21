import { normalizeSmpOptions } from './options.ts';
/**
 * Real multi-hart execution on `worker_threads`.
 *
 * One shared `WebAssembly.Memory` and one shared `SmpChannel` are created here
 * and structured-cloned into N hart workers. Each worker runs the same guest
 * image through the interpreter tier, with its own `CpuState` and `hartId`.
 * This is genuine concurrency: the workers run simultaneously and communicate
 * only through shared memory and the channel's atomics.
 *
 * Node transport. The browser transport in host/src/smp.ts uses the same runHart entry.
 */

import { Worker } from 'node:worker_threads';
import { SmpChannel } from './channel.ts';

import type { SmpRunOptions, SmpHartResult, SmpRunResult } from './types.ts';
export type { SmpRunOptions, SmpHartResult, SmpRunResult } from './types.ts';
function workerUrl(): URL {
  return new URL('./worker-bootstrap.mjs', import.meta.url);
}

/**
 * Run `program` on `harts` workers. Resolves with one result per hart, in hart
 * order. Rejects if any worker errors or exits without a result.
 */
export async function runSmp(opts: SmpRunOptions): Promise<SmpRunResult> {
  const { timeoutMs, ramBytes, ramBase, harts } = normalizeSmpOptions(opts);
  const pages = ramBytes / 65536;
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
          ramBase,
          ramBytes: pages * 65536,
        },
      });
      workers.push(worker);
      worker.on('message', (msg: SmpHartResult & { error?: string }) => {
        if (msg.error) {
          reject(new Error(`hart ${h}: ${msg.error}`));
          return;
        }
        if (msg.hartId !== h || results[h] !== null) {
          reject(new Error(`hart ${h}: invalid or duplicate result`));
          return;
        }
        results[h] = msg;
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

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`SMP execution timed out after ${timeoutMs} ms`)), timeoutMs);
  });
  try {
    await Promise.race([done, timeout]);
    return { harts: results as SmpHartResult[], memory };
  } finally {
    clearTimeout(timer);
    await Promise.all(workers.map((w) => w.terminate()));
  }
}
