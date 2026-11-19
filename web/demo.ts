/**
 * The browser demo's compute path, kept free of the DOM.
 *
 * Splitting this out of `web/main.ts` is not tidiness for its own sake: it means
 * the exact code the page runs can be executed and asserted on in Node
 * (`core/test/demo.test.ts`), so a broken demo is caught by `npm test` rather
 * than by someone opening the page. The DOM glue lives in `main.ts`.
 *
 * Everything here is browser-safe by construction: no `node:*` imports, no
 * `process`, no filesystem. `crossOriginIsolated` and `navigator.userAgent` are
 * probed rather than read, because neither exists in Node.
 */

import { assemble } from '../core/src/cpu/asm.ts';
import { Machine, type MachineStats } from '../core/src/machine/machine.ts';
import { StringUartSink } from '../core/src/devices/uart.ts';
import { probeWasmFeatures } from '../core/src/jit/wasm/features.ts';

/** Guest RAM base: the QEMU-`virt` address the machine model expects. */
const RAM_BASE = 0x80000000;

/**
 * A compute loop with an observable result: a million iterations of add/xor/mul,
 * so it exercises the ALU path, the multiplier, a backward branch and register
 * pressure, and finishes by reporting through the UART and exiting. A million
 * iterations is ~6 M instructions: enough that JIT warm-up (one region, ~0.2 ms)
 * is not the whole story, and short enough to stay interactive in a page.
 */
export const COMPUTE_PROGRAM = `
  li t0, 0
  li t2, 0
  li s1, 1000000
outer:
  addi t0, t0, 1
  addi t1, t1, 7
  xor t1, t1, t0
  mul t1, t1, t0
  add t2, t2, t1
  blt t0, s1, outer
  mv a0, t2
  li t6, 0x10000000
  sb a0, 0(t6)
  li a7, 93
  ecall
`;

/**
 * A device-polling loop: every iteration stores to the UART, so every iteration
 * leaves compiled code for the host. This is the workload Spike A found to be
 * *slower* compiled (spike-a-jit.md §4.5), and the counters below show the
 * engine noticing and tiring the region back down.
 */
export const MMIO_PROGRAM = `
  li t6, 0x10000000
  li t0, 0
  li s1, 256
put:
  addi t0, t0, 1
  addi a1, zero, 72
  sb a1, 0(t6)
  blt t0, s1, put
  li a7, 93
  ecall
`;

export interface DemoRun {
  engine: 'interpreter' | 'jit';
  ms: number;
  ips: number;
  instructions: number;
  /** a0 at exit: the workload's own checksum. */
  result: number;
  stop: string;
  /** Everything the guest wrote to the UART. */
  output: string;
  stats: MachineStats;
}

export interface DemoCase {
  name: string;
  source: string;
  interpreter?: DemoRun;
  jit?: DemoRun;
  /** True when both engines retired the same count and produced the same a0. */
  agreed?: boolean;
  error?: string;
}

/** Run one guest program on one engine and measure it. */
export function runProgram(source: string, engine: 'interpreter' | 'jit'): DemoRun {
  const img = assemble(source, { base: RAM_BASE });
  const sink = new StringUartSink();
  const jit = engine === 'jit';
  const machine = new Machine({
    ramBytes: 1 << 20,
    // Shared RAM only exists when the page is cross-origin isolated; fall back
    // rather than throwing, so the demo still runs on a misconfigured host and
    // says so.
    shared: typeof SharedArrayBuffer !== 'undefined',
    controlPage: jit,
    jit: jit ? { jit: true, optimize: true, config: { regalloc: 'memory', bounds: 'inline' } } : false,
    uartSink: sink,
  });
  machine.load(img.bytes, img.entry);
  const t0 = performance.now();
  machine.run(200_000_000);
  const ms = performance.now() - t0;
  const stats = machine.stats();
  return {
    engine,
    ms,
    ips: ms > 0 ? stats.instructions / (ms / 1000) : 0,
    instructions: stats.instructions,
    result: machine.cpu.regs[10]!,
    stop: machine.cpu.stop,
    output: sink.text,
    stats,
  };
}

/** Run every demo case on both engines and compare. */
export function runDemo(): DemoCase[] {
  const cases: Array<{ name: string; source: string }> = [
    { name: 'compute loop (1M iterations of add/xor/mul)', source: COMPUTE_PROGRAM },
    { name: 'uart mmio (256 device stores)', source: MMIO_PROGRAM },
  ];
  return cases.map(({ name, source }) => {
    const out: DemoCase = { name, source };
    try {
      out.interpreter = runProgram(source, 'interpreter');
      out.jit = runProgram(source, 'jit');
      out.agreed =
        out.interpreter.result === out.jit.result &&
        out.interpreter.instructions === out.jit.instructions &&
        out.interpreter.output === out.jit.output;
    } catch (err) {
      out.error = String(err);
    }
    return out;
  });
}

/** What the runtime supports, as far as this page can tell. */
export interface DemoEnv {
  userAgent: string;
  crossOriginIsolated: boolean | null;
  sharedArrayBuffer: boolean;
  threads: boolean;
  atomics: boolean;
  atomicWait: boolean;
  simd: boolean;
  memory64Validates: boolean;
  maxMemory32Pages: number;
  maxSharedMemoryPages: number;
  hardwareConcurrency: number;
}

export function demoEnv(): DemoEnv {
  const f = probeWasmFeatures();
  const nav = typeof navigator === 'undefined' ? undefined : navigator;
  return {
    userAgent: nav?.userAgent ?? 'unknown (not a browser)',
    crossOriginIsolated: f.crossOriginIsolated,
    sharedArrayBuffer: typeof SharedArrayBuffer !== 'undefined',
    threads: f.threads,
    atomics: f.atomics,
    atomicWait: f.atomicWait,
    simd: f.simd,
    memory64Validates: f.memory64,
    maxMemory32Pages: f.maxMemory32Pages,
    maxSharedMemoryPages: f.maxSharedMemoryPages,
    hardwareConcurrency: f.hardwareConcurrency,
  };
}
