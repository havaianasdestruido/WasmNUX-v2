import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GuestMemory, Reservation, LR_SC_SUCCESS, LR_SC_FAILURE, guestSpinLock, guestSpinUnlock } from '../src/guest-atomics.js';
import { spawnJob, runLitmus, measureWakeLatency } from '../src/smp.js';

const LOCK = 0, CELL = 8, COUNTER = 16;

test('LR/SC: single-thread reservation succeeds; SC without LR fails', () => {
  const mem = new GuestMemory(64);
  mem.store(LOCK, 7n);
  const res = new Reservation();
  // SC without prior LR must fail
  assert.equal(res.storeConditional(mem, LOCK, 9n), LR_SC_FAILURE);
  const v = res.loadAndReserve(mem, LOCK);
  assert.equal(v, 7n);
  assert.equal(res.storeConditional(mem, LOCK, 42n), LR_SC_SUCCESS);
  assert.equal(mem.loadReserved(LOCK), 42n);
});

test('LR/SC: reservation breaks when another agent stores to the cell', () => {
  const buf = new SharedArrayBuffer(64);
  const memA = GuestMemory.wrap(buf);
  const memB = GuestMemory.wrap(buf);
  memA.store(LOCK, 5n);
  const res = new Reservation();
  assert.equal(res.loadAndReserve(memA, LOCK), 5n);
  memB.store(LOCK, 6n); // interference
  assert.equal(res.storeConditional(memA, LOCK, 9n), LR_SC_FAILURE);
  assert.equal(memA.loadReserved(LOCK), 6n);
});

test('AMO add: exact sum under 4-worker contention', async () => {
  const buffer = new SharedArrayBuffer(64);
  const iters = 10_000;
  await Promise.all(Array.from({ length: 4 }, () =>
    spawnJob({ kind: 'amoadd', buffer, counterAddr: COUNTER, iterations: iters })));
  assert.equal(new BigInt64Array(buffer)[COUNTER / 8], 40_000n);
});

test('guest spinlock: 4 workers, plain RMW inside critical section stays consistent', async () => {
  const buffer = new SharedArrayBuffer(64);
  const iters = 50;
  await Promise.all(Array.from({ length: 4 }, () =>
    spawnJob({ kind: 'spinlock', buffer, lockAddr: LOCK, plainCellAddr: CELL, iterations: iters, criticalWork: 20 })));
  assert.equal(new Int32Array(buffer)[CELL / 4], 4 * iters);
});

test('Atomics.wait/notify: worker parked in Atomics.wait wakes on notify (no spin)', async () => {
  const buffer = new SharedArrayBuffer(16);
  const i32 = new Int32Array(buffer);
  const job = spawnJob({ kind: 'wait', buffer, controlAddr: 0, timeoutMs: 2000 });
  await new Promise(r => setTimeout(r, 30)); // let the worker park
  const t0 = process.hrtime.bigint();
  Atomics.store(i32, 0, 1);
  Atomics.notify(i32, 0, 1);
  const res = await job;
  const dt = process.hrtime.bigint() - t0;
  assert.equal(res.kind, 'wait');
  assert.equal(res.result, 'ok');
  assert.ok(dt < 100_000_000n, `wake took too long: ${Number(dt) / 1e6}ms`);
});

test('Atomics.wait: timeout path returns timed-out', async () => {
  const buffer = new SharedArrayBuffer(16);
  const res = await spawnJob({ kind: 'wait', buffer, controlAddr: 0, timeoutMs: 50 });
  assert.equal(res.kind, 'wait');
  assert.equal(res.result, 'timed-out');
});

test('litmus SB/LB: no forbidden outcomes observed under seq_cst (10k rounds)', async (t) => {
  t.diagnostic('memory-model smoke check; JS Atomics are seq_cst, so forbidden counts must be 0');
  const sb = await runLitmus('litmus-sb', 10_000);
  const lb = await runLitmus('litmus-lb', 10_000);
  assert.equal(sb.forbidden, 0);
  assert.equal(lb.forbidden, 0);
});

test('measureWakeLatency returns ok with positive latency', async () => {
  const r = await measureWakeLatency();
  assert.equal(r.waitResult, 'ok');
  assert.ok(r.wokeNs > 0);
});
