/**
 * `@wasmnux/bench` - the benchmark harness.
 *
 * The public surface is what CI and the docs consume: run suites, record results
 * per commit, gate on regressions, and render reports. Suites live in
 * `benchmarks/suites/` and register themselves in `suites/index.ts`.
 */

export * from './types.ts';
export {
  DEFAULT_REPS,
  DEFAULT_WARMUP,
  captureEnv,
  ipsOf,
  measureVariant,
  runSuite,
  runSuites,
  speedupsAgainstReference,
  withHostInfo,
  type MeasureOptions,
} from './harness.ts';
export {
  DEFAULT_TOLERANCE,
  baselinesDir,
  captureGit,
  gate,
  hostInfo,
  latestReport,
  readBaseline,
  readReport,
  repoRoot,
  resultsDir,
  writeBaselines,
  writeReport,
} from './store.ts';
export { formatEnv, formatGate, formatResults, mips, toMarkdown } from './report.ts';
export {
  DATA,
  DEFAULT_RAM_BYTES,
  RAM_BASE,
  STACK_TOP,
  cpuWorkloads,
  runWorkload,
  type GuestRunOptions,
  type Workload,
} from './guest.ts';
export { SUITE_REGISTRY, resolveSuites, suiteIds, type SuiteEntry, type SuiteOptions } from '../suites/index.ts';
export { JIT_VARIANTS, jitSuite, verifyJitResults } from '../suites/jit.ts';
export { baselineSuite, comparableWorkloads, loadBaselineEmulator } from '../suites/baseline.ts';
export { wasmSuite } from '../suites/wasm.ts';
