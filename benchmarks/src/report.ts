/**
 * Reporting: terminal tables and the markdown that goes into `docs/kpi/`.
 *
 * Formatting lives apart from measurement so a result file can be re-rendered
 * later (a dashboard, a PR comment, a spike document) without re-running
 * anything. Both renderers group by suite and case, and always show the
 * reference variant first with the others as a ratio against it - a raw MIPS
 * number means nothing on its own, and the ratio is the decision-relevant part.
 */

import type { BenchEnv, BenchReport, CaseResult, GateResult } from './types.ts';
import { ipsOf, isComparable } from './harness.ts';

export function mips(ips: number): string {
  return (ips / 1e6).toFixed(1);
}

function pad(s: string, n: number): string {
  return s.length >= n ? s : s + ' '.repeat(n - s.length);
}

function left(s: string, n: number): string {
  return s.length >= n ? s.slice(0, n) : s + ' '.repeat(n - s.length);
}

export function formatEnv(env: BenchEnv): string {
  const git = env.git
    ? `${env.git.branch}@${env.git.commit.slice(0, 7)}${env.git.dirty ? ' (dirty)' : ''}`
    : 'no git';
  const w = env.wasm;
  const features = [
    ['threads', w.threads],
    ['atomics', w.atomics],
    ['atomicWait', w.atomicWait],
    ['simd', w.simd],
    ['bulkMemory', w.bulkMemory],
    ['memory64', w.memory64],
    ['tailCalls', w.tailCalls],
    ['exceptions', w.exceptions],
    ['sharedGrowable', w.sharedMemoryGrowable],
  ]
    .filter(([, on]) => on)
    .map(([name]) => name)
    .join(', ');
  return [
    `date     ${env.date}`,
    `runtime  ${env.runtime} on ${env.platform}/${env.arch}, ${env.cpus} cpus, ${env.totalMemoryMB} MB`,
    `git      ${git}`,
    `wasm     ${features || 'none of the probed features'}`,
    `         crossOriginIsolated=${String(w.crossOriginIsolated)} isWorker=${String(w.isWorker)} isNode=${String(w.isNode)}`,
  ].join('\n');
}

/** Columns shown when a variant carries engine stats. */
const STAT_COLUMNS: Array<{ header: string; key: string; width: number; digits: number }> = [
  { header: 'regions', key: 'regionsCompiled', width: 8, digits: 0 },
  { header: 'blocks', key: 'blocksCompiled', width: 7, digits: 0 },
  { header: 'wasmB', key: 'wasmBytes', width: 7, digits: 0 },
  { header: 'cmpMs', key: 'compileMs', width: 7, digits: 2 },
  { header: 'instMs', key: 'instantiateMs', width: 7, digits: 2 },
  { header: 'exits', key: 'hostExits', width: 7, digits: 0 },
  { header: 'traps', key: 'traps', width: 6, digits: 0 },
];

function statCell(r: CaseResult, col: (typeof STAT_COLUMNS)[number]): string {
  const v = r.stats?.[col.key];
  if (v === undefined) return left('-', col.width);
  return left(v.toFixed(col.digits), col.width);
}

function metaText(r: CaseResult): string {
  if (!r.meta) return '';
  const parts = Object.entries(r.meta)
    .filter(([, v]) => v !== undefined && v !== '')
    .map(([k, v]) => `${k}=${typeof v === 'number' ? round(v, 3) : String(v)}`);
  return parts.length ? `  ${parts.join(' ')}` : '';
}

function round(v: number, digits: number): number {
  const f = 10 ** digits;
  return Math.round(v * f) / f;
}

/** The number a case is judged by: its declared metric, or throughput. */
function headline(r: CaseResult): { label: string; value: number; digits: number; lowerIsBetter: boolean } {
  if (r.metric)
    return {
      label: r.metric.name,
      value: r.metric.value,
      digits: r.metric.digits,
      lowerIsBetter: r.metric.lowerIsBetter,
    };
  return { label: 'median MIPS', value: ipsOf(r.median) / 1e6, digits: 1, lowerIsBetter: false };
}

/** Range as a percentage of the median; absent for a single sample or zero median. */
function sampleRangePercent(r: CaseResult): string {
  if (r.samples.length < 2 || r.median.ms <= 0) return '-';
  const values = r.samples.map((s) => s.ms);
  return `${(((Math.max(...values) - Math.min(...values)) / r.median.ms) * 100).toFixed(1)}%`;
}

/** One block of text per case: the variants, their throughput, and the ratio. */
export function formatResults(results: CaseResult[]): string {
  const out: string[] = [];
  const byKey = new Map<string, CaseResult[]>();
  for (const r of results) {
    const k = `${r.suite}\u0000${r.case}`;
    const list = byKey.get(k);
    if (list) list.push(r);
    else byKey.set(k, [r]);
  }

  let currentSuite = '';
  for (const [k, list] of byKey) {
    const [suite, caseName] = k.split('\u0000') as [string, string];
    if (suite !== currentSuite) {
      out.push('', `== ${suite} ==`);
      currentSuite = suite;
    }
    const anyStats = list.some((r) => r.stats && Object.keys(r.stats).length > 0 && !r.showMeta);
    const showMeta = list.some((r) => r.showMeta);
    out.push('', `-- ${caseName}`);
    const nameWidth = Math.max(9, ...list.map((r) => r.variant.length));
    const h = headline(list[0]!);
    const metricHeader = h.lowerIsBetter ? `${h.label} (lower better)` : h.label;
    const head = `${left('variant', nameWidth)}  ${left('best ms', 9)} ${left('median ms', 10)} ${left('range/med', 10)} ${left(metricHeader, 18)} ${left('vs ref', 8)} ${left('insns', 11)}`;
    out.push(anyStats ? `${head} ${STAT_COLUMNS.map((c) => left(c.header, c.width)).join(' ')}` : head);
    const ref = list[0];
    const refValue = ref ? headline(ref).value : 0;
    for (const r of list) {
      const hv = headline(r);
      const ratio =
        ref && isComparable(ref) && isComparable(r) && refValue > 0 && hv.value > 0
          ? `x${(hv.value / refValue).toFixed(2)}`
          : '-';
      const line = `${left(r.variant, nameWidth)}  ${left(r.best.ms.toFixed(r.best.ms < 1 ? 3 : 1), 9)} ${left(r.median.ms.toFixed(r.median.ms < 1 ? 3 : 1), 10)} ${left(sampleRangePercent(r), 10)} ${left(isComparable(r) ? hv.value.toFixed(hv.digits) : '-', 18)} ${left(ratio, 8)} ${left(isComparable(r) ? String(r.median.instructions) : '-', 11)}`;
      out.push(
        anyStats
          ? `${line} ${STAT_COLUMNS.map((c) => statCell(r, c)).join(' ')}`
          : showMeta
            ? `${line}${metaText(r)}`
            : line,
      );
    }
    // Spread only means something for samples long enough to be perturbed.
    const noisy = list.filter((r) => r.samples.length > 2 && r.best.ms >= 1);
    if (noisy.length) {
      const spread = noisy.map((r) => {
        const ms = r.samples.map((s) => s.ms);
        const min = Math.min(...ms);
        const max = Math.max(...ms);
        return min > 0 ? (max - min) / min : 0;
      });
      const worst = Math.max(...spread);
      if (worst > 0.25)
        out.push(`   (note: sample spread up to ${(worst * 100).toFixed(0)}% - machine was noisy)`);
    }
  }
  return out.join('\n');
}

export function formatGate(g: GateResult): string {
  const out: string[] = [
    `regression gate (tolerance ${(g.tolerance * 100).toFixed(0)}%)`,
    g.baselineFile ? `baseline: ${g.baselineFile}` : 'baseline: none found',
  ];
  out.push(
    '',
    `${left('suite/case/variant', 62)} ${left('baseline', 10)} ${left('current', 10)} ${left('ratio', 8)} status`,
  );
  for (const r of g.rows) {
    const name = `${r.suite}/${r.case}/${r.variant}`;
    out.push(
      `${left(name, 62)} ${left(mips(r.baselineIps), 10)} ${left(mips(r.currentIps), 10)} ${left(r.ratio ? `x${r.ratio.toFixed(2)}` : '-', 8)} ${r.status}`,
    );
  }
  const regressions = g.rows.filter((r) => r.status === 'regression' || r.status === 'missing');
  out.push(
    '',
    regressions.length
      ? `FAIL: ${regressions.length} row(s) regressed or went missing`
      : 'PASS: no regressions',
  );
  return out.join('\n');
}

/** Markdown for `docs/kpi/`: one table per suite, ratios against the reference. */
export function toMarkdown(report: BenchReport, title = 'WasmNUX benchmark report'): string {
  const lines: string[] = [`# ${title}`, '', '```', formatEnv(report.env), '```', ''];
  const suites = [...new Set(report.results.map((r) => r.suite))];
  for (const suite of suites) {
    const rows = report.results.filter((r) => r.suite === suite);
    lines.push(`## ${suite}`, '');
    lines.push(
      '| case | variant | best ms | median ms | range / median | metric | value | vs ref | instructions |',
    );
    lines.push('|---|---|---:|---:|---:|---|---:|---:|---:|');
    const cases = [...new Set(rows.map((r) => r.case))];
    for (const c of cases) {
      const list = rows.filter((r) => r.case === c);
      const ref = list[0];
      const refValue = ref ? headline(ref).value : 0;
      for (const r of list) {
        const hv = headline(r);
        const ratio =
          ref && isComparable(ref) && isComparable(r) && refValue > 0 && hv.value > 0
            ? `x${(hv.value / refValue).toFixed(2)}`
            : '-';
        const label = hv.lowerIsBetter ? `${hv.label} (lower better)` : hv.label;
        lines.push(
          `| ${c} | ${r.variant} | ${r.best.ms.toFixed(r.best.ms < 1 ? 3 : 1)} | ${r.median.ms.toFixed(r.median.ms < 1 ? 3 : 1)} | ${sampleRangePercent(r)} | ${label} | ${isComparable(r) ? hv.value.toFixed(hv.digits) : '-'} | ${ratio} | ${isComparable(r) ? r.median.instructions : '-'} |`,
        );
      }
      if (list.some((r) => r.showMeta)) {
        for (const r of list) {
          const m = metaText(r).trim();
          if (m) lines.push(`| ${c} | ${r.variant} | | | | | | | ${m} |`);
        }
      }
    }
    lines.push('');
    const notes = rows.filter((r) => r.stats && (r.stats['compileMs'] ?? 0) > 0);
    if (notes.length) {
      lines.push('<details><summary>JIT compile cost</summary>', '');
      lines.push('| case | variant | regions | blocks | wasm bytes | compile ms | instantiate ms |');
      lines.push('|---|---|---:|---:|---:|---:|---:|');
      for (const r of notes) {
        const s = r.stats!;
        lines.push(
          `| ${r.case} | ${r.variant} | ${s['regionsCompiled'] ?? 0} | ${s['blocksCompiled'] ?? 0} | ${s['wasmBytes'] ?? 0} | ${(s['compileMs'] ?? 0).toFixed(2)} | ${(s['instantiateMs'] ?? 0).toFixed(2)} |`,
        );
      }
      lines.push('', '</details>', '');
    }
  }
  lines.push(`Measured in ${(report.durationMs / 1000).toFixed(1)} s.`);
  return `${lines.join('\n')}\n`;
}
