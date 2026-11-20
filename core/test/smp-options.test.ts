import { describe, it, expect } from 'vitest';
import { normalizeSmpOptions } from '../src/smp/options.ts';
import { runSmp } from '../src/smp/runtime.ts';
import { assemble } from '../src/cpu/asm.ts';

const options = {
  harts: 1,
  program: new Uint8Array(4),
  entry: 0x80000004,
  stackTop: 0x80008000,
  budget: 10,
  ramBytes: 65536,
};
describe('shared SMP validation', () => {
  for (const browser of [false, true]) {
    it(`rejects unaligned bases and malformed geometry before starting workers (browser=${browser})`, () => {
      for (const change of [
        { ramBase: 0x80000001 },
        { ramBytes: NaN },
        { ramBytes: -1 },
        { entry: 0x180000004 },
        { stackTop: 0x180008000 },
        { ramBase: 0xfffffffc },
      ])
        expect(() => normalizeSmpOptions({ ...options, ...change }, browser)).toThrow(RangeError);
      expect(normalizeSmpOptions({ ...options, ramBase: 0x80000004 }, browser).ramBase).toBe(0x80000004);
    });
  }
  it('preserves Node rounding but rejects browser unaligned RAM size', () => {
    expect(normalizeSmpOptions({ ...options, ramBytes: 65537 }).ramBytes).toBe(131072);
    expect(() => normalizeSmpOptions({ ...options, ramBytes: 65537 }, true)).toThrow();
  });
  it('executes a word-aligned, non-page-aligned RAM base', async () => {
    const program = assemble('li a0, 7\nli a7, 93\necall', { base: options.entry }).bytes;
    const run = await runSmp({ ...options, program, ramBase: options.entry });
    expect(run.harts[0]?.exitCode).toBe(7);
    expect(run.harts[0]?.stop).toBe('exit');
  });
});
