import { normalizeSmpOptions } from '../../core/src/smp/options.ts';
import { SmpChannel } from '../../core/src/smp/channel.ts';
import type { SmpRunOptions, SmpHartResult, SmpRunResult } from '../../core/src/smp/types.ts';

/** Experimental, bounded interpreter-only runner. Worker URL must be a trusted bundled hart entry. */
export async function runBrowserSmp(opts: SmpRunOptions, workerUrl: URL): Promise<SmpRunResult> {
  if (!globalThis.crossOriginIsolated) throw new Error('SMP requires cross-origin isolation');
  const { timeoutMs, ramBytes, ramBase } = normalizeSmpOptions(opts, true);
  const pages = ramBytes / 65536;
  const memory = new WebAssembly.Memory({ initial: pages, maximum: pages, shared: true });
  const channel = SmpChannel.createShared(opts.harts);
  const workers: Worker[] = [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('SMP execution timed out')), timeoutMs);
    });
    const runs = Array.from(
      { length: opts.harts },
      (_, hartId) =>
        new Promise<SmpHartResult>((resolve, reject) => {
          const worker = new Worker(workerUrl, { type: 'module' });
          workers.push(worker);
          worker.onerror = (event) => {
            event.preventDefault();
            reject(new Error(`hart ${hartId}: ${event.message}`));
          };
          worker.onmessageerror = () => reject(new Error(`hart ${hartId}: invalid message`));
          worker.onmessage = (event: MessageEvent<SmpHartResult & { error?: string }>) => {
            if (event.data.error) reject(new Error(event.data.error));
            else if (event.data.hartId !== hartId) reject(new Error('hart identity mismatch'));
            else resolve(event.data);
          };
          worker.postMessage({ ...opts, memory, channel, hartId, ramBase, ramBytes });
        }),
    );
    return { harts: await Promise.race([Promise.all(runs), timeout]), memory };
  } finally {
    clearTimeout(timer);
    for (const worker of workers) worker.terminate();
  }
}
