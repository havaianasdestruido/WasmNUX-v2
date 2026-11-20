import { describe, expect, it } from 'vitest';
import { SmpChannel, SMP_DATA, amoCounterProgram, hartIdProgram, lrscLockProgram } from '../src/index.ts';
import { runSmp } from '../src/smp/runtime.ts';

const HARTS = 4;
const ITERS = 256;

async function sharedCounter() {
  return runSmp({
    harts: HARTS,
    program: amoCounterProgram(ITERS).bytes,
    entry: 0x80000000,
    stackTop: 0x81000000,
    budget: 5_000_000,
  });
}

describe('SMP channel', () => {
  it('rejects undersized buffers and invalid hart ids', () => {
    expect(() => new SmpChannel(new SharedArrayBuffer(4), 2)).toThrow();
    const c = new SmpChannel(SmpChannel.createShared(2), 2);
    expect(() => c.lr(2, 0, new Int32Array(4), 0)).toThrow();
  });

  it('invalidates an LR after an overlapping store, even when the old value is restored', () => {
    const c = new SmpChannel(SmpChannel.createShared(2), 2);
    const data = new Int32Array(new SharedArrayBuffer(16));
    data[0] = 1;
    expect(c.lr(0, 0x1000, data, 0)).toBe(1);
    c.beginWrite();
    data[0] = 2;
    c.endWrite(0x1001, 1);
    expect(c.sc(0, 0x1000, 3, data, 0)).toBe(false);
    data[0] = 1;
    c.lr(0, 0x1000, data, 0);
    c.beginWrite();
    data[0] = 2;
    c.endWrite(0x1000, 4);
    c.beginWrite();
    data[0] = 1;
    c.endWrite(0x1000, 4);
    expect(c.sc(0, 0x1000, 3, data, 0)).toBe(false);
    expect(data[0]).toBe(1);
  });

  it('consumes a reservation on a wrong-address SC', () => {
    const c = new SmpChannel(SmpChannel.createShared(1), 1);
    const data = new Int32Array(new SharedArrayBuffer(16));
    c.lr(0, 0x1000, data, 0);
    expect(c.sc(0, 0x1004, 9, data, 1)).toBe(false);
    expect(c.sc(0, 0x1000, 9, data, 0)).toBe(false);
  });

  it('does not accept SC without a prior LR', () => {
    const c = new SmpChannel(SmpChannel.createShared(1), 1);
    const data = new Int32Array(new SharedArrayBuffer(16));
    expect(c.sc(0, 0, 9, data, 0)).toBe(false);
  });

  it('supports gates with explicit state changes', () => {
    const c = new SmpChannel(SmpChannel.createShared(2), 2);
    c.setGate(0, 1);
    expect(c.wait(0, 0, 0)).toBe('not-equal');
    expect(c.gateValue(1)).toBe(0);
  });
});

describe('SMP runtime safety', () => {
  it('rejects invalid timeout and instruction budgets before launching workers', async () => {
    const opts = {
      harts: 1,
      program: hartIdProgram().bytes,
      entry: 0x80000000,
      stackTop: 0x81000000,
      budget: 1,
    };
    await expect(runSmp({ ...opts, timeoutMs: 0 })).rejects.toThrow(/timeoutMs/);
    await expect(runSmp({ ...opts, timeoutMs: Infinity })).rejects.toThrow(/timeoutMs/);
    await expect(runSmp({ ...opts, budget: Infinity })).rejects.toThrow(/budget/);
  });

  it('times out and terminates workers even when a run cannot complete', async () => {
    await expect(
      runSmp({
        harts: 2,
        program: hartIdProgram().bytes,
        entry: 0x80000000,
        stackTop: 0x81000000,
        budget: 1_000_000,
        timeoutMs: 1,
      }),
    ).rejects.toThrow(/timed out/);
  }, 10_000);
});

describe('SMP stress', () => {
  it('amoadd.w is atomic across harts', async () => {
    const run = await sharedCounter();
    expect(run.harts.map((r) => r.stop)).toEqual(Array(HARTS).fill('exit'));
    const view = new Int32Array(run.memory.buffer);
    expect(view[(SMP_DATA.counter - 0x80000000) >> 2]).toBe(HARTS * ITERS);
  }, 30_000);

  it('lr/sc spinlock yields exactly HARTS*ITERS increments', async () => {
    const run = await runSmp({
      harts: HARTS,
      program: lrscLockProgram(ITERS).bytes,
      entry: 0x80000000,
      stackTop: 0x81000000,
      budget: 50_000_000,
    });
    expect(run.harts.map((r) => r.stop)).toEqual(Array(HARTS).fill('exit'));
    const view = new Int32Array(run.memory.buffer);
    expect(view[(SMP_DATA.cell - 0x80000000) >> 2]).toBe(HARTS * ITERS);
    expect(view[(SMP_DATA.lock - 0x80000000) >> 2]).toBe(0);
  }, 30_000);

  it('each hart reports its own mhartid', async () => {
    const run = await runSmp({
      harts: HARTS,
      program: hartIdProgram().bytes,
      entry: 0x80000000,
      stackTop: 0x81000000,
      budget: 1_000_000,
    });
    const ids = run.harts.map((r) => r.regs[10]!).sort((a, b) => a - b);
    expect(ids).toEqual([0, 1, 2, 3]);
  }, 30_000);
});
