/**
 * `npm run bench*` entry point.
 *
 * Subcommands (see package.json):
 *   run      [--suite id]... [--all] [--reps N] [--scale N] [--json]
 *   record   same as run, plus [--baseline] to refresh the CI baselines
 *   gate     [--tolerance 0.2] [--suite id]... - fail on a throughput regression
 *   report   [--from file] [--md] [--out file]
 *   spike    <A|B|C|D|E|F> - the suites that produce evidence for one spike
 *   browser  [--suite id]... - the same suites measured in a real browser
 *
 * Exit status is the contract CI relies on: 0 on success, 1 on a failed gate or
 * a correctness disagreement between variants, 2 on a usage error.
 */

import { writeFileSync } from 'node:fs';
import { DEFAULT_MIN_SAMPLE_MS, DEFAULT_REPS, runSuites, speedupsAgainstReference, withHostInfo } from './harness.ts';
import { formatEnv, formatGate, formatResults, toMarkdown } from './report.ts';
import { gate as runGate, hostInfo, latestReport, readReport, writeBaselines, writeReport } from './store.ts';
import { resolveSuites, SUITE_REGISTRY, suiteIds } from '../suites/index.ts';
import type { BenchReport, Suite } from './types.ts';

interface Args {
  command: string;
  positional: string[];
  flags: Map<string, string | true>;
}

export function parseArgs(argv: string[]): Args {
  const [command = 'help', ...rest] = argv;
  const positional: string[] = [];
  const flags = new Map<string, string | true>();
  for (let i = 0; i < rest.length; i++) {
    const tok = rest[i]!;
    if (!tok.startsWith('--')) {
      positional.push(tok);
      continue;
    }
    const eq = tok.indexOf('=');
    if (eq >= 0) {
      flags.set(tok.slice(2, eq), tok.slice(eq + 1));
      continue;
    }
    const name = tok.slice(2);
    const next = rest[i + 1];
    if (next !== undefined && !next.startsWith('--') && EXPECTS_VALUE.has(name)) {
      flags.set(name, next);
      i++;
    } else {
      flags.set(name, true);
    }
  }
  return { command, positional, flags };
}

const EXPECTS_VALUE = new Set([
  'suite',
  'reps',
  'max-reps',
  'min-sample-ms',
  'scale',
  'tolerance',
  'from',
  'out',
  'browser',
  'port',
  'spike',
]);

function num(flags: Map<string, string | true>, name: string, fallback: number): number {
  const v = flags.get(name);
  if (typeof v !== 'string') return fallback;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new UsageError(`--${name} expects a number, got '${v}'`);
  return n;
}

function suiteSelection(args: Args, spike?: string): string[] | 'all' {
  const ids: string[] = [];
  // `--suite` may repeat; collect every value plus any bare positional id.
  const raw = args.positional.filter((p) => p !== 'run' && p !== 'record');
  for (const p of raw) if (SUITE_REGISTRY.some((s) => s.id === p)) ids.push(p);
  const explicit = args.flags.get('suite');
  if (typeof explicit === 'string') ids.push(...explicit.split(','));
  if (spike) ids.push(...SUITE_REGISTRY.filter((s) => s.spike.toLowerCase() === spike.toLowerCase()).map((s) => s.id));
  if (args.flags.has('all')) return 'all';
  return [...new Set(ids)];
}

class UsageError extends Error {}

const HELP = `wasmnux benchmarks

usage:
  npm run bench -- run [--suite jit,wasm,baseline | --all] [--reps 5] [--scale 1] [--quick] [--json]
  npm run bench:record -- [--suite ...] [--baseline]
  npm run bench:gate -- [--tolerance 0.2] [--suite ...]
  npm run report -- [--from benchmarks/results/x.json] [--md] [--out docs/kpi/latest.md]
  npm run spike -- a|b|c|d|e|f
  npm run bench:browser -- [--suite ...] [--browser /path/to/chromium]

suites: ${suiteIds().join(', ')}
`;

/** Run suites, verifying correctness first, and return the report. */
async function measure(args: Args, spike?: string): Promise<{ report: BenchReport; suites: Suite[] }> {
  const ids = suiteSelection(args, spike);
  const selection = ids === 'all' || ids.length === 0 ? 'all' : ids;
  const suites = await resolveSuites(selection, { scale: num(args.flags, 'scale', 1) });
  if (suites.length === 0) throw new UsageError(`no suites matched (${ids === 'all' ? 'all' : ids.join(', ') || 'none given'})`);
  for (const s of suites) {
    // A suite whose variants disagree is measuring a bug; refuse to time it.
    s.verify?.();
  }
  const quick = args.flags.has('quick');
  const report = runSuites(suites, {
    reps: num(args.flags, 'reps', quick ? 2 : DEFAULT_REPS),
    // Short workloads are mostly noise on a shared runner; sample them longer
    // rather than widening the gate's tolerance. `--quick` opts out.
    minSampleMs: quick ? 0 : num(args.flags, 'min-sample-ms', DEFAULT_MIN_SAMPLE_MS),
    maxReps: num(args.flags, 'max-reps', quick ? 2 : 25),
  });
  report.env = withHostInfo(report.env, hostInfo());
  return { report, suites };
}

function printReport(report: BenchReport, json: boolean): void {
  if (json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return;
  }
  process.stdout.write(`${formatEnv(report.env)}\n`);
  process.stdout.write(`${formatResults(report.results)}\n`);
  const speedups = speedupsAgainstReference(report.results);
  const best = [...speedups.entries()].filter(([, v]) => Number.isFinite(v)).sort((a, b) => b[1] - a[1]);
  if (best.length > 1) {
    process.stdout.write(`\nbest speedup vs reference: ${best[0]![0]} x${best[0]![1].toFixed(2)}\n`);
    process.stdout.write(`worst speedup vs reference: ${best[best.length - 1]![0]} x${best[best.length - 1]![1].toFixed(2)}\n`);
  }
  process.stdout.write(`\nmeasured in ${(report.durationMs / 1000).toFixed(1)} s\n`);
}

async function main(argv: string[]): Promise<number> {
  const args = parseArgs(argv);
  switch (args.command) {
    case 'run': {
      const { report } = await measure(args);
      printReport(report, args.flags.has('json'));
      return 0;
    }
    case 'record': {
      const { report } = await measure(args);
      const path = writeReport(report);
      printReport(report, args.flags.has('json'));
      process.stdout.write(`\nwrote ${path}\n`);
      if (args.flags.has('baseline')) {
        for (const p of writeBaselines(report)) process.stdout.write(`baseline ${p}\n`);
      }
      return 0;
    }
    case 'gate': {
      const { report } = await measure(args);
      const result = runGate(report, num(args.flags, 'tolerance', 0.2));
      process.stdout.write(`${formatGate(result)}\n`);
      if (result.rows.length === 0 || result.rows.every((r) => r.status === 'new')) {
        process.stdout.write('\nno baselines recorded yet: run `npm run bench:record -- --baseline`\n');
        return 0;
      }
      if (args.flags.has('json')) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      return result.failed ? 1 : 0;
    }
    case 'report': {
      const from = args.flags.get('from');
      const report = typeof from === 'string' ? readReport(from) : latestReport()?.report;
      if (!report) {
        process.stderr.write('no results found: run `npm run bench:record` first\n');
        return 2;
      }
      const md = args.flags.has('md');
      const text = md ? toMarkdown(report) : `${formatEnv(report.env)}\n${formatResults(report.results)}\n`;
      const out = args.flags.get('out');
      if (typeof out === 'string') {
        writeFileSync(out, text);
        process.stdout.write(`wrote ${out}\n`);
      } else {
        process.stdout.write(text);
      }
      return 0;
    }
    case 'spike': {
      const which = args.positional[0] ?? String(args.flags.get('spike') ?? '');
      if (!/^[a-fA-F]$/.test(which)) {
        process.stderr.write(`usage: npm run spike -- <a|b|c|d|e|f>\n`);
        return 2;
      }
      const { report } = await measure(args, which);
      printReport(report, args.flags.has('json'));
      return 0;
    }
    case 'browser': {
      const { runInBrowser } = await import('./browser.ts');
      let report = await runInBrowser({
        suites: suiteSelection(args) === 'all' ? suiteIds() : (suiteSelection(args) as string[]),
        browserPath: typeof args.flags.get('browser') === 'string' ? (args.flags.get('browser') as string) : undefined,
        port: num(args.flags, 'port', 8420),
      });
      report = { ...report, env: withHostInfo(report.env, hostInfo()) };
      printReport(report, args.flags.has('json'));
      return 0;
    }
    case 'help':
    case '--help':
    case '-h':
      process.stdout.write(HELP);
      return 0;
    default:
      process.stderr.write(`unknown command '${args.command}'\n\n${HELP}`);
      return 2;
  }
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (err: unknown) => {
    if (err instanceof UsageError) {
      process.stderr.write(`${err.message}\n\n${HELP}`);
      process.exitCode = 2;
      return;
    }
    process.stderr.write(`${(err as Error).stack ?? String(err)}\n`);
    process.exitCode = 1;
  },
);
