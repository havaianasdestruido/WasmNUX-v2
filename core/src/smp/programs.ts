/**
 * Guest programs used by the SMP stress tests and benchmarks.
 *
 * They are assembled from the same RV32IMA assembler the core tests use, so
 * the guest path under test is the real interpreter + A extension, not a JS
 * model of it.
 */

import { assemble, type Assembled } from '../cpu/asm.ts';

export const SMP_RAM_BASE = 0x80000000;
export const SMP_DATA = {
  counter: SMP_RAM_BASE + 0x8000,
  cell: SMP_RAM_BASE + 0x8004,
  lock: SMP_RAM_BASE + 0x8008,
  out: SMP_RAM_BASE + 0x800c,
} as const;

const EXIT = '  li a7, 93\n  ecall\n';

/** Every hart adds 1 to a shared word `iters` times. */
export function amoCounterProgram(iters: number): Assembled {
  return assemble(
    `  li a1, ${SMP_DATA.counter}\n` +
      `  li a2, ${iters}\n` +
      `  li a3, 1\n` +
      `loop:\n` +
      `  amoadd.w a0, a3, (a1)\n` +
      `  addi a2, a2, -1\n` +
      `  bnez a2, loop\n` +
      EXIT,
    { base: SMP_RAM_BASE },
  );
}

/** Every hart takes an LR/SC spinlock `iters` times and increments a cell. */
export function lrscLockProgram(iters: number): Assembled {
  return assemble(
    `  li a1, ${SMP_DATA.lock}\n` +
      `  li a2, ${SMP_DATA.cell}\n` +
      `  li a3, ${iters}\n` +
      `outer:\n` +
      `  lr.w a0, (a1)\n` +
      `  bnez a0, outer\n` +
      `  li a4, 1\n` +
      `  sc.w a0, a4, (a1)\n` +
      `  bnez a0, outer\n` +
      `  lw a5, (a2)\n` +
      `  addi a5, a5, 1\n` +
      `  sw a5, (a2)\n` +
      `  sw zero, (a1)\n` +
      `  addi a3, a3, -1\n` +
      `  bnez a3, outer\n` +
      EXIT,
    { base: SMP_RAM_BASE },
  );
}

/** Each hart publishes its `mhartid`, proving per-hart architectural state. */
export function hartIdProgram(): Assembled {
  return assemble(`  csrr a0, mhartid\n` + `  li a1, ${SMP_DATA.out}\n` + `  sw a0, (a1)\n` + EXIT, {
    base: SMP_RAM_BASE,
  });
}
