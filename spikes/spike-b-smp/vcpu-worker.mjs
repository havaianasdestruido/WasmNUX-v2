import { parentPort, workerData } from "node:worker_threads";

const { sab, workerId, iterations, mode } = workerData;
const mem = new Int32Array(sab);
// Layout:
// mem[0]: shared counter (AMOADD / LR-SC target)
// mem[1]: WFI futex word (0 = sleeping, 1 = woken)
// mem[2 + workerId]: per-worker private counter

if (mode === "lrsc") {
  // Simulate RISC-V LR.W / SC.W loop using Atomics.load + Atomics.compareExchange
  for (let i = 0; i < iterations; i++) {
    while (true) {
      const expected = Atomics.load(mem, 0);
      if (Atomics.compareExchange(mem, 0, expected, expected + 1) === expected) {
        break;
      }
    }
  }
  parentPort.postMessage({ workerId, done: true });
} else if (mode === "amoadd") {
  for (let i = 0; i < iterations; i++) {
    Atomics.add(mem, 0, 1);
  }
  parentPort.postMessage({ workerId, done: true });
} else if (mode === "wfi") {
  // Sleep without spinning until woken by Atomics.notify
  Atomics.wait(mem, 1, 0);
  Atomics.add(mem, 2 + workerId, 1);
  parentPort.postMessage({ workerId, woken: true });
} else if (mode === "parallel_compute") {
  // Independent per-vCPU work (simulates parallel make -j)
  let acc = 0;
  for (let i = 0; i < iterations; i++) {
    acc = (acc + i) | 0;
  }
  Atomics.store(mem, 2 + workerId, acc);
  parentPort.postMessage({ workerId, done: true });
}
