import { describe, expect, it } from "vitest";
import { IdleGate, LitmusShared, ReservationTable } from "../src/smp/reservation.js";

describe("spike B — reservation table (LR/SC across harts)", () => {
  it("SC succeeds when no conflicting store happened", () => {
    const table = new ReservationTable(ReservationTable.createShared(), 4);
    table.setReservation(1, 0x1000);
    expect(table.check(1, 0x1000)).toBe(true);
    // SC consumes the reservation: a second SC fails
    expect(table.check(1, 0x1000)).toBe(false);
  });

  it("conflicting store on another hart invalidates the reservation", () => {
    const table = new ReservationTable(ReservationTable.createShared(), 4);
    table.setReservation(2, 0x2000);
    table.invalidateAll(0x2000); // hart 3 stores to 0x2000
    expect(table.check(2, 0x2000)).toBe(false);
  });

  it("stores to other addresses do not invalidate", () => {
    const table = new ReservationTable(ReservationTable.createShared(), 4);
    table.setReservation(0, 0x3000);
    table.invalidateAll(0x4000);
    expect(table.check(0, 0x3000)).toBe(true);
  });

  it("LR without SC is dropped by an explicit clear", () => {
    const table = new ReservationTable(ReservationTable.createShared(), 2);
    table.setReservation(0, 0x10);
    table.clear(0);
    expect(table.check(0, 0x10)).toBe(false);
  });
});

describe("spike B — idle gate (Atomics.wait, no spin)", () => {
  it("times out when nobody wakes it", () => {
    const gate = new IdleGate(IdleGate.createShared());
    const t0 = performance.now();
    expect(gate.wait(0, 30)).toBe("timed-out");
    expect(performance.now() - t0).toBeGreaterThanOrEqual(25);
  });

  it("kicking the gate makes wait return immediately", () => {
    const gate = new IdleGate(IdleGate.createShared());
    // Kick first: a wait with a stale expected value returns 'not-equal'
    // without parking (same-thread kicks cannot land during a blocking wait).
    gate.kick();
    expect(gate.wait(0, 5000)).toBe("not-equal");
    expect(gate.load()).toBe(1);
  });

  it("worker thread parks and wakes via the gate", async () => {
    const { Worker } = await import("node:worker_threads");
    const buf = IdleGate.createShared();
    // Handshake: worker announces it is about to park, main kicks only then.
    // (A bare sleep raced worker startup — kick could land before the worker
    // read the initial value, leaving it waiting for a change that already
    // happened.) The wait loop also treats "not-equal" as success, so an
    // early kick is never missed.
    const code = `
      const { workerData, parentPort } = require("node:worker_threads");
      const ctrl = new Int32Array(workerData, 0, 1);
      const start = Atomics.load(ctrl, 0);
      parentPort.postMessage("parked");
      let result = "timed-out";
      for (;;) {
        const v = Atomics.load(ctrl, 0);
        if (v !== start) { result = "ok"; break; }
        const r = Atomics.wait(ctrl, 0, v, 9000);
        if (r === "not-equal") continue;
        if (r === "timed-out" && Atomics.load(ctrl, 0) === start) break;
      }
      parentPort.postMessage([result, Atomics.load(ctrl, 0)]);
    `;
    const w = new Worker(code, { eval: true, workerData: buf });
    const messages: unknown[] = [];
    const got = new Promise((resolve, reject) => {
      w.on("message", (m) => {
        messages.push(m);
        if (Array.isArray(m)) resolve(m);
      });
      w.on("error", reject);
    });
    // Wait until the worker announced it is about to park, then kick.
    await new Promise<void>((resolve, reject) => {
      w.on("message", (m) => { if (m === "parked") resolve(); });
      w.on("error", reject);
      setTimeout(() => reject(new Error("worker never parked")), 8000);
    });
    const gate = new IdleGate(buf);
    gate.kick();
    const [result, value] = (await got) as ["ok", number];
    await w.terminate();
    expect(result).toBe("ok");
    expect(value).toBe(1);
  }, 15_000);
});

/**
 * Litmus harness (spike B memory-model validation).
 *
 * Barrier protocol: shared `f` cells are [a, b, gen, r0, r1]. Every phase:
 * each worker waits for `gen === phaseStart` (via wait/notify-free timed
 * waits — cheap enough for 1000 rounds), runs its per-phase work, then
 * Atomics.add(gen, 1). A phase completes only when both workers arrived, so
 * phases never overlap. All accesses are sequentially-consistent Atomics —
 * the forbidden outcomes below are provably impossible, and CI asserts zero.
 */
describe("spike B — litmus harness", () => {
  const BARRIER = `
    function arrive(f, target) {
      for (;;) {
        const g = Atomics.load(f, 2);
        if (g >= target) return;
        Atomics.wait(f, 2, g, 50);
      }
    }
    function done(f) { Atomics.add(f, 2, 1); Atomics.notify(f, 2, 1); }
  `;

  it("MP (message passing): observing y==1 ⇒ x==1 always", async () => {
    const { Worker } = await import("node:worker_threads");
    const shared = LitmusShared.createShared();
    const ITER = 1000;

    const producer = BARRIER + `
      const { workerData, parentPort } = require("node:worker_threads");
      const { shared, ITER } = workerData;
      const f = new Int32Array(shared, 0, 8);
      let bad = 0;
      for (let i = 0; i < ITER; i++) {
        const p = i * 4;
        arrive(f, p);         // phase 0: write message+flag (and reset for this round)
        Atomics.store(f, 0, 0);
        Atomics.store(f, 1, 0);
        Atomics.store(f, 0, 1); // x = 1  (message)
        Atomics.store(f, 1, 1); // y = 1  (flag, after x)
        done(f);
        arrive(f, p + 2);      // phase 1: consumer reads
        done(f);
      }
      parentPort.postMessage(bad);
    `;
    const consumer = BARRIER + `
      const { workerData, parentPort } = require("node:worker_threads");
      const { shared, ITER } = workerData;
      const f = new Int32Array(shared, 0, 8);
      let bad = 0;
      for (let i = 0; i < ITER; i++) {
        const p = i * 4;
        arrive(f, p);          // phase 0: nothing to do
        done(f);
        arrive(f, p + 2);      // phase 1: read flag then message
        const r1 = Atomics.load(f, 1); // y
        const r2 = Atomics.load(f, 0); // x
        if (r1 === 1 && r2 === 0) bad++;
        done(f);
      }
      parentPort.postMessage(bad);
    `;

    const w1 = new Worker(producer, { eval: true, workerData: { shared, ITER } });
    const w2 = new Worker(consumer, { eval: true, workerData: { shared, ITER } });
    const results = await Promise.all([
      new Promise((res, rej) => { w1.on("message", res); w1.on("error", rej); }),
      new Promise((res, rej) => { w2.on("message", res); w2.on("error", rej); }),
    ]);
    await Promise.all([w1.terminate(), w2.terminate()]);
    for (const bad of results as number[]) expect(bad).toBe(0);
  }, 60_000);

  it("SB (store buffering): both loads never read 0", async () => {
    const { Worker } = await import("node:worker_threads");
    const shared = LitmusShared.createShared();
    const ITER = 1000;

    const code = BARRIER + `
      const { workerData, parentPort } = require("node:worker_threads");
      const { shared, role, ITER } = workerData;
      const f = new Int32Array(shared, 0, 8);
      let bad = 0;
      for (let i = 0; i < ITER; i++) {
        const p = i * 4;
        arrive(f, p);            // phase 0: concurrent store-then-load
        if (role === 0) {
          Atomics.store(f, 0, 1);  // x = 1
          const r = Atomics.load(f, 1); // r0 = y
          Atomics.store(f, 3, r);
        } else {
          Atomics.store(f, 1, 1);  // y = 1
          const r = Atomics.load(f, 0); // r1 = x
          Atomics.store(f, 4, r);
        }
        done(f);
        arrive(f, p + 2);        // phase 1: both loads recorded — check & reset
        if (Atomics.load(f, 3) === 0 && Atomics.load(f, 4) === 0) bad++;
        Atomics.store(f, 0, 0);
        Atomics.store(f, 1, 0);
        Atomics.store(f, 3, -1);
        Atomics.store(f, 4, -1);
        done(f);
      }
      parentPort.postMessage(bad);
    `;

    const w1 = new Worker(code, { eval: true, workerData: { shared, role: 0, ITER } });
    const w2 = new Worker(code, { eval: true, workerData: { shared, role: 1, ITER } });
    const results = await Promise.all([
      new Promise((res, rej) => { w1.on("message", res); w1.on("error", rej); }),
      new Promise((res, rej) => { w2.on("message", res); w2.on("error", rej); }),
    ]);
    await Promise.all([w1.terminate(), w2.terminate()]);
    for (const bad of results as number[]) expect(bad).toBe(0);
  }, 60_000);
});
