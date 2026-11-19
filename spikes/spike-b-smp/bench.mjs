import { Worker } from "node:worker_threads";
import { performance } from "node:perf_hooks";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const WORKER_PATH = join(__dirname, "vcpu-worker.mjs");

function runWorkers(n, iterations, mode) {
  const sab = new SharedArrayBuffer(4096);
  const mem = new Int32Array(sab);
  const t0 = performance.now();
  const promises = [];
  for (let i = 0; i < n; i++) {
    promises.push(
      new Promise((resolve, reject) => {
        const w = new Worker(WORKER_PATH, {
          workerData: { sab, workerId: i, iterations, mode },
        });
        w.on("message", resolve);
        w.on("error", reject);
      })
    );
  }
  return Promise.all(promises).then(() => ({
    ms: performance.now() - t0,
    counter: Atomics.load(mem, 0),
    mem,
  }));
}

export async function runSpikeB() {
  const iters = 100_000;
  const lrsc4 = await runWorkers(4, iters, "lrsc");
  const amo4 = await runWorkers(4, iters, "amoadd");

  const parIters = 5_000_000;
  const par1 = await runWorkers(1, parIters, "parallel_compute");
  const par4 = await runWorkers(4, parIters, "parallel_compute");

  // 4x total work in ~1x time => scalingEfficiency ~ 1.0
  const scalingPerCore = (par1.ms * 4) / Math.max(par4.ms, 0.01) / 4;

  return {
    lrsc4Expected: 4 * iters,
    lrsc4Actual: lrsc4.counter,
    lrsc4Ms: Number(lrsc4.ms.toFixed(2)),
    amo4Expected: 4 * iters,
    amo4Actual: amo4.counter,
    amo4Ms: Number(amo4.ms.toFixed(2)),
    par1Ms: Number(par1.ms.toFixed(2)),
    par4Ms: Number(par4.ms.toFixed(2)),
    scalingPerCore: Number(scalingPerCore.toFixed(2)),
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  console.log("Spike B (SMP):", JSON.stringify(await runSpikeB(), null, 2));
}
