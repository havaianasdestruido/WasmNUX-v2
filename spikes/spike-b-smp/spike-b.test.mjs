import test from "node:test";
import assert from "node:assert/strict";
import { Worker } from "node:worker_threads";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { runSpikeB } from "./bench.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const WORKER_PATH = join(__dirname, "vcpu-worker.mjs");

test("Spike B: LR/SC and AMOADD across 4 vCPU workers have zero lost updates", async () => {
  const res = await runSpikeB();
  assert.equal(res.lrsc4Actual, res.lrsc4Expected);
  assert.equal(res.amo4Actual, res.amo4Expected);
});

test("Spike B: Atomics.wait WFI idle wakes cleanly on Atomics.notify", async () => {
  const sab = new SharedArrayBuffer(4096);
  const mem = new Int32Array(sab);
  const wokenPromise = new Promise((resolve, reject) => {
    const w = new Worker(WORKER_PATH, {
      workerData: { sab, workerId: 0, iterations: 0, mode: "wfi" },
    });
    w.on("message", resolve);
    w.on("error", reject);
  });

  // Give worker a moment to enter Atomics.wait
  await new Promise((r) => setTimeout(r, 20));
  Atomics.store(mem, 1, 1);
  Atomics.notify(mem, 1, 1);

  const msg = await wokenPromise;
  assert.equal(msg.woken, true);
  assert.equal(Atomics.load(mem, 2), 1);
});
