/**
 * Benchmark data model.
 *
 * Everything the harness measures, records and gates on is described here, so a
 * result file written today can still be read by the dashboard after the suites
 * change. Results are plain JSON: no binary formats, no timestamps that depend
 * on a local clock being right (the environment block records both the wall
 * clock and the git commit, and the commit is what a gate compares against).
 */

import type { WasmFeatureReport } from '@wasmnux/core';

/** One timed repetition of one variant. */
export interface Sample {
  /** Wall-clock milliseconds for the whole run. */
  ms: number;
  /** Guest instructions retired, as the engine counted them. */
  instructions: number;
}

/** What a variant reports besides its timing. */
export interface Outcome extends Sample {
  /** Engine/machine counters worth recording (compile ms, wasm bytes, traps...). */
  stats?: Record<string, number>;
  /** Anything else: config, workload size, notes. Strings and numbers only. */
  meta?: Record<string, string | number | boolean>;
}

/** A named way of running one workload: "interpreter", "jit globals/trap", ... */
export interface Variant {
  name: string;
  /**
   * Run the workload once, from a freshly constructed machine. Implementations
   * must not reuse state between calls or the repetition count is meaningless.
   */
  run(): Outcome;
}

/**
 * How a case's headline number is derived from a sample.
 *
 * Throughput in guest instructions per second is the right metric for CPU
 * workloads and meaningless for a capability probe (where the interesting number
 * is "did it work, and how many milliseconds did the allocation take"), so a
 * case may declare its own.
 */
export interface MetricSpec {
  /** Column header, e.g. "MIPS", "ms", "ns/op". */
  name: string;
  /** Appended to the header when a smaller number is the better one. */
  lowerIsBetter?: boolean;
  value(best: Sample, stats?: Record<string, number>): number;
  /** Digits to print. */
  digits?: number;
}

/** One workload: the same guest program measured under several variants. */
export interface BenchCase {
  name: string;
  /** Optional longer description, shown in reports. */
  description?: string;
  variants: Variant[];
  /** Defaults to guest instructions per second. */
  metric?: MetricSpec;
  /** Print each variant's `meta` block after the numbers (capability probes). */
  showMeta?: boolean;
}

export interface Suite {
  /** Stable identifier used on the command line and in result files. */
  id: string;
  title: string;
  /** Which spike or KPI row this suite informs (see ROADMAP §4/§5). */
  spike?: string;
  cases: BenchCase[];
  /**
   * Correctness check run before anything is measured. A benchmark whose
   * variants disagree about the answer is measuring a bug, so the CLI refuses to
   * record numbers from a suite whose `verify` throws.
   */
  verify?: () => void;
}

/** Aggregated statistics over the samples of one variant of one case. */
export interface CaseResult {
  suite: string;
  case: string;
  variant: string;
  samples: Sample[];
  /** Fastest sample - the number a gate compares, since noise only ever adds. */
  best: Sample;
  median: Sample;
  /** Instructions per second, from the best sample. */
  ips: number;
  /** The case's declared metric evaluated on the best sample. */
  metric?: { name: string; value: number; digits: number; lowerIsBetter: boolean };
  showMeta?: boolean;
  stats?: Record<string, number>;
  meta?: Record<string, string | number | boolean>;
}

export interface GitInfo {
  commit: string;
  branch: string;
  dirty: boolean;
  describe?: string;
}

export interface BenchEnv {
  /** Wall-clock start of the run, ISO-8601 UTC. */
  date: string;
  runtime: string;
  platform: string;
  arch: string;
  cpus: number;
  totalMemoryMB: number;
  git?: GitInfo;
  wasm: WasmFeatureReport;
}

export interface BenchReport {
  /** Bumped when the shape of a report changes. */
  version: 1;
  env: BenchEnv;
  results: CaseResult[];
  /** Total wall time of the measurement phase, in milliseconds. */
  durationMs: number;
}

/** One comparison produced by the regression gate. */
export interface GateRow {
  suite: string;
  case: string;
  variant: string;
  baselineIps: number;
  currentIps: number;
  /** current / baseline; below 1 means a regression. */
  ratio: number;
  status: 'ok' | 'regression' | 'improved' | 'missing' | 'new';
}

export interface GateResult {
  tolerance: number;
  rows: GateRow[];
  failed: boolean;
  baselineFile?: string;
}
