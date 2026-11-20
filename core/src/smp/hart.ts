/** Shared interpreter hart entry point for Node and browser workers. */
import { Machine } from '../machine/machine.ts';
import { SmpChannel } from './channel.ts';
import type { SmpHartResult } from './types.ts';

export interface HartData {
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

export function runHart(d: HartData): SmpHartResult {
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
  const entry = machine.load(d.program, d.entry);
  machine.reset(entry, d.stackTop);
  // All workers finish loading before any guest instructions execute.
  Atomics.add(channel.i32, 3, 1);
  Atomics.notify(channel.i32, 3);
  while (Atomics.load(channel.i32, 3) < d.harts) {
    const count = Atomics.load(channel.i32, 3);
    if (count < d.harts) Atomics.wait(channel.i32, 3, count, 1000);
  }
  machine.run(d.budget);

  return {
    hartId: d.hartId,
    stop: machine.cpu.stop,
    exitCode: machine.cpu.exitCode,
    instret: machine.cpu.instret,
    regs: Array.from(machine.cpu.regs),
  };
}
