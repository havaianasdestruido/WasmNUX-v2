/**
 * Runtime WebAssembly feature probes.
 *
 * ADR-0004 (guest RAM model) and ADR-0002/0003 (execution strategy, module
 * granularity) both hinge on what the *actual* browser supports, and the answer
 * differs between Chromium, Firefox, Safari and Node. Rather than trusting a
 * static compatibility table, every capability the design leans on is probed at
 * runtime and recorded in the benchmark results (`benchmarks/suites/wasm.ts`).
 *
 * The probes are `WebAssembly.validate`-based where possible: validation is the
 * cheapest way to ask "would this module compile here", and it never executes
 * untrusted code.
 */

import { compileModuleSync, FuncEmitter, WasmModuleBuilder } from './encoder.ts';

export interface WasmFeatureReport {
  threads: boolean;
  sharedMemoryGrowable: boolean;
  atomics: boolean;
  atomicWait: boolean;
  simd: boolean;
  bulkMemory: boolean;
  memory64: boolean;
  tailCalls: boolean;
  exceptions: boolean;
  /** Largest 32-bit memory we could reserve (pages of 64 KiB). */
  maxMemory32Pages: number;
  /** Largest shared memory we could reserve (pages of 64 KiB). */
  maxSharedMemoryPages: number;
  hardwareConcurrency: number;
  crossOriginIsolated: boolean | null;
  isWorker: boolean;
  isNode: boolean;
  userAgent: string;
}

const validate = (build: (b: WasmModuleBuilder) => void): boolean => {
  try {
    const b = new WasmModuleBuilder();
    build(b);
    return WebAssembly.validate(b.build());
  } catch {
    return false;
  }
};

export function probeWasmFeatures(): WasmFeatureReport {
  const nav = (globalThis as { navigator?: { userAgent?: string; hardwareConcurrency?: number } }).navigator;

  // Shared memory (the threads proposal's entry ticket).
  let threads = false;
  try {
    new WebAssembly.Memory({ initial: 1, maximum: 2, shared: true });
    threads = true;
  } catch {
    threads = false;
  }

  let sharedGrowable = false;
  if (threads) {
    try {
      const m = new WebAssembly.Memory({ initial: 1, maximum: 4, shared: true });
      m.grow(1);
      sharedGrowable = true;
    } catch {
      sharedGrowable = false;
    }
  }

  const atomics = validate((b) => {
    b.importMemory('env', 'mem', { min: 1, max: 1, shared: true });
    const f = b.addFunc('probe', ['i32', 'i32'], ['i32']);
    // old = atomic.add(addr, v); old2 = atomic.cmpxchg(addr, v, v); return old + old2
    f.localGet(0).localGet(1).i32AtomicAdd();
    f.localGet(0).localGet(1).localGet(1).i32AtomicCmpxchg();
    f.i32Add();
  });

  const atomicWait = validate((b) => {
    b.importMemory('env', 'mem', { min: 1, max: 1, shared: true });
    const f = b.addFunc('probe', ['i32', 'i32'], ['i32']);
    f.localGet(0).localGet(1).i64(0n).memoryAtomicWait32();
  });

  const simd = validate((b) => {
    b.importMemory('env', 'mem', { min: 1, max: 1 });
    const f = b.addFunc('probe', ['i32'], ['i32']);
    const v = f.addLocals(1, 'v128');
    f.localGet(0)
      .v128Load()
      .localGet(0)
      .v128Load()
      .i32x4Add()
      .localSet(v)
      .localGet(0)
      .localGet(v)
      .v128Store()
      .i32(0);
  });

  const bulkMemory = validate((b) => {
    b.importMemory('env', 'mem', { min: 1, max: 1 });
    const f = b.addFunc('probe', ['i32', 'i32', 'i32'], []);
    f.localGet(0).localGet(1).localGet(2).memoryCopy().localGet(0).i32(0).localGet(2).memoryFill();
  });

  const memory64 = validate((b) => {
    b.addMemory({ min: 1, max: 2, index64: true });
    const f = b.addFunc('probe', ['i64'], ['i32']);
    f.localGet(0).i32(1).i32Store(0, 2).localGet(0).i32Load(0, 2);
  });

  const tailCalls = validate((b) => {
    const callee = b.addFunc('callee', ['i32'], ['i32']);
    callee.localGet(0);
    const caller = b.addFunc('caller', ['i32'], ['i32']);
    caller.localGet(0).returnCall(0);
  });

  const exceptions =
    typeof (WebAssembly as unknown as { Tag?: unknown }).Tag === 'function' &&
    typeof (WebAssembly as unknown as { Exception?: unknown }).Exception === 'function';

  return {
    threads,
    sharedMemoryGrowable: sharedGrowable,
    atomics,
    atomicWait,
    simd,
    bulkMemory,
    memory64,
    tailCalls,
    exceptions,
    maxMemory32Pages: probeMaxPages(false),
    maxSharedMemoryPages: probeMaxPages(true),
    hardwareConcurrency: nav?.hardwareConcurrency ?? 1,
    crossOriginIsolated:
      typeof (globalThis as { crossOriginIsolated?: boolean }).crossOriginIsolated === 'boolean'
        ? (globalThis as { crossOriginIsolated: boolean }).crossOriginIsolated
        : null,
    isWorker: typeof (globalThis as { WorkerGlobalScope?: unknown }).WorkerGlobalScope !== 'undefined',
    isNode: typeof process !== 'undefined' && typeof process.versions?.node === 'string',
    userAgent: nav?.userAgent ?? `node/${typeof process !== 'undefined' ? process.versions.node : '?'}`,
  };
}

/** Binary-search the largest memory we can reserve without actually touching it. */
function probeMaxPages(shared: boolean): number {
  // Probe `maximum` with `initial: 1`, i.e. what a guest could *reserve* and
  // grow into. Probing `initial: pages` instead would measure how much the
  // runtime is willing to commit right now, which is a different (and much
  // smaller) number, and which used to make this report 1024 pages for shared
  // memory while a 65536-page reservation succeeds in microseconds.
  const tryPages = (pages: number): boolean => {
    try {
      new WebAssembly.Memory({ initial: 1, maximum: pages, shared });
      return true;
    } catch {
      return false;
    }
  };
  const cap = 65536; // 4 GiB, the whole 32-bit address space
  let lo = 1;
  let hi = cap;
  if (tryPages(hi)) return hi;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (tryPages(mid)) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/** Cheap micro-measurements used by the ADR-0004 write-up. */
export interface AtomicsMicroResult {
  /** ns per `Atomics.add` on a shared Int32Array (uncontended). */
  atomicsAddNs: number;
  /** ns per `Atomics.compareExchange` (uncontended). */
  atomicsCmpxchgNs: number;
  /** ns per Wasm `i32.atomic.rmw.add` (uncontended). */
  wasmAtomicAddNs: number;
  /** ns per plain (non-atomic) Wasm `i32.load`+`i32.store` pair. */
  wasmPlainStoreNs: number;
  iterations: number;
}

export function measureAtomicsMicro(iterations = 2_000_000): AtomicsMicroResult {
  const mem = new WebAssembly.Memory({ initial: 1, maximum: 1, shared: true });
  const i32 = new Int32Array(mem.buffer);

  const b = new WasmModuleBuilder();
  b.importMemory('env', 'mem', { min: 1, max: 1, shared: true });
  const atomicLoop = b.addFunc('atomicLoop', ['i32', 'i32'], ['i32']);
  const acc = atomicLoop.addLocals(1, 'i32');
  atomicLoop.block('void');
  atomicLoop.loop('void');
  atomicLoop.localGet(0).i32(1).i32AtomicAdd().localSet(acc);
  atomicLoop.localGet(1).i32(1).i32Sub().localTee(1).brIf(0);
  atomicLoop.end();
  atomicLoop.end();
  atomicLoop.localGet(acc);

  const plainLoop = b.addFunc('plainLoop', ['i32', 'i32'], ['i32']);
  const pacc = plainLoop.addLocals(1, 'i32');
  plainLoop.block('void');
  plainLoop.loop('void');
  plainLoop.localGet(0).i32(7).i32Store();
  plainLoop.localGet(0).i32Load().localSet(pacc);
  plainLoop.localGet(1).i32(1).i32Sub().localTee(1).brIf(0);
  plainLoop.end();
  plainLoop.end();
  plainLoop.localGet(pacc);

  b.exportFunc('atomicLoop', 0);
  b.exportFunc('plainLoop', 1);
  const instance = compileModuleSync(b.build(), { env: { mem } });
  const wasmAtomic = instance.exports['atomicLoop'] as (addr: number, n: number) => number;
  const wasmPlain = instance.exports['plainLoop'] as (addr: number, n: number) => number;

  const time = (fn: () => void): number => {
    const t0 = process.hrtime.bigint();
    fn();
    return Number(process.hrtime.bigint() - t0) / iterations;
  };

  const atomicsAddNs = time(() => {
    for (let i = 0; i < iterations; i++) Atomics.add(i32, 64, 1);
  });
  const atomicsCmpxchgNs = time(() => {
    for (let i = 0; i < iterations; i++) Atomics.compareExchange(i32, 65, i, i + 1);
  });
  const wasmAtomicAddNs = time(() => {
    wasmAtomic(256, iterations);
  });
  const wasmPlainStoreNs = time(() => {
    wasmPlain(512, iterations);
  });

  return { atomicsAddNs, atomicsCmpxchgNs, wasmAtomicAddNs, wasmPlainStoreNs, iterations };
}

/** Keep the emitter type referenced so tree-shaking does not drop the import in bundlers. */
export type _Emitter = FuncEmitter;
