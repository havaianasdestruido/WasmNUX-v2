/**
 * Guest workloads for the CPU benchmarks.
 *
 * Hand-written RV32IMA assembly, because Phase 0 has no guest toolchain: the
 * workloads a real system would run (CoreMark, Dhrystone, `sysbench`, a
 * self-compiling gcc) need a booted Debian, and that is Phase 1. What these
 * programs cover instead is the *shape* of the work those benchmarks are made
 * of - tight ALU loops, strided memory traffic, division, unpredictable
 * branches, call/return depth, atomics and device polling - which is exactly
 * what a JIT decision has to be based on.
 *
 * Every workload ends by moving a checksum into `a0`, and the exit syscall
 * passes `a0` through, so a benchmark run also *verifies* that every execution
 * variant computed the same answer. A speedup that changes the result is a bug,
 * not a win.
 */

import { assemble, Machine, type EngineOptions, type MachineOptions } from '@wasmnux/core';
import type { Outcome } from './types.ts';

export const RAM_BASE = 0x80000000;
export const DEFAULT_RAM_BYTES = 16 << 20;
/** Data area, well clear of the code at the base of RAM. */
export const DATA = RAM_BASE + 0x400000;
export const STACK_TOP = DATA + 0x200000;

const EXIT = 'li a7, 93\n  ecall';

export interface Workload {
  id: string;
  title: string;
  /** What about a real workload this stands in for. */
  description: string;
  source: string;
  /** Machine options the workload needs (shared memory for atomics, ...). */
  machine?: Omit<MachineOptions, 'jit'>;
  /** Instruction budget; a workload that does not finish is a failed benchmark. */
  budget?: number;
}

/**
 * Tight ALU loop: add / xor / addi / blt. The classic "how fast is your
 * dispatch" workload, and the one where a region JIT should shine brightest
 * because nothing leaves the compiled region at all.
 */
function arithLoop(iterations: number): Workload {
  return {
    id: 'arith-loop',
    title: 'tight ALU loop',
    description: 'add/xor/addi/blt with no memory traffic; stands in for interpreter dispatch overhead',
    budget: iterations * 8,
    source: `_start:
  li   t0, 0
  li   t1, ${iterations}
loop:
  add  t2, t2, t0
  xor  t3, t3, t2
  addi t0, t0, 1
  blt  t0, t1, loop
  add  a0, t2, t3
  ${EXIT}`,
  };
}

/**
 * Copy a 4 KiB buffer word by word, repeatedly: strided load/store traffic with
 * a nested loop, the shape of memcpy, page clearing and filesystem copies.
 */
function memoryCopy(words: number, repeats: number): Workload {
  return {
    id: 'memory-copy',
    title: `copy ${words} words x${repeats}`,
    description: 'lw/sw copy of a buffer; stands in for memcpy, page clearing and block-device transfers',
    budget: words * repeats * 16,
    source: `_start:
  li   a1, ${DATA}
  li   a2, ${DATA + 0x40000}
  li   a3, ${words}
  li   s1, ${repeats}
  li   t0, 0
  li   s0, 0
outer:
  li   t1, 0
inner:
  slli t2, t1, 2
  add  t3, a1, t2
  add  t4, a2, t2
  lw   t5, 0(t3)
  add  s0, s0, t5
  sw   t5, 0(t4)
  addi t1, t1, 1
  blt  t1, a3, inner
  addi t0, t0, 1
  blt  t0, s1, outer
  mv   a0, s0
  ${EXIT}`,
  };
}

/**
 * Divide-heavy loop driven by a linear congruential generator: integer division
 * and remainder are the instructions a Wasm backend translates most directly
 * (i32.div_s / i32.rem_u) but an interpreter implements most slowly, so this is
 * where the JIT ratio should be largest after the ALU loop.
 */
function divMod(iterations: number): Workload {
  return {
    id: 'divmod',
    title: 'LCG with div/rem',
    description: 'mul/addi/divu/remu/xor; stands in for hashing, checksums and numeric kernels',
    budget: iterations * 12,
    source: `_start:
  li   a0, 1
  li   t2, 1103515245
  li   t4, 7
  li   t1, ${iterations}
  li   s0, 0
loop:
  mul  a0, a0, t2
  addi a0, a0, 1245
  divu t3, a0, t4
  remu t5, a0, t4
  xor  s0, s0, t5
  add  s0, s0, t3
  addi t1, t1, -1
  bnez t1, loop
  mv   a0, s0
  ${EXIT}`,
  };
}

/**
 * Data-dependent branch: the taken/not-taken decision comes from a pseudo-random
 * bit, so it cannot be folded or predicted by the translator. This measures the
 * cost of the region's internal `br_table` dispatch against the interpreter's
 * switch, which is the part of ADR-0003 that has to pay for itself.
 */
function branchy(iterations: number): Workload {
  return {
    id: 'branchy',
    title: 'unpredictable branches',
    description: 'LCG-driven beqz/j around two accumulators; stands in for parsers and interpreters',
    budget: iterations * 16,
    source: `_start:
  li   a0, 1
  li   t2, 1103515245
  li   t1, ${iterations}
  li   s0, 0
  li   s1, 0
loop:
  mul  a0, a0, t2
  addi a0, a0, 1245
  srli t3, a0, 16
  andi t3, t3, 1
  beqz t3, even
  addi s0, s0, 1
  j    cont
even:
  addi s1, s1, 1
cont:
  addi t1, t1, -1
  bnez t1, loop
  add  a0, s0, s1
  ${EXIT}`,
  };
}

/**
 * Recursive fibonacci: deep call/return with `jal` and `jalr`/`ret`, so almost
 * every block ends in an indirect exit. This is the workload that decides
 * whether tail chaining through a Wasm table is worth its complexity
 * (ADR-0003) or whether host-side chaining is enough.
 */
function recursiveCalls(n: number): Workload {
  return {
    id: 'calls',
    title: `recursive fib(${n})`,
    description: 'jal/ret recursion with a stack frame; stands in for call-heavy code and interpreters',
    budget: 60_000_000,
    source: `_start:
  li   sp, ${STACK_TOP}
  li   a0, ${n}
  jal  ra, fib
  ${EXIT}
fib:
  addi sp, sp, -12
  sw   ra, 8(sp)
  sw   s0, 4(sp)
  sw   s1, 0(sp)
  mv   s0, a0
  li   t0, 2
  blt  s0, t0, base
  addi a0, s0, -1
  jal  ra, fib
  mv   s1, a0
  addi a0, s0, -2
  jal  ra, fib
  add  a0, a0, s1
  j    epi
base:
  mv   a0, s0
epi:
  lw   ra, 8(sp)
  lw   s0, 4(sp)
  lw   s1, 0(sp)
  addi sp, sp, 12
  ret`,
  };
}

/**
 * Atomic read-modify-write in a loop on shared memory: the guest AMO maps to a
 * Wasm atomic, which is the mechanism Spike B (SMP) depends on. Measured here
 * because it is also the worst case for the register-file-in-globals layout -
 * an atomic has to go to memory regardless.
 */
function atomicLoop(iterations: number): Workload {
  return {
    id: 'atomics',
    title: 'amoadd.w loop',
    description: 'atomic RMW on shared guest RAM; the mechanism Spike B (SMP) is built on',
    machine: { shared: true },
    budget: iterations * 8,
    source: `_start:
  li   a0, ${DATA}
  li   t1, ${iterations}
  li   s0, 0
loop:
  li   t2, 1
  amoadd.w t3, t2, (a0)
  add  s0, s0, t3
  addi t1, t1, -1
  bnez t1, loop
  lw   a1, 0(a0)
  add  a0, s0, a1
  ${EXIT}`,
  };
}

/**
 * Nested loops over a matrix with strided access: the closest thing here to a
 * real application kernel, and the case where constant folding of addresses
 * (the `optimize` knob) should be visible.
 */
function matrixScale(dim: number, repeats: number): Workload {
  return {
    id: 'matrix',
    title: `${dim}x${dim} scale x${repeats}`,
    description: 'nested loops over a strided matrix; stands in for image, audio and numeric kernels',
    budget: dim * dim * repeats * 24,
    source: `_start:
  li   a1, ${DATA}
  li   a3, ${dim}
  li   s2, ${repeats}
  li   s3, 0
rep:
  li   t0, 0
row:
  li   t1, 0
  mul  s4, t0, a3
  slli s4, s4, 2
  add  s4, s4, a1
col:
  slli t2, t1, 2
  add  t3, s4, t2
  lw   t4, 0(t3)
  mul  t4, t4, a3
  addi t4, t4, 3
  sw   t4, 0(t3)
  add  s3, s3, t4
  addi t1, t1, 1
  blt  t1, a3, col
  addi t0, t0, 1
  blt  t0, a3, row
  addi s2, s2, -1
  bnez s2, rep
  mv   a0, s3
  ${EXIT}`,
  };
}

/**
 * Device polling: read a UART status register until data arrives, then read the
 * byte. Almost every instruction is a host exit, so this workload measures the
 * slow-path machinery rather than throughput - specifically that the engine
 * *learns* the MMIO pc and keeps the surrounding loop compiled instead of
 * falling back to the interpreter or, worse, spinning.
 */
function devicePoll(polls: number): Workload {
  return {
    id: 'device-poll',
    title: `UART poll x${polls}`,
    description: 'MMIO status polling then a data read; measures the slow-path/learning machinery',
    budget: polls * 40,
    source: `_start:
  li   a0, 0x10000000
  li   t0, ${polls}
  li   s0, 0
poll:
  lbu  t1, 5(a0)
  andi t1, t1, 1
  beqz t1, nodata
  lbu  t2, 0(a0)
  add  s0, s0, t2
nodata:
  addi t0, t0, -1
  bnez t0, poll
  mv   a0, s0
  ${EXIT}`,
  };
}

/** The Phase 0 CPU suite. Sizes are chosen so the interpreter finishes in ~0.1 s. */
export function cpuWorkloads(scale = 1): Workload[] {
  const s = Math.max(1, Math.round(scale));
  return [
    arithLoop(2_000_000 * s),
    memoryCopy(1024, 500 * s),
    divMod(1_000_000 * s),
    branchy(600_000 * s),
    recursiveCalls(scale > 1 ? 26 : 24),
    atomicLoop(1_000_000 * s),
    matrixScale(64, 40 * s),
    devicePoll(20_000),
  ];
}

export interface GuestRunOptions {
  workload: Workload;
  /** `false` for the interpreter baseline, engine options for a JIT variant. */
  jit: boolean | EngineOptions;
  /** Per-variant machine overrides (a control page, a different tick interval). */
  machine?: Omit<MachineOptions, 'jit'>;
}

/**
 * Build a fresh machine for the workload, run it to completion, and report the
 * guest-side instruction count and the engine's own wall time.
 *
 * Construction is deliberately outside the measured window: allocating guest RAM
 * and assembling the image are host setup, not emulation, and including them
 * would let a 16 MiB `WebAssembly.Memory` dominate a 5 ms run.
 */
export function runWorkload(opts: GuestRunOptions): Outcome {
  const w = opts.workload;
  const a = assemble(w.source, { base: RAM_BASE });
  const machine = new Machine({
    ramBytes: DEFAULT_RAM_BYTES,
    ramBase: RAM_BASE,
    ...w.machine,
    ...opts.machine,
    jit: opts.jit,
  });
  machine.load(a.bytes, a.entry);
  machine.reset(a.entry, STACK_TOP);
  const budget = w.budget ?? 200_000_000;
  const stop = machine.run(budget);
  const s = machine.stats();
  if (stop !== 'exit') throw new Error(`workload ${w.id} stopped with '${stop}', not 'exit' (budget ${budget})`);
  return {
    ms: s.wallMs,
    instructions: s.instructions,
    stats: {
      jitInstructions: s.jitInstructions,
      interpInstructions: s.interpInstructions,
      regionsCompiled: s.regionsCompiled,
      blocksCompiled: s.blocksCompiled,
      wasmBytes: s.wasmBytes,
      compileMs: round3(s.compileMs),
      instantiateMs: round3(s.instantiateMs),
      cacheHits: s.cacheHits,
      hostExits: s.hostExits,
      traps: s.traps,
      mmioReads: s.mmioReads,
      mmioWrites: s.mmioWrites,
      ips: Math.round(s.ips),
    },
    meta: { result: machine.cpu.exitCode, imageBytes: a.bytes.length, stop },
  };
}

function round3(x: number): number {
  return Math.round(x * 1000) / 1000;
}
