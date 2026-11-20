import { describe, expect, it } from 'vitest';
import { assertEquivalentOutcome } from '../suites/jit.ts';
import type { Outcome } from '../src/types.ts';

const reference: Outcome = {
  ms: 1,
  instructions: 10,
  meta: { result: 2, stop: 'exit' },
  stats: { mmioReads: 1, mmioWrites: 0 },
};
describe('benchmark preflight', () => {
  it('rejects instruction and MMIO mismatches even when checksums match', () => {
    expect(() =>
      assertEquivalentOutcome('test', 'jit', { ...reference, instructions: 11 }, reference),
    ).toThrow(/instructions/);
    expect(() =>
      assertEquivalentOutcome(
        'test',
        'jit',
        { ...reference, stats: { mmioReads: 2, mmioWrites: 0 } },
        reference,
      ),
    ).toThrow(/mmioReads/);
    expect(() => assertEquivalentOutcome('test', 'jit', reference, reference)).not.toThrow();
  });
});
