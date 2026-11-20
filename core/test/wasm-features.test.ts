import { describe, expect, it, vi } from 'vitest';
import { measureAtomicsMicro } from '../src/jit/wasm/features.ts';

describe('Wasm feature measurements', () => {
  it('measures atomics without a Node process global', () => {
    vi.stubGlobal('process', undefined);
    try {
      const result = measureAtomicsMicro(1000);
      expect(result.iterations).toBe(1000);
      expect(Number.isFinite(result.atomicsAddNs)).toBe(true);
      expect(Number.isFinite(result.wasmAtomicAddNs)).toBe(true);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
