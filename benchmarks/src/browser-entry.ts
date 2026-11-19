/**
 * Browser-side benchmark entry point.
 *
 * Bundled by `benchmarks/src/browser.ts` with esbuild and served to the page.
 * It must not import anything Node-only: no `node:fs`, no `node:os`, no git.
 * The suites it can run are therefore the ones that measure the guest engine
 * and the platform - which is exactly what a browser number is for, since the
 * browser (not Node) is the shipping target.
 *
 * Protocol: the page is loaded with `?suites=jit,wasm&reps=5&scale=1`, runs
 * them, and POSTs the report JSON back to `/report`. Progress lines go to
 * `/log` so the CLI can show what the page is doing instead of a silent wait.
 */

import { runSuites } from './harness.ts';
import type { BenchReport, Suite } from './types.ts';
import { jitSuite } from '../suites/jit.ts';
import { wasmSuite } from '../suites/wasm.ts';

declare global {
  interface Window {
    __wnxBenchDone?: (report: BenchReport) => void;
  }
}

function param(name: string, fallback: string): string {
  return new URLSearchParams(location.search).get(name) ?? fallback;
}

function availableSuites(scale: number): Suite[] {
  const ids = param('suites', 'jit,wasm').split(',').map((s) => s.trim());
  const out: Suite[] = [];
  if (ids.includes('jit')) out.push(jitSuite(scale));
  if (ids.includes('wasm')) out.push(wasmSuite(1_000_000));
  return out;
}

async function log(line: string): Promise<void> {
  try {
    await fetch('/log', { method: 'POST', body: line });
  } catch {
    // The CLI polls for the report anyway; a lost log line is not fatal.
  }
}

async function main(): Promise<void> {
  const scale = Number(param('scale', '1')) || 1;
  const reps = Number(param('reps', '5')) || 5;
  const suites = availableSuites(scale);
  await log(`running ${suites.map((s) => s.id).join(', ')} (reps=${reps}, scale=${scale})`);
  try {
    for (const s of suites) {
      await log(`verifying ${s.id}`);
      s.verify?.();
    }
    const report = runSuites(suites, { reps });
    await fetch('/report', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(report) });
    window.__wnxBenchDone?.(report);
    document.title = 'done';
  } catch (err) {
    await fetch('/error', { method: 'POST', body: String((err as Error).stack ?? err) });
    document.title = 'error';
  }
}

void main();
