/**
 * Suite registry.
 *
 * Suites are listed here rather than discovered by scanning the filesystem, so
 * the CLI (and a browser harness, which cannot scan anything) can be given the
 * same ids in Node and in CI. Factories may be async - the comparator suite has
 * to load a wasm module first - and may return null to declare themselves
 * unavailable on this platform instead of failing the run.
 */

import type { Suite } from '../src/types.ts';
import { baselineSuite } from './baseline.ts';
import { jitSuite } from './jit.ts';
import { wasmSuite } from './wasm.ts';

export interface SuiteOptions {
  /** Workload size multiplier: 1 is the default (~0.1 s interpreted per case). */
  scale?: number;
  /** Ceiling for shared-memory reservations, in 64 KiB pages (see wasm.ts). */
  sharedCeilingPages?: number;
  /** True when the suites are running inside a browser page. */
  inBrowser?: boolean;
}

export interface SuiteEntry {
  id: string;
  title: string;
  /** ROADMAP §5 spike this suite produces evidence for. */
  spike: string;
  /** Approximate wall time at scale 1, in seconds - used by `--quick`. */
  costSeconds: number;
  factory: (opts: SuiteOptions) => Suite | Promise<Suite | null>;
}

export const SUITE_REGISTRY: SuiteEntry[] = [
  {
    id: 'jit',
    title: 'Spike A: region JIT vs interpreter',
    spike: 'A',
    costSeconds: 20,
    factory: (o) => jitSuite(o.scale ?? 1),
  },
  {
    id: 'wasm',
    title: 'WebAssembly platform capabilities and costs',
    spike: 'A',
    costSeconds: 10,
    factory: (o) =>
      wasmSuite(o.scale && o.scale > 1 ? 2_000_000 : 1_000_000, {
        sharedCeilingPages: o.sharedCeilingPages,
        inBrowser: o.inBrowser,
      }),
  },
  {
    id: 'baseline',
    title: 'Existing in-browser emulator comparison',
    spike: 'A',
    costSeconds: 10,
    factory: (o) => baselineSuite(o.scale ?? 1),
  },
];

export function suiteIds(): string[] {
  return SUITE_REGISTRY.map((s) => s.id);
}

/** Resolve the suites named on the command line (`--all` for everything). */
export async function resolveSuites(ids: string[] | 'all', opts: SuiteOptions = {}): Promise<Suite[]> {
  const wanted = ids === 'all' ? SUITE_REGISTRY : SUITE_REGISTRY.filter((s) => ids.includes(s.id));
  const unknown = ids === 'all' ? [] : ids.filter((id) => !SUITE_REGISTRY.some((s) => s.id === id));
  if (unknown.length)
    throw new Error(`unknown suite(s): ${unknown.join(', ')} (available: ${suiteIds().join(', ')})`);
  const out: Suite[] = [];
  for (const entry of wanted) {
    const suite = await entry.factory(opts);
    if (suite) out.push(suite);
  }
  return out;
}

export { baselineSuite, jitSuite, wasmSuite };
