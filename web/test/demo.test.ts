/**
 * The browser demo's compute path, asserted in Node.
 *
 * `web/demo.ts` is deliberately DOM-free so that this test can exist: the page
 * is the first thing a visitor sees, and "the demo is broken" is a worse look
 * than a failing unit test. What is checked here is what the page claims -
 * that both engines retire the same instruction count, produce the same result
 * and perform the same number of MMIO writes, and that the JIT actually ran.
 */

import { describe, expect, it } from 'vitest';
import { COMPUTE_PROGRAM, MMIO_PROGRAM, demoEnv, runDemo, runProgram } from '../demo.ts';

describe('web demo', () => {
  it('reports a runtime environment without touching the DOM', () => {
    const env = demoEnv();
    // Node has no crossOriginIsolated; the page renders that as a warning.
    expect([true, false, null]).toContain(env.crossOriginIsolated);
    expect(env.maxMemory32Pages).toBeGreaterThan(0);
    expect(typeof env.userAgent).toBe('string');
  });

  it('runs the compute loop identically on both engines, with the JIT actually engaged', () => {
    const interp = runProgram(COMPUTE_PROGRAM, 'interpreter');
    const jit = runProgram(COMPUTE_PROGRAM, 'jit');
    expect(interp.stop).toBe('exit');
    expect(jit.stop).toBe('exit');
    expect(jit.instructions).toBe(interp.instructions);
    expect(jit.result).toBe(interp.result);
    expect(interp.stats.jitInstructions).toBe(0);
    expect(jit.stats.jitInstructions).toBeGreaterThan(0);
    expect(jit.stats.regionsCompiled).toBeGreaterThan(0);
    // No Wasm trap may be papered over by falling back to the interpreter.
    expect(jit.stats.traps).toBe(0);
  });

  it('performs the same MMIO writes on both engines and tiers the polling loop down', () => {
    const interp = runProgram(MMIO_PROGRAM, 'interpreter');
    const jit = runProgram(MMIO_PROGRAM, 'jit');
    expect(interp.output).toBe('H'.repeat(256));
    expect(jit.output).toBe(interp.output);
    expect(jit.stats.mmioWrites).toBe(interp.stats.mmioWrites);
    expect(jit.instructions).toBe(interp.instructions);
    // A store to the UART on every iteration exits to the host, so the engine
    // retires the region and declines its blocks rather than lose to the
    // interpreter forever (ADR-0002, spike-a-jit.md 4.5).
    expect(jit.stats.tierDowns).toBeGreaterThan(0);
    expect(jit.stats.interpInstructions).toBeGreaterThan(jit.stats.jitInstructions);
  });

  it('agrees on every case it renders', () => {
    for (const c of runDemo()) {
      expect(c.error, c.name).toBeUndefined();
      expect(c.agreed, c.name).toBe(true);
    }
  });
});
