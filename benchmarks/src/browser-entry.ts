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

import { SHARED_PROBE_CEILING_BROWSER } from '@wasmnux/core';
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

/**
 * A browser renderer will not hand out a 4 GiB `SharedArrayBuffer`, and trying
 * takes the page down with it - which is how the first CI browser run produced
 * twenty minutes of silence instead of a result. Everything shared-memory sized
 * is therefore bounded here, and the bound is recorded in the report.
 */
const SHARED_CEILING = SHARED_PROBE_CEILING_BROWSER;

function availableSuites(scale: number): Suite[] {
  const ids = param('suites', 'jit,wasm')
    .split(',')
    .map((s) => s.trim());
  const out: Suite[] = [];
  if (ids.includes('jit')) out.push(jitSuite(scale));
  if (ids.includes('wasm'))
    out.push(wasmSuite(1_000_000, { inBrowser: true, sharedCeilingPages: SHARED_CEILING }));
  return out;
}

async function log(line: string): Promise<void> {
  try {
    await fetch('/log', { method: 'POST', body: line });
  } catch {
    // The CLI polls for the report anyway; a lost log line is not fatal.
  }
}

/**
 * Fire-and-forget progress line.
 *
 * `sendBeacon` rather than `fetch`: measurement is synchronous, so awaiting a
 * log line would perturb it, and an unawaited fetch can be dropped when the page
 * is busy. Progress exists so that a page which stops responding says *where* it
 * stopped - without it, a hang and a crash look identical from the CLI.
 */
function progress(line: string): void {
  try {
    if (navigator.sendBeacon) navigator.sendBeacon('/log', line);
    else void fetch('/log', { method: 'POST', body: line, keepalive: true });
  } catch {
    // progress is best-effort by definition
  }
}

async function main(): Promise<void> {
  const scale = Number(param('scale', '1')) || 1;
  const reps = Number(param('reps', '5')) || 5;
  const suites = availableSuites(scale);
  progress(`page: crossOriginIsolated=${String(crossOriginIsolated)} sharedCeiling=${SHARED_CEILING} pages`);
  await log(`running ${suites.map((s) => s.id).join(', ')} (reps=${reps}, scale=${scale})`);
  try {
    for (const s of suites) {
      await log(`verifying ${s.id}`);
      s.verify?.();
    }
    const report = runSuites(suites, {
      reps,
      onProgress: progress,
      envOptions: { sharedCeilingPages: SHARED_CEILING },
    });
    progress('page: posting report');
    await fetch('/report', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(report),
    });
    window.__wnxBenchDone?.(report);
    document.title = 'done';
  } catch (err) {
    await fetch('/error', { method: 'POST', body: String((err as Error).stack ?? err) });
    document.title = 'error';
  }
}

void main();
