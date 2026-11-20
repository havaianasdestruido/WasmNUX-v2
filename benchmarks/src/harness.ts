/**
 * Measurement harness.
 *
 * Two rules keep the numbers honest:
 *
 *  1. **A variant constructs its own machine per repetition.** Warm caches,
 *     grown memories and JIT code from a previous repetition must not leak into
 *     the next one, or "best of N" measures the warmest accident.
 *  2. **The best sample is the reported one, and every sample is kept.** On a
 *     shared CI runner noise only ever adds time, so the minimum is the closest
 *     thing to the machine's real capability; keeping all samples lets a report
 *     show how noisy the run was instead of hiding it.
 *
 * Guest workloads are timed with `performance.now()` around `Machine.run()`,
 * and throughput is derived from the *guest* instruction count the engine
 * retired, never from a host-side estimate.
 */

import { WasmFeatures } from '@wasmnux/core';
import type {
  BenchCase,
  BenchEnv,
  BenchReport,
  CaseResult,
  GitInfo,
  Sample,
  Suite,
  Variant,
} from './types.ts';

export interface MeasureOptions {
  /** Timed repetitions to take at minimum. */
  reps?: number;
  /** Untimed repetitions first, so lazy one-off costs do not land in sample 0. */
  warmup?: number;
  /**
   * Keep sampling until the best sample is at least this many milliseconds, up to
   * `maxReps`. A 3 ms measurement on a shared runner is mostly noise, and the
   * regression gate compares these numbers, so short workloads earn more
   * repetitions instead of a wider tolerance. 0 disables it (used by unit tests,
   * which need deterministic sample counts).
   */
  minSampleMs?: number;
  /** Upper bound on repetitions when `minSampleMs` is set. */
  maxReps?: number;
}

export const DEFAULT_REPS = 5;
export const DEFAULT_WARMUP = 1;
export const DEFAULT_MIN_SAMPLE_MS = 20;

/**
 * The environment a report was produced in, including the Wasm feature probes.
 *
 * Deliberately free of Node imports: the same harness runs in a browser page
 * (`npm run bench:browser`), where `node:os` does not exist. Host-specific
 * provenance (git, cpu model, total memory) is filled in by the CLI via
 * `store.captureGit` and `withHostInfo`.
 */
export function captureEnv(): BenchEnv {
  const nav = (globalThis as { navigator?: { userAgent?: string; hardwareConcurrency?: number } }).navigator;
  const proc = (
    globalThis as {
      process?: {
        platform?: string;
        arch?: string;
        versions?: { node?: string };
        release?: { name?: string };
      };
    }
  ).process;
  return {
    date: new Date().toISOString(),
    runtime: proc?.versions?.node
      ? `${proc.release?.name ?? 'node'} ${proc.versions.node}`
      : (nav?.userAgent ?? 'unknown runtime'),
    platform: proc?.platform ?? 'browser',
    arch: proc?.arch ?? 'unknown',
    cpus: nav?.hardwareConcurrency ?? 0,
    totalMemoryMB: 0,
    wasm: WasmFeatures.probeWasmFeatures(),
  };
}

/** Attach host-only provenance (git commit, memory) to an environment block. */
export function withHostInfo(
  env: BenchEnv,
  info: { git?: GitInfo; totalMemoryMB?: number; cpus?: number },
): BenchEnv {
  return {
    ...env,
    git: info.git ?? env.git,
    totalMemoryMB: info.totalMemoryMB ?? env.totalMemoryMB,
    cpus: info.cpus ?? env.cpus,
  };
}

function statsOf(samples: Sample[]): { best: Sample; median: Sample } {
  const sorted = [...samples].sort((a, b) => a.ms - b.ms);
  const best = sorted[0]!;
  const mid = sorted.length >> 1;
  const median =
    sorted.length % 2 === 1
      ? sorted[mid]!
      : { ms: (sorted[mid - 1]!.ms + sorted[mid]!.ms) / 2, instructions: sorted[mid]!.instructions };
  return { best, median };
}

/** Instructions per second from a sample. */
export function ipsOf(s: Sample): number {
  return s.ms > 0 ? (s.instructions / s.ms) * 1000 : 0;
}

/** Run one variant `reps` times (or more, if the samples are too short) and summarise. */
export function measureVariant(
  suiteId: string,
  caseName: string,
  variant: Variant,
  opts: MeasureOptions = {},
): CaseResult {
  const reps = opts.reps ?? DEFAULT_REPS;
  const warmup = opts.warmup ?? DEFAULT_WARMUP;
  const minSampleMs = opts.minSampleMs ?? 0;
  const maxReps = opts.maxReps ?? Math.max(reps, reps * 5);
  for (let i = 0; i < warmup; i++) variant.run();

  const samples: Sample[] = [];
  let last = variant.run();
  let fastest = Infinity;
  for (let i = 0; i < maxReps && (i < reps || fastest < minSampleMs); i++) {
    last = variant.run();
    samples.push({ ms: last.ms, instructions: last.instructions });
    if (last.ms < fastest) fastest = last.ms;
  }
  const { best, median } = statsOf(samples);
  return {
    suite: suiteId,
    case: caseName,
    variant: variant.name,
    samples,
    comparable: variant.comparable,
    best,
    median,
    ips: ipsOf(best),
    stats: last.stats,
    meta: last.meta,
  };
}

/** Evaluate a case's declared metric on its best sample. */
function metricOf(c: BenchCase, r: CaseResult): CaseResult['metric'] {
  if (!c.metric) return undefined;
  return {
    name: c.metric.name,
    value: c.metric.value(r.best, r.stats),
    digits: c.metric.digits ?? 1,
    lowerIsBetter: c.metric.lowerIsBetter ?? false,
  };
}

/** Measure every variant of one case. */
export function measureCase(suite: Suite, c: BenchCase, opts: MeasureOptions = {}): CaseResult[] {
  return c.variants.map((v) => {
    const r = measureVariant(suite.id, c.name, v, opts);
    r.metric = metricOf(c, r);
    r.showMeta = c.showMeta;
    return r;
  });
}

/** Run every case of a suite. */
export function runSuite(suite: Suite, opts: MeasureOptions = {}): CaseResult[] {
  const out: CaseResult[] = [];
  for (const c of suite.cases) out.push(...measureCase(suite, c, opts));
  return out;
}

/** Run a set of suites into one report. */
export function runSuites(suites: Suite[], opts: MeasureOptions = {}): BenchReport {
  const started = performance.now();
  const results: CaseResult[] = [];
  for (const s of suites) results.push(...runSuite(s, opts));
  return { version: 1, env: captureEnv(), results, durationMs: performance.now() - started };
}

/** Legacy baseline reports also contained a comparator known not to execute equivalent work. */
export function isComparable(r: CaseResult): boolean {
  return r.comparable !== false && !(r.suite === 'baseline' && r.variant.startsWith('8086emu '));
}

/**
 * Speedup of each variant against the first one in the same case, which by
 * convention is the reference implementation (the interpreter).
 */
export function speedupsAgainstReference(results: CaseResult[]): Map<string, number> {
  const byCase = new Map<string, CaseResult[]>();
  for (const r of results) {
    const key = `${r.suite}/${r.case}`;
    const list = byCase.get(key);
    if (list) list.push(r);
    else byCase.set(key, [r]);
  }
  const out = new Map<string, number>();
  for (const [key, list] of byCase) {
    const ref = list[0];
    if (!ref || !isComparable(ref) || ref.metric || ipsOf(ref.median) <= 0) continue;
    for (const r of list) {
      if (isComparable(r) && !r.metric) out.set(`${key}/${r.variant}`, ipsOf(r.median) / ipsOf(ref.median));
    }
  }
  return out;
}
