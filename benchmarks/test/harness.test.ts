/**
 * The harness itself has to be trustworthy: a benchmark that mis-measures is
 * worse than no benchmark, because it gets believed. These tests cover the
 * statistics, the store round-trip and the gate's decision rules - including the
 * cases where a gate must NOT fail (a missing baseline is not a regression).
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { ipsOf, measureVariant, runSuites, speedupsAgainstReference } from '../src/harness.ts';
import { gate, readReport, writeBaselines, writeReport } from '../src/store.ts';
import type { BenchReport, CaseResult, Suite, Variant } from '../src/types.ts';

/** A deterministic fake variant: `ms` is fixed, so throughput is predictable. */
function fake(name: string, ms: number, instructions: number, jitter = 0): Variant {
  let calls = 0;
  return {
    name,
    run: () => {
      calls++;
      const extra = jitter > 0 && calls % 3 === 0 ? jitter : 0;
      return { ms: ms + extra, instructions, stats: { calls } };
    },
  };
}

function suiteOf(cases: Suite['cases'], id = 'fake'): Suite {
  return { id, title: 'fake suite', cases };
}

function result(suite: string, caseName: string, variant: string, ips: number): CaseResult {
  const ms = 1_000_000 / ips;
  return {
    suite,
    case: caseName,
    variant,
    samples: [{ ms, instructions: 1000 }],
    best: { ms, instructions: 1000 },
    median: { ms, instructions: 1000 },
    ips,
  };
}

const tmp = mkdtempSync(join(tmpdir(), 'wnx-bench-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

describe('statistics', () => {
  it('derives instructions per second from a sample', () => {
    expect(ipsOf({ ms: 10, instructions: 1000 })).toBe(100_000);
    expect(ipsOf({ ms: 0, instructions: 1000 })).toBe(0);
  });

  it('reports the fastest sample as best, ignoring jitter', () => {
    const r = measureVariant('fake', 'case', fake('v', 10, 1000, 5), { reps: 6, warmup: 0 });
    expect(r.best.ms).toBe(10);
    expect(r.samples.length).toBe(6);
    expect(r.ips).toBe(100_000);
    expect(r.median.ms).toBeGreaterThanOrEqual(10);
  });

  it('runs warmup repetitions without recording them', () => {
    const r = measureVariant('fake', 'case', fake('v', 4, 4000), { reps: 3, warmup: 2 });
    expect(r.samples.length).toBe(3);
    expect(r.stats?.['calls']).toBe(6); // 2 warmup + 1 probe + 3 timed
  });

  it('keeps sampling until the best sample is long enough', () => {
    const r = measureVariant('fake', 'case', fake('v', 2, 100), {
      reps: 2,
      warmup: 0,
      minSampleMs: 7,
      maxReps: 9,
    });
    // 2 ms samples can never reach 7 ms, so it stops at the cap.
    expect(r.samples.length).toBe(9);
  });

  it('stops early once a sample is long enough', () => {
    const r = measureVariant('fake', 'case', fake('v', 50, 100), {
      reps: 1,
      warmup: 0,
      minSampleMs: 20,
      maxReps: 9,
    });
    expect(r.samples.length).toBe(1);
  });

  it('computes speedups against the first variant of each case', () => {
    const report = runSuites(
      [suiteOf([{ name: 'c', variants: [fake('interp', 100, 1000), fake('jit', 10, 1000)] }])],
      {
        reps: 1,
        warmup: 0,
      },
    );
    const sp = speedupsAgainstReference(report.results);
    expect(sp.get('fake/c/interp')).toBeCloseTo(1, 5);
    expect(sp.get('fake/c/jit')).toBeCloseTo(10, 1);
  });
});

describe('result store', () => {
  const report: BenchReport = {
    version: 1,
    env: {
      date: new Date().toISOString(),
      runtime: 'test',
      platform: 'test',
      arch: 'test',
      cpus: 1,
      totalMemoryMB: 1,
      wasm: {
        threads: true,
        sharedMemoryGrowable: true,
        atomics: true,
        atomicWait: true,
        simd: false,
        bulkMemory: true,
        memory64: false,
        tailCalls: true,
        exceptions: true,
        maxMemory32Pages: 65536,
        maxSharedMemoryPages: 65536,
        sharedProbeCeilingPages: 65536,
        hardwareConcurrency: 4,
        crossOriginIsolated: null,
        isWorker: false,
        isNode: true,
        userAgent: 'test',
      },
    },
    results: [result('fake', 'loop', 'interp', 1_000_000), result('fake', 'loop', 'jit', 10_000_000)],
    durationMs: 5,
  };

  it('round-trips a report through disk', () => {
    const path = writeReport(report, tmp);
    const back = readReport(path);
    expect(back.results.length).toBe(2);
    expect(back.results[1]!.ips).toBe(10_000_000);
    expect(JSON.parse(readFileSync(path, 'utf8')).version).toBe(1);
  });

  it('writes one baseline file per suite', () => {
    const written = writeBaselines(report, tmp);
    expect(written.length).toBe(1);
    expect(written[0]!.endsWith('fake.json')).toBe(true);
  });

  it('passes a gate when throughput holds', () => {
    const g = gate(report, 0.2, tmp);
    expect(g.failed).toBe(false);
    expect(g.rows.every((r) => r.status === 'ok')).toBe(true);
  });

  it('fails a gate on a regression beyond the tolerance', () => {
    const slower: BenchReport = {
      ...report,
      results: [result('fake', 'loop', 'interp', 1_000_000), result('fake', 'loop', 'jit', 5_000_000)],
    };
    const g = gate(slower, 0.2, tmp);
    expect(g.failed).toBe(true);
    const row = g.rows.find((r) => r.variant === 'jit');
    expect(row?.status).toBe('regression');
    expect(row?.ratio).toBeCloseTo(0.5, 5);
  });

  it('tolerates a regression inside the tolerance', () => {
    const slightly: BenchReport = {
      ...report,
      results: [result('fake', 'loop', 'interp', 1_000_000), result('fake', 'loop', 'jit', 9_000_000)],
    };
    expect(gate(slightly, 0.2, tmp).failed).toBe(false);
  });

  it('flags a missing row instead of silently passing', () => {
    const partial: BenchReport = { ...report, results: [result('fake', 'loop', 'interp', 1_000_000)] };
    const g = gate(partial, 0.2, tmp);
    expect(g.rows.find((r) => r.variant === 'jit')?.status).toBe('missing');
    expect(g.failed).toBe(true);
  });

  it('reports new rows without failing when there is no baseline at all', () => {
    const empty = mkdtempSync(join(tmpdir(), 'wnx-bench-empty-'));
    const g = gate(report, 0.2, empty);
    expect(g.rows.every((r) => r.status === 'new')).toBe(true);
    expect(g.failed).toBe(false);
    rmSync(empty, { recursive: true, force: true });
  });
});
