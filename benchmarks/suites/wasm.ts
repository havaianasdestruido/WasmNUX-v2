/**
 * Platform suite: what the WebAssembly runtime actually does here.
 *
 * ADR-0003 (one module per region) and ADR-0004 (guest RAM in a single
 * `WebAssembly.Memory`) are only sound if the platform cooperates, and the
 * platform differs between Node, Chromium, Firefox and Safari. This suite
 * records the facts rather than assuming them:
 *
 *  - the feature probes (threads, atomics, SIMD, bulk memory, memory64, tail
 *    calls, shared-memory growth, cross-origin isolation);
 *  - what it costs to reserve a 4 GiB address space, and whether a *shared*
 *    reservation is allowed at all (Spike B depends on it);
 *  - what it costs to compile a module of a given size, which is what bounds the
 *    sensible region size in ADR-0003;
 *  - raw atomic read-modify-write throughput, from both JS `Atomics` and Wasm
 *    `i32.atomic.add`, which is the mechanism guest LR/SC and AMO land on.
 *
 * These numbers go into the spike documents verbatim, and the feature block is
 * attached to every report so a regression can be attributed to a platform
 * change instead of a code change.
 */

import { WasmFeatures, WasmModuleBuilder, compileModuleSync } from '@wasmnux/core';
import type { BenchCase, Outcome, Suite } from '../src/types.ts';

const PAGE = 65536;
const MAX_PAGES_RV32 = 65536; // 4 GiB: the whole RV32 address space

function featureCase(): BenchCase {
  return {
    name: 'features',
    description: 'Runtime capability probes (recorded, not timed)',
    showMeta: true,
    metric: { name: 'probe ms', value: (best) => best.ms, digits: 2, lowerIsBetter: true },
    variants: [
      {
        name: 'probe',
        run: (): Outcome => {
          const t0 = performance.now();
          const f = WasmFeatures.probeWasmFeatures();
          const ms = performance.now() - t0;
          const meta: Record<string, string | number | boolean> = {};
          for (const [k, v] of Object.entries(f)) {
            // Keep the block readable: only the facts a decision depends on.
            if (typeof v === 'boolean' && v) meta[k] = true;
            else if (typeof v === 'number') meta[k] = v;
            else if (typeof v === 'boolean') meta[k] = false;
          }
          return { ms, instructions: 1, meta };
        },
      },
    ],
  };
}

function reserveCase(): BenchCase {
  const reserve = (name: string, opts: WebAssembly.MemoryDescriptor, pages: number): Outcome => {
    const t0 = performance.now();
    let ok = true;
    let current = 0;
    try {
      const m = new WebAssembly.Memory(opts);
      current = m.buffer.byteLength / PAGE;
    } catch {
      ok = false;
    }
    const ms = performance.now() - t0;
    return {
      ms,
      instructions: pages,
      meta: { ok, initialPages: current, requestedMaxPages: opts.maximum ?? pages },
    };
  };
  return {
    name: 'memory-reserve',
    description: 'Cost and feasibility of reserving guest address space',
    showMeta: true,
    metric: { name: 'reserve ms', value: (best) => best.ms, digits: 3, lowerIsBetter: true },
    variants: [
      {
        name: '4 GiB max, 1 page committed',
        run: () => reserve('lazy', { initial: 1, maximum: MAX_PAGES_RV32 }, MAX_PAGES_RV32),
      },
      {
        name: '4 GiB max, shared',
        run: () => reserve('shared', { initial: 1, maximum: MAX_PAGES_RV32, shared: true }, MAX_PAGES_RV32),
      },
      {
        name: '256 MiB committed',
        run: () => reserve('committed', { initial: 4096, maximum: 4096 }, 4096),
      },
      {
        name: '256 MiB committed, shared',
        run: () => reserve('committed-shared', { initial: 4096, maximum: 4096, shared: true }, 4096),
      },
    ],
  };
}

/** A module of roughly `ops` i32 instructions, used to price compilation. */
function fillerModule(ops: number): Uint8Array<ArrayBuffer> {
  const b = new WasmModuleBuilder();
  const f = b.addFunc('fill', ['i32'], ['i32']);
  f.localGet(0);
  for (let i = 0; i < ops; i++) f.i32(i & 0x7f).i32Add();
  b.exportFunc('fill', 0);
  return b.build();
}

function compileCase(): BenchCase {
  const sizes = [256, 4096, 32768];
  return {
    name: 'module-compile',
    description: 'Synchronous compile+instantiate cost by module size (bounds region size, ADR-0003)',
    showMeta: true,
    metric: { name: 'compile ms', value: (best) => best.ms, digits: 3, lowerIsBetter: true },
    variants: sizes.map((ops) => ({
      name: `${ops} instructions`,
      run: (): Outcome => {
        const bytes = fillerModule(ops);
        const t0 = performance.now();
        const inst = compileModuleSync(bytes);
        const ms = performance.now() - t0;
        const fn = inst.exports['fill'] as (x: number) => number;
        fn(1); // make sure it is really usable, not lazily deferred
        return {
          ms,
          instructions: ops,
          meta: { moduleBytes: bytes.length, nsPerInsn: ms > 0 ? round((ms * 1e6) / ops) : 0 },
        };
      },
    })),
  };
}

function atomicsCase(iterations: number): BenchCase {
  return {
    name: 'atomics-micro',
    description: 'JS Atomics vs Wasm i32.atomic.add, nanoseconds per operation (Spike B prerequisite)',
    showMeta: true,
    metric: {
      name: 'wasm atomic ns/op',
      value: (_best, stats) => stats?.['wasmAtomicAddNs'] ?? 0,
      digits: 2,
      lowerIsBetter: true,
    },
    variants: [
      {
        name: `micro x${iterations}`,
        run: (): Outcome => {
          const t0 = performance.now();
          const r = WasmFeatures.measureAtomicsMicro(iterations);
          const ms = performance.now() - t0;
          return {
            ms,
            instructions: iterations,
            stats: {
              atomicsAddNs: round(r.atomicsAddNs),
              atomicsCmpxchgNs: round(r.atomicsCmpxchgNs),
              wasmAtomicAddNs: round(r.wasmAtomicAddNs),
              wasmPlainStoreNs: round(r.wasmPlainStoreNs),
            },
            meta: {
              jsAtomicsAddNs: round(r.atomicsAddNs),
              jsCmpxchgNs: round(r.atomicsCmpxchgNs),
              wasmAtomicAddNs: round(r.wasmAtomicAddNs),
              wasmPlainStoreLoadNs: round(r.wasmPlainStoreNs),
            },
          };
        },
      },
    ],
  };
}

function round(x: number): number {
  return Math.round(x * 1000) / 1000;
}

export function wasmSuite(atomicsIterations = 1_000_000): Suite {
  return {
    id: 'wasm',
    title: 'WebAssembly platform capabilities and costs',
    spike: 'A',
    cases: [featureCase(), reserveCase(), compileCase(), atomicsCase(atomicsIterations)],
  };
}
