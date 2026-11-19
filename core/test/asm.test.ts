/**
 * Assembler tests.
 *
 * The assembler is load-bearing infrastructure: it writes every test kernel, it
 * is the fuzzer's instruction generator, and it produces the ELF images the QEMU
 * baseline consumes. Two of these tests are regression tests for bugs the JIT
 * work found (funct3 == 0 mnemonics being dropped by a truthiness check, and the
 * `lui` immediate convention disagreeing with GNU as).
 */

import { describe, expect, it } from 'vitest';
import { AsmError, CSR_ALIASES, assemble } from '../src/cpu/asm.ts';
import { decode, disasm, immU, opcode, OP_LUI, OP_LOAD, OP_STORE, OP_SYSTEM, funct3 } from '../src/cpu/encoding.ts';
import { RAM_BASE, runInterpreted, EXIT } from './helpers.ts';

/** Assemble one line and return the first word. */
function word(src: string, base = 0): number {
  const a = assemble(src, { base });
  return new DataView(a.bytes.buffer, a.bytes.byteOffset).getUint32(0, true);
}

function words(src: string, base = 0): number[] {
  const a = assemble(src, { base });
  const dv = new DataView(a.bytes.buffer, a.bytes.byteOffset, a.bytes.byteLength);
  return Array.from({ length: a.bytes.length / 4 }, (_, i) => dv.getUint32(i * 4, true));
}

describe('encodings', () => {
  it('encodes R-type with the right funct fields', () => {
    expect(word('add  x1, x2, x3')).toBe(0x003100b3);
    expect(word('sub  x1, x2, x3')).toBe(0x403100b3);
    expect(word('mul  x1, x2, x3')).toBe(0x023100b3);
    expect(word('divu x1, x2, x3')).toBe(0x023150b3);
    expect(word('sll  x1, x2, x3')).toBe(0x003110b3);
    expect(word('slt  x1, x2, x3')).toBe(0x003120b3);
    expect(word('xor  x1, x2, x3')).toBe(0x003140b3);
  });

  it('accepts ABI register names and numeric names interchangeably', () => {
    expect(word('add ra, sp, gp')).toBe(word('add x1, x2, x3'));
    expect(word('add t0, t1, t2')).toBe(word('add x5, x6, x7'));
    expect(word('add a0, a1, s11')).toBe(word('add x10, x11, x27'));
  });

  it('encodes I-type immediates as signed 12-bit', () => {
    expect(decode(word('addi x1, x2, 1'), 0).imm).toBe(1);
    expect(decode(word('addi x1, x2, -1'), 0).imm).toBe(-1);
    expect(decode(word('addi x1, x2, 2047'), 0).imm).toBe(2047);
    expect(decode(word('addi x1, x2, -2048'), 0).imm).toBe(-2048);
    expect(() => word('addi x1, x2, 2048')).toThrow(/out of range/);
  });

  it('encodes loads and stores with every funct3, including zero', () => {
    // Regression: lb/sb have funct3 == 0 and were once dropped by a truthiness
    // test, which made them "unknown instruction".
    for (const [mnem, f3] of [['lb', 0], ['lh', 1], ['lw', 2], ['lbu', 4], ['lhu', 5]] as const) {
      const w = word(`${mnem} x1, 8(x2)`);
      expect(opcode(w)).toBe(OP_LOAD);
      expect(funct3(w)).toBe(f3);
      expect(decode(w, 0).imm).toBe(8);
    }
    for (const [mnem, f3] of [['sb', 0], ['sh', 1], ['sw', 2]] as const) {
      const w = word(`${mnem} x1, -4(x2)`);
      expect(opcode(w)).toBe(OP_STORE);
      expect(funct3(w)).toBe(f3);
      expect(decode(w, 0).imm).toBe(-4);
    }
  });

  it('encodes branches and jumps with the right targets', () => {
    const a = assemble('start:\n  beq x1, x2, start\n  jal x1, start\n', { base: 0x100 });
    const w = words('start:\n  beq x1, x2, start\n  jal x1, start\n', 0x100);
    expect(decode(w[0]!, 0x100).target).toBe(0x100);
    expect(decode(w[1]!, 0x104).target).toBe(0x100);
    expect(a.size).toBe(8);
  });

  it('encodes forward references across many instructions', () => {
    const src = 'start:\n  jal ra, end\n' + '  addi x1, x1, 1\n'.repeat(50) + 'end:\n  ret\n';
    const a = assemble(src, { base: RAM_BASE });
    const first = new DataView(a.bytes.buffer).getUint32(0, true);
    expect(decode(first, RAM_BASE).target).toBe(a.labels.get('end'));
  });

  it('encodes lui/auipc with the GNU as convention (operand is the 20-bit field)', () => {
    const w = word('lui x1, 0xdeadb');
    expect(opcode(w)).toBe(OP_LUI);
    expect(immU(w) >>> 0).toBe(0xdeadb000);
    expect(decode(w, 0).imm >>> 0).toBe(0xdeadb000);
    // A value that only makes sense as already-shifted must be rejected loudly
    // rather than silently masked to something else.
    expect(() => word('lui x1, 0xdeadb000')).toThrow(/out of range/);
  });

  it('encodes AMO instructions with aq/rl bits', () => {
    const plain = word('amoadd.w x1, x2, (x3)');
    const aq = word('amoadd.w.aq x1, x2, (x3)');
    const rl = word('amoadd.w.rl x1, x2, (x3)');
    const both = word('amoadd.w.aqrl x1, x2, (x3)');
    expect((aq >>> 26) & 1).toBe(1);
    expect((rl >>> 25) & 1).toBe(1);
    expect((both >>> 25) & 3).toBe(3);
    expect((plain >>> 25) & 3).toBe(0);
    expect(decode(both, 0).mnemonic).toBe('amoadd.w');
  });

  it('encodes every AMO mnemonic to a distinct funct5', () => {
    const seen = new Map<number, string>();
    for (const m of ['lr.w', 'sc.w', 'amoswap.w', 'amoadd.w', 'amoxor.w', 'amoor.w', 'amoand.w', 'amomin.w', 'amomax.w', 'amominu.w', 'amomaxu.w']) {
      const src = m === 'lr.w' ? `${m} x1, (x3)` : `${m} x1, x2, (x3)`;
      const f5 = (word(src) >>> 27) & 0x1f;
      expect(seen.has(f5), `${m} collides with ${seen.get(f5)}`).toBe(false);
      seen.set(f5, m);
      expect(decode(word(src), 0).mnemonic).toBe(m);
    }
    expect(seen.size).toBe(11);
  });

  it('encodes CSR instructions with unsigned 12-bit addresses', () => {
    // Regression: 0xb02 (minstret) and 0xf14 (mhartid) are > 2047 and used to be
    // rejected by the signed I-type range check.
    for (const [name, addr] of Object.entries(CSR_ALIASES)) {
      const w = word(`csrrs x1, ${name}, x0`);
      expect((w >>> 20) & 0xfff, name).toBe(addr);
      expect(opcode(w)).toBe(OP_SYSTEM);
    }
    expect((word('csrrwi x1, mscratch, 5') >>> 15) & 0x1f).toBe(5);
    expect((word('ecall') >>> 20) & 0xfff).toBe(0);
    expect((word('ebreak') >>> 20) & 0xfff).toBe(0x1);
    expect((word('mret') >>> 20) & 0xfff).toBe(0x302);
    expect((word('wfi') >>> 20) & 0xfff).toBe(0x105);
  });
});

describe('pseudo instructions', () => {
  it('li expands to one or two instructions depending on the value', () => {
    expect(words('li x1, 5')).toHaveLength(1);
    expect(words('li x1, -5')).toHaveLength(1);
    expect(words('li x1, 2047')).toHaveLength(1);
    expect(words('li x1, 2048')).toHaveLength(2);
    expect(words('li x1, 0xdeadbeef')).toHaveLength(2);
  });

  it('li materialises the exact value for a sweep of magnitudes', () => {
    const values = [0, 1, -1, 2047, -2048, 2048, -2049, 0xffff, 0x10000, 0x7fffffff, -2147483648, 0xdeadbeef | 0, 123456789];
    for (const v of values) {
      const r = runInterpreted(`  li t0, ${v}\n${EXIT}`);
      expect(r.reg(5), `li ${v}`).toBe(v | 0);
    }
  });

  it('la loads an absolute address and lla a pc-relative one', () => {
    const r = runInterpreted(`
      la   t0, target
      la   t1, target
      lla  t2, target
      j    fin
    target:
      nop
    fin:
    ${EXIT}`, { base: RAM_BASE });
    expect(r.reg(5)).toBe(r.label('target') | 0);
    expect(r.reg(6)).toBe(r.reg(5));
    expect(r.reg(7)).toBe(r.label('target') | 0);
  });

  it('nop, mv, not, neg, seqz, snez, sltz, sgtz expand correctly', () => {
    const r = runInterpreted(`
      li   t0, 5
      nop
      mv   t1, t0
      not  t2, t0
      neg  t3, t0
      seqz t4, t0
      snez t5, t0
      sltz t6, t0
      sgtz s1, t0
      li   s2, -3
      sltz s3, s2
      sgtz s4, s2
    ${EXIT}`);
    expect(r.reg(6)).toBe(5);
    expect(r.reg(7)).toBe(~5);
    expect(r.reg(28)).toBe(-5);
    expect(r.reg(29)).toBe(0);
    expect(r.reg(30)).toBe(1);
    expect(r.reg(31)).toBe(0);
    expect(r.reg(9)).toBe(1);
    expect(r.reg(19)).toBe(1); // sltz of -3
    expect(r.reg(20)).toBe(0); // sgtz of -3
  });

  it('branch pseudo-ops compare against zero', () => {
    const r = runInterpreted(`
      li   a0, 0
      li   t0, 3
      beqz t0, skip1
      addi a0, a0, 1
    skip1:
      bnez t0, skip2
      addi a0, a0, 10
    skip2:
      li   t1, -2
      bltz t1, skip3
      addi a0, a0, 10
      j    fin
    skip3:
      addi a0, a0, 20
    fin:
      bgtz t1, skip4
      addi a0, a0, 1
      j    end
    skip4:
      addi a0, a0, 2
    end:
    ${EXIT}`);
    // beqz not taken (+1), bnez taken (+0), bltz taken (+20), bgtz not taken (+1)
    expect(r.reg(10)).toBe(22);
  });

  it('j, jr, ret, call and tail assemble', () => {
    for (const src of ['j  label\nlabel:\n', 'jr t0\n', 'ret\n', 'call label\nlabel:\n', 'tail label\nlabel:\n']) {
      expect(assemble(src).size % 4).toBe(0);
    }
  });
});

describe('labels, data and directives', () => {
  it('resolves labels to byte addresses and exposes them', () => {
    const a = assemble('_start:\n  nop\nmid:\n  nop\nend:\n  nop\n', { base: 0x1000 });
    expect(a.labels.get('_start')).toBe(0x1000);
    expect(a.labels.get('mid')).toBe(0x1004);
    expect(a.labels.get('end')).toBe(0x1008);
    expect(a.entry).toBe(0x1000);
    expect(a.size).toBe(12);
  });

  it('entry defaults to _start when present, otherwise base', () => {
    expect(assemble('_start:\n nop\n').entry).toBe(0);
    expect(assemble('other:\n nop\n').entry).toBe(0);
    expect(assemble('other:\n nop\n', { base: 0x800 }).entry).toBe(0x800);
    expect(assemble('_start:\n nop\n', { entry: 'other', base: 0 }).entry).toBe(0);
  });

  it('emits data directives with correct sizes and alignment', () => {
    const a = assemble('  .byte 1, 2, 3\n  .align 2\n  .half 0x1234\n  .word 0xdeadbeef\n  .string "hi"\n  .zero 3\n', { base: 0 });
    expect(Array.from(a.bytes.slice(0, 4))).toEqual([1, 2, 3, 0]); // .align 2 padded to 4
    const dv = new DataView(a.bytes.buffer);
    expect(dv.getUint16(4, true)).toBe(0x1234);
    // .word does not imply alignment (matching GNU as), so it lands at offset 6.
    expect(dv.getUint32(6, true) >>> 0).toBe(0xdeadbeef);
    expect(Array.from(a.bytes.slice(10, 13))).toEqual(['h'.charCodeAt(0), 'i'.charCodeAt(0), 0]);
    expect(Array.from(a.bytes.slice(13, 16))).toEqual([0, 0, 0]); // .zero 3
    expect(a.size).toBe(16);
  });

  it('aligns with the power-of-two convention on .align and bytes on .balign', () => {
    expect(assemble('  .byte 1\n  .align 2\n  .byte 2\n').size).toBe(5);
    expect(assemble('  .byte 1\n  .balign 4\n  .byte 2\n').size).toBe(5);
    expect(assemble('  .byte 1\n  .p2align 3\n  .byte 2\n').size).toBe(9);
  });

  it('supports .set/.equ and predefined symbols', () => {
    const src = '  .set LIMIT, 42\n  .equ LIMIT2, 7\n  li t0, LIMIT\n  li t1, LIMIT2\n  la t2, HEAP\n';
    const a = assemble(src, { defines: { HEAP: 0x1000 } });
    expect(a.bytes.length).toBeGreaterThan(0);
    const r = runInterpreted(src + EXIT, { defines: { HEAP: 0x1000 } });
    expect(r.reg(5)).toBe(42);
    expect(r.reg(6)).toBe(7);
    expect(r.reg(7)).toBe(0x1000);
  });

  it('ignores .text/.globl/.type/.ident and other assembler-only directives', () => {
    const src = `  .text
  .globl _start
  .type _start, @function
  .file "t.s"
  .ident "wasmnux"
  .option norvc
  .attribute arch, "rv32ima"
_start:
  nop
  .size _start, .-_start
`;
    expect(assemble(src).size).toBe(4);
  });

  it('strips comments in both syntaxes and handles blank lines', () => {
    const a = assemble('# hash comment\n// slash comment\n  nop  # trailing\n\n  nop // trailing2\n');
    expect(a.size).toBe(8);
  });

  it('evaluates constant expressions', () => {
    const r = runInterpreted(`  li t0, 2 + 3 * 4\n  li t1, (1 << 8) | 3\n  li t2, 100 / 7\n  li t3, 100 % 7\n  li t4, -1 >> 1\n${EXIT}`);
    expect(r.reg(5)).toBe(14);
    expect(r.reg(6)).toBe(0x103);
    expect(r.reg(7)).toBe(14);
    expect(r.reg(28)).toBe(2);
    expect(r.reg(29)).toBe(-1);
  });

  it('produces a line map for diagnostics', () => {
    const a = assemble('  nop\n  nop\n  nop\n');
    expect(a.lineMap.length).toBe(3);
    expect(a.lineMap.map((m) => m.addr)).toEqual([0, 4, 8]);
  });
});

describe('errors', () => {
  const bad: Array<[string, RegExp]> = [
    ['  bogusop x1, x2\n', /unknown instruction/],
    ['  add x1, x2\n', /expects 3 operand/],
    ['  add x1, x99, x2\n', /unknown register/],
    ['  li x1, missing_symbol\n', /undefined symbol/],
    ['  j nowhere\n', /undefined/],
    ['lbl:\nlbl:\n', /duplicate label/],
    ['  csrrs x1, notacsr, x0\n', /bad CSR/],
    ['  .align\n', /cannot evaluate/],
  ];
  for (const [src, re] of bad) {
    it(`rejects ${JSON.stringify(src.trim())}`, () => {
      expect(() => assemble(src)).toThrow(re);
    });
  }

  it('reports the line number of the offending instruction', () => {
    try {
      assemble('  nop\n  nop\n  bogus x1\n');
      throw new Error('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(AsmError);
      expect((e as AsmError).line).toBe(3);
      expect((e as Error).message).toMatch(/line 3/);
    }
  });

  it('rejects a branch that is out of range', () => {
    const far = 'start:\n' + '  nop\n'.repeat(2000) + '  beq x1, x2, start\n';
    expect(() => assemble(far)).toThrow(/range/);
  });

  it('rejects a shift amount above 31', () => {
    expect(() => word('slli x1, x2, 32')).toThrow(/shift amount/);
  });
});

describe('disassembly', () => {
  it('round-trips a program through disasm and decode', () => {
    const src = '  addi x1, x2, 3\n  lw x4, 8(x5)\n  sw x6, -4(x7)\n  beq x1, x2, .\n  amoadd.w x1, x2, (x3)\n';
    for (const w of words(src)) {
      const d = decode(w, 0);
      expect(d.illegal, disasm(w)).toBe(false);
      expect(disasm(w)).toContain(d.mnemonic);
      // Re-assembling the disassembly must produce the same word.
      const again = word(disasm(w).replace(/^0x[0-9a-f]+\s+/, '') + '\n');
      expect(again >>> 0).toBe(w >>> 0);
    }
  });

  it('marks unknown encodings illegal', () => {
    expect(decode(0xffffffff, 0).illegal).toBe(true);
    expect(decode(0x00000000, 0).illegal).toBe(true);
    expect(disasm(0xffffffff)).toMatch(/illegal/);
  });
});
