import {Hart, storeBuffering} from '../core/cpu/atomics.mjs';
import {serveWorker} from './worker-rpc.mjs';
serveWorker(({mem, iterations, id, count, timeOrigin}) => {
  const signals = new Int32Array(mem.buffer, 32768, 16);
  const hart = new Hart(mem);
  Atomics.add(signals, 1, 1);
  // Wait on a generation word, not on a transient notify; wakeups cannot be lost.
  const idleStart = performance.now();
  const wake = Atomics.wait(signals, 0, 0, 10_000);
  const idleMs = performance.now() - idleStart;
  if (wake === 'timed-out') throw new Error('vCPU wake timed out');
  const start = performance.now();
  let retries = 0;
  for (let i = 0; i < iterations; i++) {
    hart.amoAdd(0, 1);
    for (;;) {
      const value = hart.lr(4);
      if (hart.sc(4, value + 1) === 0) break;
      retries++;
    }
    hart.amoAdd(8 + id*4, 1);
  }
  const end = performance.now();
  const workMs = end - start;
  // Worker performance.now() uses its own origin; translate to the
  // coordinator's clock before comparing workers' finish times.
  const clockOffset = performance.timeOrigin - timeOrigin;
  const workFinishedAtMs = end + clockOffset;
  // Message-passing litmus: publish payload then flag; after observing the
  // predecessor's flag via an SC load, its payload must be visible.
  const neighbor = (id + count - 1) % count;
  signals[8 + id] = 100 + id;
  Atomics.store(signals, 4 + id, 1);
  Atomics.notify(signals, 4 + id);
  if (Atomics.wait(signals, 4 + neighbor, 0, 10_000) === 'timed-out' || signals[8 + neighbor] !== 100 + neighbor) {
    throw new Error('message-passing outcome forbidden under SC');
  }
  const scLitmusRounds = count === 2 ? storeBuffering(hart, new Int32Array(mem.buffer, 32832, 3), id) : 0;
  const validationFinishedAtMs = performance.now() + clockOffset;
  return {wake, idleMs, workMs, workFinishedAtMs, validationFinishedAtMs, retries, scLitmusRounds};
});
