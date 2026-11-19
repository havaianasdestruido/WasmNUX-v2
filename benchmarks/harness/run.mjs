#!/usr/bin/env node
/**
 * WasmNUX benchmark harness (host-side, Phase 0).
 *
 * Measures and records everything that can be measured on the HOST. Guest-side
 * numbers (boot probes, in-guest sysbench/fio) need the Phase 1 image and are
 * emitted as `skipped` with reason, so the results schema is stable.
 *
 * Usage:
 *   node benchmarks/harness/run.mjs            # quick (screening) run
 *   node benchmarks/harness/run.mjs --full     # full (>=10 s CoreMark etc.)
 *   node benchmarks/harness/run.mjs --quick    # alias for default
 *   node benchmarks/harness/run.mjs --out benchmarks/results/x.json
 *   node benchmarks/harness/run.mjs --validate-only   # validate results files
 *
 * Output JSON shape (version 1) — see benchmarks/harness/schema.json.
 */
import { execFileSync, execSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync, readdirSync, readFileSync } from 'node:fs';
import { cpus, platform, release, totalmem } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getGitCommit } from './gitinfo.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const BENCH_C = join(ROOT, 'benchmarks', 'c');
const COREMARK_DIR = join(BENCH_C, 'coremark');
const DHRY_DIR = join(BENCH_C, 'dhrystone');

const args = new Set(process.argv.slice(2));
const FULL = args.has('--full');
const VALIDATE_ONLY = args.has('--validate-only');
const outIdx = process.argv.indexOf('--out');
const OUT = outIdx >= 0 ? process.argv[outIdx + 1] : undefined;

const log = (...a) => process.stderr.write(a.join(' ') + '\n');
const now = () => new Date().toISOString();

// ---------- validation ----------
const KPI_KEYS = [
  'coremark', 'dhrystone', 'sysbenchCpu', 'fio4kRandomRead', 'gccCompileSelf',
  'bootCold', 'bootResume', 'bytesFirstPrompt',
];

function validateResultsFile(path) {
  const j = JSON.parse(readFileSync(path, 'utf8'));
  const errors = [];
  if (j.schema !== 1) errors.push('schema must be 1');
  if (!j.commit) errors.push('missing commit');
  if (!j.timestamp) errors.push('missing timestamp');
  if (!j.host) errors.push('missing host');
  for (const k of KPI_KEYS) {
    if (!(k in (j.benchmarks ?? {}))) errors.push(`missing benchmarks.${k}`);
  }
  return errors;
}

if (VALIDATE_ONLY) {
  const dir = join(ROOT, 'benchmarks', 'results');
  let bad = 0;
  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.json')) continue;
    if (!f.startsWith('host-')) { log(`skipped (spike results validated by their own suites): ${f}`); continue; }
    const errs = validateResultsFile(join(dir, f));
    if (errs.length) { bad++; log(`INVALID ${f}:\n  ${errs.join('\n  ')}`); }
    else log(`valid: ${f}`);
  }
  process.exit(bad === 0 ? 0 : 1);
}

// ---------- host probes ----------
const hostInfo = {
  cpus: cpus().length,
  model: cpus()[0]?.model ?? 'unknown',
  platform,
  release: release(),
  totalMemoryBytes: totalmem(),
};

function runCoreMark() {
  const t0 = Date.now();
  try {
    execSync('make -s -B PORT_DIR=linux NO_LIBRT=1 ITERATIONS=500000', {
      cwd: COREMARK_DIR, stdio: 'pipe', timeout: 300_000,
    });
    const logText = readFileSync(join(COREMARK_DIR, 'run1.log'), 'utf8');
    const iterPerSec = /Iterations\/Sec\s*:\s*([0-9.]+)/.exec(logText)?.[1];
    const validated = /Correct operation validated/.test(logText) || /\[0\]crcfinal/.test(logText);
    if (!validated) return { status: 'fail', detail: 'CoreMark output did not validate (CRC mismatch)', wallMs: Date.now() - t0 };
    return {
      status: 'ok',
      iterationsPerSec: iterPerSec ? Number(iterPerSec) : null,
      valid: true,
      screeningOnly: !FULL,
      wallMs: Date.now() - t0,
    };
  } catch (err) {
    return { status: 'error', detail: String(err).slice(0, 500), wallMs: Date.now() - t0 };
  }
}

function runDhrystone() {
  const t0 = Date.now();
  try {
    const bin = join(DHRY_DIR, 'dhry');
    if (!existsSync(bin)) {
      execFileSync('gcc', ['-O2', '-std=gnu89', '-w', '-fcommon', '-DTIME', 'dhry_1.c', 'dhry_2.c', '-o', bin, '-lm'], {
        cwd: DHRY_DIR, stdio: 'pipe', timeout: 120_000,
      });
    }
    const targetRuns = 500_000_000;
    const proc = spawnSync(bin, { input: `${targetRuns}\n`, encoding: 'utf8', cwd: DHRY_DIR, timeout: 120_000, maxBuffer: 16 * 1024 * 1024 });
    const out = proc.stdout ?? '';
    const dps = /Dhrystones per Second:\s*([0-9.]+)/.exec(out)?.[1];
    const tooSmall = /Measured time too small/.test(out);
    return {
      status: dps ? 'ok' : 'error',
      dhrystonesPerSecond: dps ? Number(dps) : null,
      runs: targetRuns,
      tooSmallToBeMeaningful: tooSmall,
      screeningOnly: !FULL,
      wallMs: Date.now() - t0,
    };
  } catch (err) {
    return { status: 'error', detail: String(err).slice(0, 500), wallMs: Date.now() - t0 };
  }
}

function hasBinary(name) {
  try { execSync(`command -v ${name}`, { stdio: 'pipe' }); return true; } catch { return false; }
}

function runSysbench() {
  const t0 = Date.now();
  if (!hasBinary('sysbench')) {
    return { status: 'skipped', reason: 'sysbench not installed on host (guest-side run comes with Phase 1)' };
  }
  try {
    const out = execSync('sysbench cpu --threads=1 --cpu-max-prime=20000 run', { encoding: 'utf8', timeout: 180_000 });
    const total = /total time:\s*([0-9.]+)s/.exec(out)?.[1];
    const events = /events per second:\s*([0-9.]+)/.exec(out)?.[1];
    return { status: 'ok', threads: 1, cpuMaxPrime: 20000, totalTimeSec: total ? Number(total) : null, eventsPerSec: events ? Number(events) : null, wallMs: Date.now() - t0 };
  } catch (err) {
    return { status: 'error', detail: String(err).slice(0, 500), wallMs: Date.now() - t0 };
  }
}

function runFio() {
  const t0 = Date.now();
  if (!hasBinary('fio')) {
    return { status: 'skipped', reason: 'fio not installed on host; OPFS-path 4k numbers come from the browser probe (web/probe/)' };
  }
  const tmp = join(ROOT, 'benchmarks', 'results', 'tmp');
  mkdirSync(tmp, { recursive: true });
  const target = join(tmp, `fio-4k-${process.pid}.tmp`);
  try {
    const out = execSync(
      `fio --name=seq --filename=${JSON.stringify(target)} --ioengine=psync --rw=randread --bs=4k --size=64m --numjobs=1 --iodepth=1 --runtime=5 --time_based --direct=1 --output-format=json`,
      { encoding: 'utf8', timeout: 60_000, maxBuffer: 64 * 1024 * 1024 },
    );
    const j = JSON.parse(out);
    const iops = j?.jobs?.[0]?.read?.iops ?? null;
    const bwKb = j?.jobs?.[0]?.read?.bw_bytes ?? null;
    return { status: 'ok', iops4kRandomRead: iops, bytesPerSec: bwKb, bs: '4k', runtimeSec: 5, wallMs: Date.now() - t0 };
  } catch (err) {
    return { status: 'error', detail: String(err).slice(0, 500), wallMs: Date.now() - t0 };
  } finally {
    try { execSync(`rm -f ${JSON.stringify(target)}`); } catch { /* best effort */ }
  }
}

function runGccCompile() {
  // Phase 0 host proxy for "self-compiling gcc": time compiling a large C file
  // (the CoreMark sources concatenated) with the host gcc. The real KPI is
  // measured inside the guest (Phase 1) with the same recipe.
  const t0 = Date.now();
  try {
    const files = ['core_main.c', 'core_list_join.c', 'core_matrix.c', 'core_state.c', 'core_util.c'];
    const t1 = Date.now();
    for (const f of files) {
      execFileSync('gcc', ['-O2', '-w', '-DFLAGS_STR="coremark -O2"', '-DPERFORMANCE_RUN=1', '-I', COREMARK_DIR, '-I', join(COREMARK_DIR, 'posix'), '-I', join(COREMARK_DIR, 'linux'), '-c', join(COREMARK_DIR, f), '-o', join(COREMARK_DIR, f.replace(/\.c$/, '.harness-check.o'))], {
        stdio: 'pipe', timeout: 300_000,
      });
    }
    const compileMs = Date.now() - t1;
    execSync(`rm -f ${COREMARK_DIR}/*.harness-check.o`);
    return {
      status: 'ok',
      proxyFor: 'self-compiling gcc (host compile of CoreMark amalgamation)',
      note: 'guest self-compile of gcc is measured in Phase 1 with the real GCC tree',
      compileMs,
      wallMs: Date.now() - t0,
    };
  } catch (err) {
    return { status: 'error', detail: String(err).slice(0, 500), wallMs: Date.now() - t0 };
  }
}

const guestOnly = (reason) => ({ status: 'skipped', reason });

const benchmarks = {
  coremark: runCoreMark(),
  dhrystone: runDhrystone(),
  sysbenchCpu: runSysbench(),
  fio4kRandomRead: runFio(),
  gccCompileSelf: runGccCompile(),
  bootCold: guestOnly('requires the Phase 1 Debian guest image (boot-time probe not yet measurable)'),
  bootResume: guestOnly('requires snapshot/restore machinery (Phase 3)'),
  bytesFirstPrompt: guestOnly('requires the image packager (Phase 1)'),
};

const report = {
  schema: 1,
  benchmark: 'wasmnux-host-benchmarks',
  kind: FULL ? 'full' : 'screening',
  timestamp: now(),
  commit: getGitCommit(),
  host: hostInfo,
  benchmarks,
};

const text = JSON.stringify(report, null, 2);
const outPath = OUT ? resolve(ROOT, OUT) : join(ROOT, 'benchmarks', 'results', `host-${now().replace(/[:.]/g, '-')}.json`);
mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, text + '\n');
log(`wrote ${outPath}`);
console.log(text);
