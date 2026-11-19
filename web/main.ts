/**
 * DOM glue for the browser demo. All of the work happens in `web/demo.ts`,
 * which has no DOM dependency and is tested in Node (`web/test/demo.test.ts`).
 *
 * Served by `web/dev-server.ts` with COOP/COEP, because without those headers
 * `crossOriginIsolated` is false, `SharedArrayBuffer` does not exist, and the
 * page would silently demonstrate a different machine than the one that ships
 * (ADR-0004, ADR-0010). The page says so out loud when that happens.
 */

import { demoEnv, runDemo, type DemoCase, type DemoRun } from './demo.ts';

function line(el: HTMLElement, text: string, cls = ''): void {
  const div = document.createElement('div');
  if (cls) div.className = cls;
  div.textContent = text;
  el.append(div);
}

const mips = (r: DemoRun): string => (r.ips / 1e6).toFixed(1).padStart(8);

function renderRun(el: HTMLElement, r: DemoRun, reference?: DemoRun): void {
  const speed = reference && reference.ips > 0 ? `  x${(r.ips / reference.ips).toFixed(2)}` : '';
  line(
    el,
    `  ${r.engine.padEnd(11)} ${r.ms.toFixed(2).padStart(8)} ms ${mips(r)} MIPS ` +
      `${String(r.instructions).padStart(9)} insns  stop=${r.stop}  a0=${r.result}${speed}`,
    r.engine === 'jit' ? 'jit' : '',
  );
  const s = r.stats;
  line(
    el,
    `              compiled=${s.jitInstructions} interpreted=${s.interpInstructions} regions=${s.regionsCompiled} ` +
      `blocks=${s.blocksCompiled} wasm=${s.wasmBytes}B compile=${s.compileMs.toFixed(2)}ms instantiate=${s.instantiateMs.toFixed(2)}ms`,
  );
  line(
    el,
    `              hostExits=${s.hostExits} tierDowns=${s.tierDowns} syscalls=${s.syscalls} ` +
      `mmio=${s.mmioReads}r/${s.mmioWrites}w traps=${s.traps}`,
  );
}

function renderCase(el: HTMLElement, c: DemoCase): void {
  line(el, c.name, 'head');
  if (c.error) {
    line(el, `  FAILED: ${c.error}`, 'bad');
    return;
  }
  if (c.interpreter) renderRun(el, c.interpreter);
  if (c.jit) renderRun(el, c.jit, c.interpreter);
  if (c.interpreter && c.jit) {
    const detail =
      `a0 ${c.interpreter.result} vs ${c.jit.result}, ${c.interpreter.instructions} vs ${c.jit.instructions} ` +
      `instructions, ${c.interpreter.stats.mmioWrites} vs ${c.jit.stats.mmioWrites} mmio writes`;
    line(el, `  differential  ${c.agreed ? 'MATCH' : 'MISMATCH'} (${detail})`, c.agreed ? 'ok' : 'bad');
  }
  if (c.jit && c.jit.stats.tierDowns > 0) {
    line(
      el,
      '  note: the engine retired this region and declined its blocks - it exited to the host too often to pay',
      'warn',
    );
    line(el, '        for itself, so the interpreter owns this loop (spike-a-jit.md 4.5).', 'warn');
  }
  line(el, '');
}

function main(): void {
  const out = document.getElementById('out');
  if (!out) return;
  out.textContent = '';
  const env = demoEnv();

  line(out, `runtime      ${env.userAgent}`);
  line(
    out,
    `isolated     crossOriginIsolated=${String(env.crossOriginIsolated)}  SharedArrayBuffer=${String(
      env.sharedArrayBuffer,
    )}`,
    env.crossOriginIsolated === true ? 'ok' : 'warn',
  );
  if (env.crossOriginIsolated !== true) {
    line(
      out,
      '             -> serve this page with COOP/COEP (npm run serve) or guest RAM cannot be shared',
      'warn',
    );
  }
  line(
    out,
    `wasm         threads=${String(env.threads)} atomics=${String(env.atomics)} wait=${String(env.atomicWait)} ` +
      `simd=${String(env.simd)} memory64Validates=${String(env.memory64Validates)}`,
  );
  line(
    out,
    `memory       reservable ${env.maxMemory32Pages} pages private / ${env.maxSharedMemoryPages} shared ` +
      `(64 KiB each)   hardwareConcurrency=${env.hardwareConcurrency}`,
  );
  line(out, '');

  const cases = runDemo();
  for (const c of cases) renderCase(out, c);

  const agreed = cases.every((c) => c.agreed === true);
  line(
    out,
    agreed ? 'done: both engines agree on every case.' : 'done: MISMATCH - see above.',
    agreed ? 'ok' : 'bad',
  );
  document.title = agreed ? 'WasmNUX demo: ok' : 'WasmNUX demo: mismatch';
}

try {
  main();
} catch (err) {
  const out = document.getElementById('out');
  if (out) line(out, `fatal: ${String(err)}`, 'bad');
  document.title = 'WasmNUX demo: error';
  throw err;
}
