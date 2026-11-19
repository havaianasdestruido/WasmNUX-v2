import { describe, expect, it } from "vitest";
import { SpscRing } from "../src/smp/ring.js";

describe("spike B — SPSC ring", () => {
  it("writes and reads back data in order", () => {
    const buf = SpscRing.createShared(64);
    const ring = new SpscRing(buf, 64);
    const msg = new TextEncoder().encode("hello wnx");
    expect(ring.write(msg)).toBe(msg.length);
    expect(ring.used).toBe(msg.length);
    const out = new Uint8Array(msg.length);
    expect(ring.read(out)).toBe(msg.length);
    expect(new TextDecoder().decode(out)).toBe("hello wnx");
    expect(ring.used).toBe(0);
  });

  it("respects capacity (partial write when full, then drains)", () => {
    const ring = new SpscRing(SpscRing.createShared(16), 16);
    const big = new Uint8Array(24).fill(0xab);
    expect(ring.write(big)).toBe(16);
    expect(ring.free).toBe(0);
    expect(ring.write(new Uint8Array([1]))).toBe(0);
    const out = new Uint8Array(8);
    expect(ring.read(out)).toBe(8);
    expect(ring.free).toBe(8);
    // only 8 bytes free, but the payload is 2 bytes → min(free, payload)
    expect(ring.write(new Uint8Array([9, 9]))).toBe(2);
    expect(ring.used).toBe(10);
  });

  it("wraps around the buffer boundary correctly", () => {
    const ring = new SpscRing(SpscRing.createShared(16), 16);
    const pattern = (seed: number, n: number): Uint8Array =>
      Uint8Array.from({ length: n }, (_, i) => (seed + i * 7) & 0xff);
    const stream: number[] = []; // ground-truth FIFO byte stream
    let consumed = 0;
    const readSome = (max: number): void => {
      const r = Math.min(max, ring.used);
      if (r === 0) return;
      const out = new Uint8Array(r);
      expect(ring.read(out)).toBe(r);
      expect([...out]).toEqual(stream.slice(consumed, consumed + r));
      consumed += r;
    };
    for (let round = 0; round < 40; round++) {
      const w = pattern(round, 5 + (round % 6));
      let off = 0;
      let guard = 0;
      while (off < w.length && guard++ < 500) {
        const n = ring.write(w.subarray(off));
        if (n > 0) {
          for (const b of w.subarray(off, off + n)) stream.push(b);
          off += n;
        } else {
          readSome(4); // ring full: drain a little (backpressure) and retry
        }
      }
      expect(off).toBe(w.length);
      readSome(3 + (round % 4));
    }
    // final drain: everything written comes back in order
    let guard = 0;
    while (ring.used > 0 && guard++ < 100) {
      const out = new Uint8Array(ring.used);
      const n = ring.read(out);
      expect([...out.subarray(0, n)]).toEqual(stream.slice(consumed, consumed + n));
      consumed += n;
    }
    expect(consumed).toBe(stream.length);
  });

  it("single-threaded waitForData times out without spinning forever", () => {
    const ring = new SpscRing(SpscRing.createShared(64), 64);
    const t0 = performance.now();
    const ok = ring.waitForData(25);
    expect(ok).toBe(false);
    expect(performance.now() - t0).toBeGreaterThanOrEqual(20);
  });

  it("close wakes a waiter (via closed flag check)", () => {
    const ring = new SpscRing(SpscRing.createShared(64), 64);
    ring.close();
    expect(ring.closed).toBe(true);
    expect(ring.waitForData(1000)).toBe(false);
  });

  it("rejects non-power-of-two capacity", () => {
    expect(() => new SpscRing(SpscRing.createShared(12), 12)).toThrow(/power of two/);
  });

  it("survives producer/consumer across a worker thread", async () => {
    const { Worker } = await import("node:worker_threads");
    const buf = SpscRing.createShared(1 << 16);
    const ring = new SpscRing(buf, 1 << 16);
    // consumer in a worker: drain until closed+empty, sum bytes
    const workerCode = `
      const { workerData, parentPort } = require("node:worker_threads");
      const ctrl = new Int32Array(workerData, 0, 8);
      const data = new Uint8Array(workerData, 32);
      let tail = 0;
      let total = 0;
      for (;;) {
        const head = Atomics.load(ctrl, 0);
        const used = (head - tail) >>> 0;
        if (used > 0) {
          const off = tail & 0xffff;
          const n = Math.min(used, 0x10000 - off);
          for (let i = 0; i < n; i++) total += data[off + i];
          tail += n;
          Atomics.store(ctrl, 1, tail);
          continue;
        }
        const closed = Atomics.load(ctrl, 3) & 1;
        if (closed) break;
        Atomics.wait(ctrl, 0, head, 50);
      }
      parentPort.postMessage(total);
    `;
    const w = new Worker(workerCode, { eval: true, workerData: buf });
    const done = new Promise<number>((resolve, reject) => {
      w.on("message", (m: number) => resolve(m));
      w.on("error", reject);
    });
    let expected = 0;
    const payload = new Uint8Array(1000);
    for (let i = 0; i < 50; i++) {
      for (let j = 0; j < payload.length; j++) payload[j] = (i + j) & 0xff;
      // producer must wait if full
      let written = 0;
      while (written < payload.length) {
        const n = ring.write(payload.subarray(written));
        written += n;
        if (n === 0) {
          await new Promise((r) => setTimeout(r, 1));
        } else {
          ring.notify();
        }
        if (n > 0 && written < payload.length) await new Promise((r) => setImmediate(r));
      }
      for (const b of payload) expected += b;
      ring.notify();
    }
    ring.close();
    ring.notify();
    const total = await done;
    await w.terminate();
    expect(total).toBe(expected);
  }, 20_000);
});
