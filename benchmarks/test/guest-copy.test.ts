import { describe, expect, it } from 'vitest';
import { cpuWorkloads, runWorkload } from '../src/guest.ts';

describe('copy benchmark preflight', () => {
  it('checks nonzero destination contents, detecting dropped stores', () => {
    const workload = cpuWorkloads().find((w) => w.id === 'memory-copy')!;
    const expected = (1024 * 1025) / 2;
    const good = runWorkload({ workload, jit: false });
    expect(good.meta?.['result']).toBe(expected);
    const broken = { ...workload, source: workload.source.replace('sw   t5, 0(t4)', 'nop') };
    const bad = runWorkload({ workload: broken, jit: false });
    expect(bad.meta?.['result']).toBe(0);
    expect(bad.meta?.['result']).not.toBe(good.meta?.['result']);
  }, 30_000);
});
