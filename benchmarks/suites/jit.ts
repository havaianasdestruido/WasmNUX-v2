/**
 * Spike A suite: the region JIT against the interpreter.
 *
 * This is the suite the ADR-0002/0003/0004 decisions rest on. It answers three
 * questions with numbers instead of opinions:
 *
 *  1. Is a Wasm region JIT faster than a straightforward interpreter, and by how
 *     much, on each *shape* of work (ALU, memory, division, branches, calls,
 *     atomics, devices)?
 *  2. Which configuration wins: register file in Wasm globals or in guest
 *     memory, bounds by trapping or by inline check, host chaining or tail
 *     chaining through a table, and does the optimising pass pay for itself?
 *  3. What does compiling cost - regions, blocks, Wasm bytes, compile and
 *     instantiate milliseconds - relative to the work it accelerates?
 *
 * The correctness question is settled by `core/test/jit.test.ts` (differential,
 * 8 variants x 12 programs); this suite additionally refuses to report a run in
 * which two variants disagreed about a workload's checksum.
 */

import type { EngineOptions } from '@wasmnux/core';
import type { MachineOptions } from '@wasmnux/core';
import { cpuWorkloads, runWorkload, type Workload } from '../src/guest.ts';
import type { BenchCase, Outcome, Suite, Variant } from '../src/types.ts';

/** A configuration under test: engine options plus any machine-level override. */
export interface JitVariant {
  name: string;
  jit: boolean | EngineOptions;
  machine?: Omit<MachineOptions, 'jit'>;
  /** Why this variant is in the suite - printed in the spike report. */
  rationale: string;
}

const GLOBALS_TRAP = { regalloc: 'globals', bounds: 'trap' } as const;
const GLOBALS_INLINE = { regalloc: 'globals', bounds: 'inline' } as const;
const MEMORY_INLINE = { regalloc: 'memory', bounds: 'inline' } as const;

/**
 * The configurations Phase 0 measures. The first entry is always the reference
 * implementation: `speedupsAgainstReference` and the report treat index 0 as the
 * denominator, so do not reorder it.
 */
export const JIT_VARIANTS: JitVariant[] = [
  {
    name: 'interpreter',
    jit: false,
    rationale: 'Tier 0 reference: correctness oracle and the thing the JIT has to beat',
  },
  {
    name: 'jit globals/trap',
    jit: { config: { ...GLOBALS_TRAP } },
    rationale: 'Default layout: register file in mutable Wasm globals, bounds by hardware trap',
  },
  {
    name: 'jit globals/trap +opt',
    jit: { optimize: true, optimizeThreshold: 64, config: { ...GLOBALS_TRAP } },
    rationale: 'Same layout with constant folding and branch folding on recompilation',
  },
  {
    name: 'jit globals/inline',
    jit: { config: { ...GLOBALS_INLINE } },
    rationale: 'Explicit bounds checks instead of trapping: the layout a control page needs',
  },
  {
    name: 'jit memory/inline',
    jit: { config: { ...MEMORY_INLINE } },
    machine: { controlPage: true },
    rationale: 'Register file in guest memory (a trailing control page): fewest globals, worst-case extra loads',
  },
  {
    name: 'jit tail-chain',
    jit: { config: { ...GLOBALS_TRAP, chaining: 'tail' } },
    rationale: 'Region-to-region tail calls through a Wasm table instead of returning to the host',
  },
];

function variantOf(v: JitVariant, w: Workload): Variant {
  return {
    name: v.name,
    run: (): Outcome => runWorkload({ workload: w, jit: v.jit, machine: v.machine }),
  };
}

/** Run every workload once under every variant and check the answers agree. */
export function verifyJitResults(workloads: Workload[] = cpuWorkloads()): void {
  for (const w of workloads) {
    const seen = new Map<string, number>();
    for (const v of JIT_VARIANTS) {
      const out = runWorkload({ workload: w, jit: v.jit, machine: v.machine });
      const result = Number(out.meta?.['result'] ?? NaN);
      seen.set(v.name, result);
    }
    const [refName, ref] = seen.entries().next().value as [string, number];
    for (const [name, value] of seen) {
      if (value !== ref) {
        throw new Error(
          `workload '${w.id}': variant '${name}' computed ${value} but '${refName}' computed ${ref} - refusing to benchmark a disagreement`,
        );
      }
    }
  }
}

export function jitSuite(scale = 1): Suite {
  const workloads = cpuWorkloads(scale);
  const cases: BenchCase[] = workloads.map((w) => ({
    name: w.id,
    description: `${w.title} - ${w.description}`,
    variants: JIT_VARIANTS.map((v) => variantOf(v, w)),
  }));
  return {
    id: 'jit',
    title: 'Spike A: region JIT vs interpreter',
    spike: 'A',
    cases,
    verify: () => verifyJitResults(workloads),
  };
}
