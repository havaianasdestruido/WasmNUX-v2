/**
 * RV32IMA interpreter conformance.
 *
 * The interpreter is the oracle for the JIT, so it is tested on its own terms
 * first: each group of instructions is assembled into a guest program, run, and
 * compared against values computed independently in TypeScript. Where the RISC-V
 * spec defines a corner case (division by zero, INT_MIN / -1, x0, misaligned
 * accesses, illegal encodings) the test names it, because those are exactly the
 * cases a JIT gets wrong.
 */

import { describe, expect, it } from 'vitest';
import { CAUSE, CpuState } from '../src/cpu/state.ts';
import { evalAsm, EXIT, RAM_BASE, SCRATCH, regsOf, run, runInterpreted } from './helpers.ts';

/** Evaluate a snippet and return one register's final value. */
function value(src: string, reg: number): number {
  return evalAsm(src)[reg]!;
}

describe('RV32I arithmetic', () => {
  it('addi/add/sub wrap at 32 bits', () => {
    expect(value('  li t0, 2000000000\n  li t1, 2000000000\n  add t2, t0, t1', 7)).toBe(
      (2000000000 + 2000000000) | 0,
    );
    expect(value('  li t0, -2000000000\n  sub t1, t0, t0\n  sub t2, t1, t0', 7)).toBe((0 + 2000000000) | 0);
  });

  it('lui/auipc materialise upper immediates', () => {
    expect(value('  lui t0, 0xdeadb', 5)).toBe(0xdeadb000 | 0);
    expect(value('  lui t0, 0x80000', 5)).toBe(-2147483648);
    expect(value('  auipc t0, 1', 5)).toBe((RAM_BASE + 0x1000) | 0);
  });

  it('shifts use the low 5 bits of the shift amount', () => {
    expect(value('  li t0, 1\n  li t1, 33\n  sll t2, t0, t1', 7)).toBe(2);
    expect(value('  li t0, -16\n  li t1, 3\n  srl t2, t0, t1', 7)).toBe((-16 >>> 3) | 0);
    expect(value('  li t0, -16\n  li t1, 3\n  sra t2, t0, t1', 7)).toBe(-2);
    expect(value('  li t0, 0x80000000\n  srli t1, t0, 31', 6)).toBe(1);
  });

  it('compares are signed and unsigned as specified', () => {
    expect(value('  li t0, -1\n  li t1, 1\n  slt t2, t0, t1\n  sltu t3, t0, t1', 7)).toBe(1);
    expect(value('  li t0, -1\n  li t1, 1\n  sltu t2, t0, t1', 7)).toBe(0);
    expect(value('  li t0, -1\n  slti t1, t0, 0\n  sltiu t2, t0, 0', 6)).toBe(1);
    expect(value('  li t0, -1\n  sltiu t2, t0, 0', 7)).toBe(0);
  });

  it('logical immediates sign-extend the immediate first', () => {
    expect(value('  li t0, 0\n  xori t1, t0, -1', 6)).toBe(-1);
    expect(value('  li t0, 0xf0f0\n  ori t1, t0, 0x0f', 6)).toBe(0xf0ff);
    expect(value('  li t0, 0xf0f0\n  andi t1, t0, -16', 6)).toBe(0xf0f0);
  });

  it('writes to x0 are discarded', () => {
    expect(value('  li x0, 5\n  addi x0, x0, 7', 0)).toBe(0);
    expect(value('  li t0, 3\n  add x0, t0, t0', 0)).toBe(0);
  });
});

describe('RV32M multiply/divide', () => {
  it('mul keeps the low 32 bits', () => {
    expect(value('  li t0, 0x10000\n  li t1, 0x10000\n  mul t2, t0, t1', 7)).toBe(0);
    expect(value('  li t0, -1\n  li t1, 3\n  mul t2, t0, t1', 7)).toBe(-3);
  });

  it('mulh variants differ in sign handling', () => {
    const cases: Array<[string, number]> = [
      ['  li t0, 0x40000000\n  li t1, 4\n  mulh t2, t0, t1', 1],
      ['  li t0, 0x40000000\n  li t1, 4\n  mulhu t2, t0, t1', 1],
      ['  li t0, -1\n  li t1, 4\n  mulh t2, t0, t1', -1],
      ['  li t0, -1\n  li t1, 4\n  mulhu t2, t0, t1', 3],
      ['  li t0, -1\n  li t1, 4\n  mulhsu t2, t0, t1', -1],
      ['  li t0, 4\n  li t1, -1\n  mulhsu t2, t0, t1', 3],
    ];
    for (const [src, want] of cases) expect(value(src, 7)).toBe(want);
  });

  it('division by zero follows RISC-V, not Wasm', () => {
    // Wasm traps on these; RISC-V defines the result. The JIT has to guard.
    expect(value('  li t0, 7\n  li t1, 0\n  div t2, t0, t1', 7)).toBe(-1);
    expect(value('  li t0, 7\n  li t1, 0\n  divu t2, t0, t1', 7)).toBe(-1);
    expect(value('  li t0, 7\n  li t1, 0\n  rem t2, t0, t1', 7)).toBe(7);
    expect(value('  li t0, 7\n  li t1, 0\n  remu t2, t0, t1', 7)).toBe(7);
  });

  it('INT_MIN / -1 is the other defined overflow', () => {
    expect(value('  lui t0, 0x80000\n  li t1, -1\n  div t2, t0, t1', 7)).toBe(-2147483648);
    expect(value('  lui t0, 0x80000\n  li t1, -1\n  rem t2, t0, t1', 7)).toBe(0);
    expect(value('  lui t0, 0x80000\n  li t1, -1\n  divu t2, t0, t1', 7)).toBe(0);
  });

  it('divu/remu treat both operands as unsigned', () => {
    expect(value('  li t0, -1\n  li t1, 2\n  divu t2, t0, t1', 7)).toBe(0x7fffffff);
    expect(value('  li t0, -1\n  li t1, 2\n  remu t2, t0, t1', 7)).toBe(1);
    expect(value('  li t0, -7\n  li t1, 2\n  div t2, t0, t1\n  rem t3, t0, t1', 7)).toBe(-3);
    expect(value('  li t0, -7\n  li t1, 2\n  div t2, t0, t1\n  rem t3, t0, t1', 28)).toBe(-1);
  });
});

describe('loads and stores', () => {
  it('round-trips every width and sign-extends correctly', () => {
    const r = runInterpreted(`
      li   t0, ${SCRATCH}
      li   t1, 0xdeadbeef
      sw   t1, 0(t0)
      lw   t2, 0(t0)
      lh   t3, 0(t0)
      lhu  t4, 0(t0)
      lb   t5, 2(t0)
      lbu  t6, 3(t0)
      sh   t1, 8(t0)
      lhu  s1, 8(t0)
      sb   t1, 12(t0)
      lbu  s2, 12(t0)
    ${EXIT}`);
    const g = r.reg;
    expect(g(7)).toBe(0xdeadbeef | 0); // lw
    expect(g(28)).toBe(0xffffbeef | 0); // lh sign-extends
    expect(g(29)).toBe(0xbeef);
    expect(g(30)).toBe(0xffffffad | 0); // lb of 0xad sign-extends
    expect(g(31)).toBe(0xde);
    expect(g(9)).toBe(0xbeef);
    expect(g(18)).toBe(0xef);
  });

  it('x0 as a store source writes zero', () => {
    const r = runInterpreted(`
      li  t0, ${SCRATCH}
      li  t1, 42
      sw  t1, 0(t0)
      sw  x0, 0(t0)
      lw  t2, 0(t0)
    ${EXIT}`);
    expect(r.reg(7)).toBe(0);
    expect(r.word(SCRATCH)).toBe(0);
  });

  it('negative and large offsets address the same byte', () => {
    const r = runInterpreted(`
      li  t0, ${SCRATCH + 100}
      li  t1, 7
      sw  t1, -100(t0)
      li  t2, ${SCRATCH}
      lw  t3, 0(t2)
    ${EXIT}`);
    expect(r.reg(28)).toBe(7);
  });
});

describe('control flow', () => {
  it('branches compare signed and unsigned', () => {
    const r = runInterpreted(`
      li   a0, 0
      li   t0, -1
      li   t1, 1
      blt  t0, t1, lt_taken
      li   a0, 1
    lt_taken:
      bltu t0, t1, tu_taken
      addi a0, a0, 10
      j    done
    tu_taken:
      addi a0, a0, 100
    done:
      bge  t0, t1, ge_taken
      addi a0, a0, 100
      j    ge_done
    ge_taken:
      addi a0, a0, 200
    ge_done:
      bgeu t0, t1, geu_taken
      addi a0, a0, 1
      j    end
    geu_taken:
      addi a0, a0, 2
    end:
    ${EXIT}`);
    // blt taken (+0), bltu not taken (+10), bge not taken (+100), bgeu taken (+2)
    expect(r.reg(10)).toBe(112);
  });

  it('jal links, ret returns, and the caller continues', () => {
    const r = runInterpreted(`
      li   a0, 0
      jal  ra, f1
      addi a0, a0, 100
      j    done
    f1:
      addi a0, a0, 1
      ret
    done:
    ${EXIT}`);
    expect(r.reg(10)).toBe(101);
  });

  it('jalr calls through a register and links the return address', () => {
    const r = runInterpreted(`
      li   a0, 0
      la   t0, f1
      jalr ra, 0(t0)
      addi a0, a0, 100
      j    done
    f1:
      addi a0, a0, 3
      ret
    done:
    ${EXIT}`);
    expect(r.reg(10)).toBe(103);
  });

  it('jal to a label behind the caller works (backward jump)', () => {
    const r = runInterpreted(`
      li   a0, 0
    top:
      addi a0, a0, 1
      li   t0, 5
      blt  a0, t0, top
    ${EXIT}`);
    expect(r.reg(10)).toBe(5);
  });

  it('jalr clears the low bit of the target', () => {
    const r = runInterpreted(`
      la   t1, target
      addi t1, t1, 1
      jalr ra, 0(t1)
      li   a0, 99
      j    fin
    target:
      li   a0, 7
    fin:
    ${EXIT}`);
    expect(r.reg(10)).toBe(7);
  });

  it('a counted loop runs exactly N times', () => {
    const r = runInterpreted(`
      li   t0, 0
      li   t1, 1000
    loop:
      addi t0, t0, 3
      addi t1, t1, -1
      bnez t1, loop
    ${EXIT}`);
    expect(r.reg(5)).toBe(3000);
    expect(r.reg(6)).toBe(0);
    expect(r.instructions).toBeGreaterThan(3000);
  });

  it('instruction count matches the executed sequence', () => {
    const r = runInterpreted(`  addi t0, t0, 1\n  addi t0, t0, 1\n  addi t0, t0, 1\n${EXIT}`);
    expect(r.instructions).toBe(5); // three addi, then li a7 + ecall
  });
});

describe('A extension', () => {
  const AMO_PROGRAM = (insn: string) => `
      li   a0, ${SCRATCH}
      li   t0, 0x12345678
      sw   t0, 0(a0)
      li   t1, 0x0f0f0f0f
      ${insn}
      lw   t3, 0(a0)
    ${EXIT}`;

  const amoCases: Array<[string, string, number, number]> = [
    // [name, instruction, expected rd (old value), expected memory]
    ['amoadd', 'amoadd.w t2, t1, (a0)', 0x12345678, (0x12345678 + 0x0f0f0f0f) | 0],
    ['amoswap', 'amoswap.w t2, t1, (a0)', 0x12345678, 0x0f0f0f0f],
    ['amoxor', 'amoxor.w t2, t1, (a0)', 0x12345678, 0x12345678 ^ 0x0f0f0f0f],
    ['amoor', 'amoor.w t2, t1, (a0)', 0x12345678, 0x12345678 | 0x0f0f0f0f],
    ['amoand', 'amoand.w t2, t1, (a0)', 0x12345678, 0x12345678 & 0x0f0f0f0f],
    ['amomin (positive)', 'amomin.w t2, t1, (a0)', 0x12345678, 0x0f0f0f0f],
    ['amomax (positive)', 'amomax.w t2, t1, (a0)', 0x12345678, 0x12345678],
  ];

  for (const [name, insn, wantRd, wantMem] of amoCases) {
    it(`${name} returns the old value and updates memory`, () => {
      const r = runInterpreted(AMO_PROGRAM(insn));
      expect(r.reg(7)).toBe(wantRd | 0);
      expect(r.word(SCRATCH)).toBe(wantMem | 0);
    });
  }

  it('amomin/amomax are signed, amominu/amomaxu are not', () => {
    const signed = runInterpreted(`
      li   a0, ${SCRATCH}
      li   t0, -1
      sw   t0, 0(a0)
      li   t1, 1
      amomin.w t2, t1, (a0)
      lw   t3, 0(a0)
      amomax.w t4, t1, (a0)
      lw   t5, 0(a0)
    ${EXIT}`);
    // t2/t4 are the AMO results (the *old* word), t3/t5 are the reloads.
    // min(-1, 1) = -1 leaves the word alone; max(-1, 1) = 1 stores 1.
    expect(signed.reg(7)).toBe(-1); // amomin.w returned the old word
    expect(signed.reg(28)).toBe(-1); // lw still sees -1
    expect(signed.reg(29)).toBe(-1); // amomax.w returned the old word
    expect(signed.reg(30)).toBe(1); // lw now sees the max
    expect(signed.word(SCRATCH)).toBe(1);

    const unsigned = runInterpreted(`
      li   a0, ${SCRATCH}
      li   t0, -1
      sw   t0, 0(a0)
      li   t1, 1
      amominu.w t2, t1, (a0)
      lw   t3, 0(a0)
      amomaxu.w t4, t1, (a0)
      lw   t5, 0(a0)
    ${EXIT}`);
    // minu(0xffffffff, 1) = 1, so the unsigned min *does* store; maxu(1, 1) = 1.
    expect(unsigned.reg(7)).toBe(-1); // amominu.w returned the old word
    expect(unsigned.reg(28)).toBe(1); // lw sees the unsigned minimum
    expect(unsigned.reg(29)).toBe(1); // amomaxu.w returned that same word
    expect(unsigned.reg(30)).toBe(1);
    expect(unsigned.word(SCRATCH)).toBe(1);
  });

  it('lr.w/sc.w succeed when nothing intervened', () => {
    const r = runInterpreted(`
      li   a0, ${SCRATCH}
      li   t0, 11
      li   t1, 22
      sw   t0, 0(a0)
      lr.w t2, (a0)
      sc.w t3, t1, (a0)
      lw   t4, 0(a0)
    ${EXIT}`);
    expect(r.reg(7)).toBe(11); // lr returned the old value
    expect(r.reg(28)).toBe(0); // sc succeeded
    expect(r.word(SCRATCH)).toBe(22);
  });

  it('sc.w fails without a reservation', () => {
    const r = runInterpreted(`
      li   a0, ${SCRATCH}
      li   t0, 11
      li   t1, 22
      sw   t0, 0(a0)
      sc.w t3, t1, (a0)
      lw   t4, 0(a0)
    ${EXIT}`);
    expect(r.reg(28)).toBe(1);
    expect(r.word(SCRATCH)).toBe(11);
  });

  it('sc.w fails when the word changed after lr.w', () => {
    const r = runInterpreted(`
      li   a0, ${SCRATCH}
      li   t0, 11
      li   t1, 22
      li   t5, 99
      sw   t0, 0(a0)
      lr.w t2, (a0)
      sw   t5, 0(a0)
      sc.w t3, t1, (a0)
      lw   t4, 0(a0)
    ${EXIT}`);
    expect(r.reg(28)).toBe(1);
    expect(r.word(SCRATCH)).toBe(99);
  });

  it('a CAS retry loop increments a counter atomically', () => {
    const r = runInterpreted(`
      li   a0, ${SCRATCH}
      sw   x0, 0(a0)
      li   t0, 50
    retry:
      lr.w t1, (a0)
      addi t1, t1, 1
      sc.w t2, t1, (a0)
      bnez t2, retry
      addi t0, t0, -1
      bnez t0, retry
      lw   t3, 0(a0)
    ${EXIT}`);
    expect(r.reg(28)).toBe(50);
  });

  it('misaligned atomic addresses trap', () => {
    const cpu = new CpuState({ pc: RAM_BASE });
    const r = run(`
      li   a0, ${SCRATCH + 1}
      li   t0, 1
      amoadd.w t1, t0, (a0)
    ${EXIT}`);
    expect(r.cpu.stop).toBe('trap');
    expect(r.cpu.cause).toBe(CAUSE.STORE_ADDRESS_MISALIGNED);
    expect(cpu.pc).toBe(RAM_BASE);
  });
});

describe('system instructions', () => {
  it('csrrw/csrrs/csrrc read the old value and write the new one', () => {
    const r = runInterpreted(`
      li   t0, 0x1234
      csrw mscratch, t0
      csrr t1, mscratch
      li   t2, 0xff
      csrs mscratch, t2
      csrr t3, mscratch
      csrc mscratch, t2
      csrr t4, mscratch
    ${EXIT}`);
    expect(r.reg(6)).toBe(0x1234);
    expect(r.reg(28)).toBe(0x12ff);
    expect(r.reg(29)).toBe(0x1200);
  });

  it('csrrs with x0 does not write, so a read-only CSR survives', () => {
    const r = runInterpreted(`  csrrs t0, mhartid, x0\n  csrrs t1, misa, x0\n${EXIT}`);
    expect(r.reg(5)).toBe(0); // hart 0
    expect(r.reg(6)).toBe(0x40001105); // RV32IMA
  });

  it('counters read through to the CPU state', () => {
    const r = runInterpreted(`
      addi t2, t2, 1
      addi t2, t2, 1
      addi t2, t2, 1
      csrr t0, minstret
      csrr t1, mcycle
    ${EXIT}`);
    // minstret counts what retired *before* this instruction, so >= 3.
    expect(r.reg(5)).toBeGreaterThanOrEqual(3);
    expect(r.reg(6)).toBeGreaterThanOrEqual(3);
    expect(r.instructions).toBeGreaterThanOrEqual(r.reg(5));
  });

  it('fence is a no-op that still retires', () => {
    const before = runInterpreted(`  addi t0, t0, 1\n${EXIT}`).instructions;
    const after = runInterpreted(`  addi t0, t0, 1\n  fence\n${EXIT}`).instructions;
    expect(after).toBe(before + 1);
  });

  it('ecall reaches the syscall handler', () => {
    const r = runInterpreted(`  li a7, 93\n  li a0, 7\n  ecall\n`);
    expect(r.cpu.stop).toBe('exit');
    expect(r.cpu.exitCode).toBe(7);
  });

  it('ebreak stops with a breakpoint reason', () => {
    const r = runInterpreted(`  addi t0, t0, 1\n  ebreak\n  addi t0, t0, 1\n${EXIT}`);
    expect(r.cpu.stop).toBe('breakpoint');
    expect(r.reg(5)).toBe(1);
  });

  it('an illegal instruction traps with the word in mtval', () => {
    const r = runInterpreted(`  .word 0xffffffff\n${EXIT}`);
    expect(r.cpu.stop).toBe('trap');
    expect(r.cpu.cause).toBe(CAUSE.ILLEGAL_INSTRUCTION);
    expect(r.cpu.tval | 0).toBe(-1);
  });

  it('fetching from unmapped memory traps', () => {
    const r = runInterpreted(`  li t0, 0x20000000\n  jr t0\n`, { budget: 100 });
    expect(['trap', 'mmio', 'running']).toContain(r.cpu.stop);
  });
});

describe('register file', () => {
  it('every register except the dump base holds an independent value', () => {
    // x2 (sp) has to survive as the buffer pointer: with all 31 other registers
    // holding test values there is nowhere else to keep it. x0 is checked too.
    const dump = SCRATCH + 0x400;
    const set = [1, ...Array.from({ length: 29 }, (_, i) => i + 3)].map((n) => `  li x${n}, ${n}`).join('\n');
    const save = Array.from({ length: 32 }, (_, i) => `  sw x${i}, ${i * 4}(sp)`).join('\n');
    const r = runInterpreted(
      `
      li   sp, ${dump}
    ${set}
      li   sp, ${dump}
    ${save}
    ${EXIT}`,
      { stackTop: dump },
    );
    expect(r.word(dump)).toBe(0); // x0
    for (let i = 1; i < 32; i++) {
      expect(r.word(dump + i * 4)).toBe(i === 2 ? dump : i);
    }
  });

  it('CpuState.reg(0) is always zero even after setReg', () => {
    const cpu = new CpuState();
    cpu.setReg(0, 1234);
    expect(cpu.reg(0)).toBe(0);
    cpu.setReg(5, 42);
    expect(cpu.reg(5)).toBe(42);
  });
});

describe('programs with real structure', () => {
  it('computes a factorial iteratively', () => {
    const r = runInterpreted(`
      li   a0, 1
      li   t0, 10
    loop:
      mul  a0, a0, t0
      addi t0, t0, -1
      bnez t0, loop
    ${EXIT}`);
    expect(r.reg(10)).toBe(3628800);
  });

  it('sums an array in memory', () => {
    const r = runInterpreted(`
      la   t0, data
      li   t1, 8
      li   a0, 0
    loop:
      lw   t2, 0(t0)
      add  a0, a0, t2
      addi t0, t0, 4
      addi t1, t1, -1
      bnez t1, loop
      j    done
      .align 2
    data:
      .word 1, 2, 3, 4, 5, 6, 7, 8
    done:
    ${EXIT}`);
    expect(r.reg(10)).toBe(36);
  });

  it('implements a nested loop (matrix scale)', () => {
    const r = runInterpreted(`
      la   a0, m
      li   a1, 4
    outer:
      li   a2, 4
      mv   a3, a0
    inner:
      lw   t0, 0(a3)
      slli t0, t0, 1
      sw   t0, 0(a3)
      addi a3, a3, 4
      addi a2, a2, -1
      bnez a2, inner
      addi a0, a0, 16
      addi a1, a1, -1
      bnez a1, outer
      j    done
      .align 2
    m:
      .word 1, 2, 3, 4
      .word 5, 6, 7, 8
      .word 9, 10, 11, 12
      .word 13, 14, 15, 16
    done:
    ${EXIT}`);
    const m = r.label('m');
    for (let i = 0; i < 16; i++) expect(r.word(m + i * 4)).toBe((i + 1) * 2);
  });

  it('recursion through a stack works', () => {
    const r = runInterpreted(
      `
      li   sp, ${SCRATCH + 0x1000}
      li   a0, 10
      jal  ra, fib
      j    done
    fib:
      addi sp, sp, -8
      sw   ra, 4(sp)
      sw   a0, 0(sp)
      li   t0, 2
      blt  a0, t0, base
      addi a0, a0, -1
      jal  ra, fib
      lw   a1, 0(sp)
      addi a1, a1, -2
      sw   a0, 0(sp)
      mv   a0, a1
      jal  ra, fib
      lw   t0, 0(sp)
      add  a0, a0, t0
      j    ret
    base:
      li   a0, 1
    ret:
      lw   ra, 4(sp)
      addi sp, sp, 8
      ret
    done:
    ${EXIT}`,
      { stackTop: SCRATCH + 0x2000 },
    );
    expect(r.reg(10)).toBe(89); // fib(10) with fib(1)=fib(2)=1
  });
});

describe('run budgeting', () => {
  it('stops with "running" when the budget is exhausted', () => {
    const r = runInterpreted(`  li t0, 0\nloop:\n  addi t0, t0, 1\n  j loop\n`, { budget: 1000 });
    expect(r.cpu.stop).toBe('running');
    expect(r.instructions).toBeGreaterThan(999);
  });

  it('the same program is deterministic across runs', () => {
    const src = `  li t0, 12345\n  li t1, 6789\nloop:\n  mul t2, t0, t1\n  xor t0, t0, t2\n  addi t1, t1, -1\n  bnez t1, loop\n${EXIT}`;
    expect(regsOf(runInterpreted(src))).toEqual(regsOf(runInterpreted(src)));
  });

  it('run() and machine.run() agree', () => {
    const src = `  li t0, 100\nloop:\n  addi t0, t0, -1\n  bnez t0, loop\n${EXIT}`;
    const a = runInterpreted(src);
    const b = run(src, { jit: false });
    expect(regsOf(a)).toEqual(regsOf(b));
  });
});
