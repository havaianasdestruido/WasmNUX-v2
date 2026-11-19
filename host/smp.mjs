import {Hart} from '../core/cpu/atomics.mjs';
import {workerTask} from './worker-rpc.mjs';
export async function measureSmp(count, iterations = 20_000) {
  if (!Number.isInteger(count) || count < 1 || count > 4) throw new RangeError('expected 1–4 vCPUs');
  const mem = new WebAssembly.Memory({initial:1, maximum:1, shared:true});
  const signals = new Int32Array(mem.buffer, 32768, 16);
  const workers = Array.from({length:count}, (_, id) => workerTask(new URL('./smp-worker.mjs', import.meta.url), {mem, id, count, iterations}));
  const ready = (async () => {
    const deadline = performance.now() + 5000;
    while (Atomics.load(signals, 1) !== count) {
      if (performance.now() >= deadline) throw new Error('vCPUs failed to report ready');
      await new Promise(r => setTimeout(r, 5));
    }
    await new Promise(r => setTimeout(r, 25));
    const start = performance.now();
    Atomics.store(signals, 0, 1);
    const notified = Atomics.notify(signals, 0);
    return {start, notified};
  })();
  const [{start, notified}, harts] = await Promise.all([ready, Promise.all(workers)]);
  const hart = new Hart(mem);
  const totals = [hart.read(0), hart.read(4)];
  if (totals.some(x => x !== count * iterations) || harts.some((_, id) => hart.read(8 + id*4) !== iterations)) {
    throw new Error('lost atomic updates');
  }
  return {count, iterations, elapsedMs:performance.now() - start, notified, totals, harts};
}
