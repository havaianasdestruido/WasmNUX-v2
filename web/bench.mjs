import {workerTask} from '../host/worker-rpc.mjs';
import {measureSmp} from '../host/smp.mjs';
import {captureInput} from '../host/terminal/text.mjs';
import {measureV86} from '../benchmarks/v86/probe.mjs';

const commits = [];
captureInput(document.querySelector('#ime'), value => commits.push(value));
const worker = (name, input) => workerTask(new URL(name, import.meta.url), input, 35_000);
globalThis.probes = {
  commits,
  async cpu() {
    const jit = await worker('../benchmarks/jit-worker.mjs', 1_000_000);
    return {jit, baseline:await measureV86(jit.checksum, jit.iterations)};
  },
  async smp() {
    const results = [];
    for (const n of [1, 2, 4]) results.push(await measureSmp(n));
    return results;
  },
  storage:() => worker('../host/storage/probe-worker.mjs'),
  originLoss:mode => worker('../host/storage/loss-worker.mjs', {mode}),
  graphics:() => worker('../host/display/probe-worker.mjs'),
  network:() => worker('/assets/net-worker.mjs'),
};
