/**
 * SMP hart worker. Runs one `Machine` attached to the shared guest memory and
 * the shared `SmpChannel`.
 *
 * Entry points are plain TypeScript on purpose: the runtime spawns this file
 * with `execArgv: ['--import', 'tsx']`, so no build step is needed for tests or
 * the Node host. No browser worker transport is implemented yet.
 */

import { parentPort, workerData } from 'node:worker_threads';
import { Machine } from '../machine/machine.ts';
import { SmpChannel } from './channel.ts';

interface WorkerData {
  memory: WebAssembly.Memory;
  channel: SharedArrayBuffer;
  harts: number;
  hartId: number;
  program: Uint8Array;
  entry: number;
  stackTop: number;
  budget: number;
  ramBase: number;
  ramBytes: number;
}

const d = workerData as WorkerData;
const channel = new SmpChannel(d.channel, d.harts);
const machine = new Machine({
  memory: d.memory,
  shared: true,
  hartId: d.hartId,
  harts: d.harts,
  jit: false,
  smp: channel,
  ramBase: d.ramBase,
  ramBytes: d.ramBytes,
});
machine.load(d.program, d.entry);
machine.reset(d.entry, d.stackTop);
// All workers finish loading before any guest instructions execute.
Atomics.add(channel.i32, 3, 1);
Atomics.notify(channel.i32, 3);
while (Atomics.load(channel.i32, 3) < d.harts) {
  const count = Atomics.load(channel.i32, 3);
  if (count < d.harts) Atomics.wait(channel.i32, 3, count, 1000);
}
machine.run(d.budget);

parentPort!.postMessage({
  hartId: d.hartId,
  stop: machine.cpu.stop,
  exitCode: machine.cpu.exitCode,
  instret: machine.cpu.instret,
  regs: Array.from(machine.cpu.regs),
});
