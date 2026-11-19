/**
 * RV64I (+ RV64M) definitions shared by the assembler, interpreter and JIT.
 * Scope is deliberately limited to the integer subset; the spike kernels
 * (see kernels.ts) stay inside it. FP, atomics and CSRs are out of scope.
 *
 * All registers are modelled as BigInt (64-bit) values.
 */

export const REG = {
  zero: 0, ra: 1, sp: 2, gp: 3, tp: 4,
  t0: 5, t1: 6, t2: 7,
  s0: 8, s1: 9,
  a0: 10, a1: 11, a2: 12, a3: 13, a4: 14, a5: 15, a6: 16, a7: 17,
  s2: 18, s3: 19, s4: 20, s5: 21, s6: 22, s7: 23, s8: 24, s9: 25, s10: 26, s11: 27,
  t3: 28, t4: 29, t5: 30, t6: 31,
} as const;

export const REG_BY_NAME: Record<string, number> = {
  zero: 0, x0: 0, ra: 1, x1: 1, sp: 2, x2: 2, gp: 3, x3: 3, tp: 4, x4: 4,
  t0: 5, x5: 5, t1: 6, x6: 6, t2: 7, x7: 7,
  s0: 8, fp: 8, x8: 8, s1: 9, x9: 9,
  a0: 10, x10: 10, a1: 11, x11: 11, a2: 12, x12: 12, a3: 13, x13: 13,
  a4: 14, x14: 14, a5: 15, x15: 15, a6: 16, x16: 16, a7: 17, x17: 17,
  s2: 18, x18: 18, s3: 19, x19: 19, s4: 20, x20: 20, s5: 21, x21: 21,
  s6: 22, x22: 22, s7: 23, x23: 23, s8: 24, x24: 24, s9: 25, x25: 25,
  s10: 26, x26: 26, s11: 27, x27: 27,
  t3: 28, x28: 28, t4: 29, x29: 29, t5: 30, x30: 30, t6: 31, x31: 31,
};

export const OP = {
  Load: 0b0000011,
  ArithImm: 0b0010011,
  Auipc: 0b0010111,
  Store: 0b0100011,
  ArithReg: 0b0110011,
  Lui: 0b0110111,
  Branch: 0b1100011,
  Jalr: 0b1100111,
  Jal: 0b1101111,
  System: 0b1110011,
} as const;

export const ECALL = 0x00000073; // 0x73 funct3=0 imm=0: treated as "halt" by this spike

/** Encode an unsigned/signed immediate into the low `bits` of an integer. */
export function sext(value: bigint, bits: number): bigint {
  const shift = BigInt(64 - bits);
  return (value << shift) >> shift;
}

export function encR(funct7: number, rs2: number, rs1: number, funct3: number, rd: number, op: number): number {
  return ((funct7 & 0x7f) << 25) | ((rs2 & 0x1f) << 20) | ((rs1 & 0x1f) << 15) |
         ((funct3 & 0x7) << 12) | ((rd & 0x1f) << 7) | (op & 0x7f);
}

export function encI(imm: number, rs1: number, funct3: number, rd: number, op: number): number {
  return (((imm & 0xfff) << 20) >>> 0) | ((rs1 & 0x1f) << 15) |
         ((funct3 & 0x7) << 12) | ((rd & 0x1f) << 7) | (op & 0x7f);
}

export function encS(imm: number, rs2: number, rs1: number, funct3: number, op: number): number {
  const imm11_5 = (imm >> 5) & 0x7f;
  const imm4_0 = imm & 0x1f;
  return (imm11_5 << 25) | ((rs2 & 0x1f) << 20) | ((rs1 & 0x1f) << 15) |
         ((funct3 & 0x7) << 12) | (imm4_0 << 7) | (op & 0x7f);
}

export function encB(imm: number, rs2: number, rs1: number, funct3: number, op: number): number {
  if (imm % 2 !== 0) throw new Error(`branch offset ${imm} not 2-byte aligned`);
  const bit12 = (imm >> 12) & 1;
  const bit11 = (imm >> 11) & 1;
  const bit10_5 = (imm >> 5) & 0x3f;
  const bit4_1 = (imm >> 1) & 0xf;
  return (bit12 << 31) | (bit10_5 << 25) | ((rs2 & 0x1f) << 20) | ((rs1 & 0x1f) << 15) |
         ((funct3 & 0x7) << 12) | (bit4_1 << 8) | (bit11 << 7) | (op & 0x7f);
}

export function encU(imm32: number, rd: number, op: number): number {
  return ((imm32 & 0xfffff000) >>> 0) | ((rd & 0x1f) << 7) | (op & 0x7f);
}

export function encJ(imm: number, rd: number, op: number): number {
  if (imm % 2 !== 0) throw new Error(`jal offset ${imm} not 2-byte aligned`);
  const bit20 = (imm >> 20) & 1;
  const bit19_12 = (imm >> 12) & 0xff;
  const bit11 = (imm >> 11) & 1;
  const bit10_1 = (imm >> 1) & 0x3ff;
  return ((bit20 << 31) | (bit10_1 << 21) | (bit11 << 20) | (bit19_12 << 12) |
          ((rd & 0x1f) << 7) | (op & 0x7f)) >>> 0;
}

/** Field-extraction helpers used by decoder. */
export const field = {
  opcode: (w: number) => w & 0x7f,
  rd: (w: number) => (w >>> 7) & 0x1f,
  funct3: (w: number) => (w >>> 12) & 0x7,
  rs1: (w: number) => (w >>> 15) & 0x1f,
  rs2: (w: number) => (w >>> 20) & 0x1f,
  funct7: (w: number) => (w >>> 25) & 0x7f,
  immI: (w: number) => {
    const v = w >> 20; // arithmetic shift keeps sign in bit 31 of the 32-bit word
    return BigInt.asIntN(64, BigInt(v));
  },
  immS: (w: number) => {
    const v = ((w >> 25) << 5) | ((w >>> 7) & 0x1f);
    return BigInt.asIntN(64, BigInt(v));
  },
  immB: (w: number) => {
    const bit12 = (w >>> 31) & 1, bit11 = (w >>> 7) & 1;
    const bit10_5 = (w >>> 25) & 0x3f, bit4_1 = (w >>> 8) & 0xf;
    const v = (bit12 << 12) | (bit11 << 11) | (bit10_5 << 5) | (bit4_1 << 1);
    return BigInt.asIntN(64, BigInt.asIntN(13, BigInt(v)));
  },
  immU: (w: number) => BigInt.asIntN(64, BigInt(w & 0xfffff000)),
  immJ: (w: number) => {
    const bit20 = (w >>> 31) & 1, bit19_12 = (w >>> 12) & 0xff;
    const bit11 = (w >>> 20) & 1, bit10_1 = (w >>> 21) & 0x3ff;
    const v = (bit20 << 20) | (bit19_12 << 12) | (bit11 << 11) | (bit10_1 << 1);
    return BigInt.asIntN(64, BigInt.asIntN(21, BigInt(v)));
  },
  isEcall: (w: number) => (w >>> 0) === ECALL,
};

export const REG_NAMES = Object.entries(REG_BY_NAME);
export function regName(n: number): string {
  // Prefer canonical ABI names.
  for (const [name, idx] of REG_NAMES) {
    if (idx === n && !/^x\d+$/.test(name)) return name;
  }
  return `x${n}`;
}
