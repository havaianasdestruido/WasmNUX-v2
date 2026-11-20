/**
 * Result store and regression gate.
 *
 * Results are JSON files under `benchmarks/results/`, one per run, named after
 * the wall clock *and* the git commit so a number can always be traced back to
 * the code that produced it. Baselines live in `benchmarks/baselines/`, one file
 * per suite, and may be used by the optional local `npm run bench:gate`. CI records results
 * without hardware-specific performance gates.
 *
 * The legacy local gate compares the
 * *best* sample (noise only ever adds time) and the default tolerance is wide.
 * A gate that cries wolf gets ignored, and an ignored gate is worse than none.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { cpus, totalmem } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { BenchReport, CaseResult, GateResult, GateRow, GitInfo } from './types.ts';
import { isComparable } from './harness.ts';

function git(args: string[]): string | undefined {
  try {
    return execFileSync('git', args, {
      cwd: repoRoot(),
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return undefined;
  }
}

/** Best-effort git provenance; undefined outside a checkout (a release tarball). */
export function captureGit(): GitInfo | undefined {
  const commit = git(['rev-parse', 'HEAD']);
  if (!commit) return undefined;
  return {
    commit,
    branch: git(['rev-parse', '--abbrev-ref', 'HEAD']) ?? 'HEAD',
    dirty: (git(['status', '--porcelain']) ?? '') !== '',
    describe: git(['describe', '--tags', '--always', '--dirty']),
  };
}

/** Node-only additions to the environment block (see harness.captureEnv). */
export function hostInfo(): { git?: GitInfo; totalMemoryMB: number; cpus: number } {
  return {
    git: captureGit(),
    totalMemoryMB: Math.round(totalmem() / (1024 * 1024)),
    cpus: cpus().length,
  };
}

export const DEFAULT_TOLERANCE = 0.2;

/** Repository root, found by walking up from this file (works from any cwd). */
export function repoRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 8; i++) {
    if (existsSync(join(dir, 'ROADMAP.md')) || existsSync(join(dir, 'node_modules', '.package-lock.json')))
      return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return resolve('.');
}

export function resultsDir(): string {
  return join(repoRoot(), 'benchmarks', 'results');
}

export function baselinesDir(): string {
  return join(repoRoot(), 'benchmarks', 'baselines');
}

function stamp(d: Date): string {
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}T${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
}

/** Write a run to `benchmarks/results/`; returns the path. */
export function writeReport(report: BenchReport, dir = resultsDir()): string {
  mkdirSync(dir, { recursive: true });
  const sha = report.env.git?.commit.slice(0, 7) ?? 'nogit';
  const suites = [...new Set(report.results.map((r) => r.suite))].join('+') || 'empty';
  const path = join(dir, `${stamp(new Date(report.env.date))}-${sha}-${suites}.json`);
  writeFileSync(path, `${JSON.stringify(report, null, 2)}\n`);
  return path;
}

/** Write (or refresh) the baseline for each suite present in the report. */
export function writeBaselines(report: BenchReport, dir = baselinesDir()): string[] {
  mkdirSync(dir, { recursive: true });
  const bySuite = new Map<string, CaseResult[]>();
  for (const r of report.results) {
    const list = bySuite.get(r.suite);
    if (list) list.push(r);
    else bySuite.set(r.suite, [r]);
  }
  const written: string[] = [];
  for (const [suite, results] of bySuite) {
    const path = join(dir, `${suite}.json`);
    writeFileSync(path, `${JSON.stringify({ version: 1, env: report.env, results }, null, 2)}\n`);
    written.push(path);
  }
  return written;
}

export function readReport(path: string): BenchReport {
  return JSON.parse(readFileSync(path, 'utf8')) as BenchReport;
}

/** Most recent file in `benchmarks/results/`, or null. */
export function latestReport(dir = resultsDir()): { path: string; report: BenchReport } | null {
  if (!existsSync(dir)) return null;
  const files = readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .sort();
  const last = files[files.length - 1];
  if (!last) return null;
  const path = join(dir, last);
  return { path, report: readReport(path) };
}

export function readBaseline(suite: string, dir = baselinesDir()): CaseResult[] | null {
  const path = join(dir, `${suite}.json`);
  if (!existsSync(path)) return null;
  const o = JSON.parse(readFileSync(path, 'utf8')) as { results: CaseResult[] };
  return o.results;
}

const key = (r: { suite: string; case: string; variant: string }): string =>
  `${r.suite}\u0000${r.case}\u0000${r.variant}`;

/**
 * Compare a fresh report against the stored baselines.
 *
 * `tolerance` is the fractional drop that is still acceptable: 0.2 means a
 * variant may lose up to 20% of its throughput before the gate fails.
 */
export function gate(report: BenchReport, tolerance = DEFAULT_TOLERANCE, dir = baselinesDir()): GateResult {
  const rows: GateRow[] = [];
  const suites = [...new Set(report.results.map((r) => r.suite))];
  const baseline = new Map<string, CaseResult>();
  let baselineFile: string | undefined;

  for (const suite of suites) {
    const stored = readBaseline(suite, dir);
    if (!stored) continue;
    baselineFile = join(dir, `${suite}.json`);
    for (const r of stored) if (isComparable(r)) baseline.set(key(r), r);
  }

  const seen = new Set<string>();
  for (const r of report.results) {
    if (!isComparable(r)) continue;
    const k = key(r);
    seen.add(k);
    const b = baseline.get(k);
    if (!b) {
      rows.push({
        suite: r.suite,
        case: r.case,
        variant: r.variant,
        baselineIps: 0,
        currentIps: r.ips,
        ratio: 0,
        status: 'new',
      });
      continue;
    }
    const ratio = b.ips > 0 ? r.ips / b.ips : 0;
    const status = ratio < 1 - tolerance ? 'regression' : ratio > 1 + tolerance ? 'improved' : 'ok';
    rows.push({
      suite: r.suite,
      case: r.case,
      variant: r.variant,
      baselineIps: b.ips,
      currentIps: r.ips,
      ratio,
      status,
    });
  }
  for (const [k, b] of baseline) {
    if (seen.has(k)) continue;
    // Only flag rows from suites this run actually touched.
    if (!suites.includes(b.suite)) continue;
    rows.push({
      suite: b.suite,
      case: b.case,
      variant: b.variant,
      baselineIps: b.ips,
      currentIps: 0,
      ratio: 0,
      status: 'missing',
    });
  }

  return {
    tolerance,
    rows,
    failed: rows.some((r) => r.status === 'regression' || r.status === 'missing'),
    baselineFile,
  };
}
