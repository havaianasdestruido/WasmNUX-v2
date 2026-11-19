// Minimal RV64I subset for Spike A (JIT feasibility)
// Registers: x0..x31 (BigInt64Array or BigUint64Array)

export const OP_IMM = 0x13;
export const OP = 0x33;
export const BRANCH = 0x63;
export const JAL = 0x6f;
export const SYSTEM = 0x73;

// Encode helpers
export function encodeI(opcode, rd, funct3, rs1, imm12) {
  return (
    ((imm12 & 0xfff) << 20) |
    ((rs1 & 0x1f) << 15) |
    ((funct3 & 0x7) << 12) |
    ((rd & 0x1f) << 7) |
    (opcode & 0x7f)
  ) >>> 0;
}

export function encodeR(opcode, rd, funct3, rs1, rs2, funct7) {
  return (
    ((funct7 & 0x7f) << 25) |
    ((rs2 & 0x1f) << 20) |
    ((rs1 & 0x1f) << 15) |
    ((funct3 & 0x7) << 12) |
    ((rd & 0x1f) << 7) |
    (opcode & 0x7f)
  ) >>> 0;
}

export function encodeB(opcode, funct3, rs1, rs2, imm13) {
  const imm = imm13 & 0x1fff;
  const b12 = (imm >> 12) & 1;
  const b10_5 = (imm >> 5) & 0x3f;
  const b4_1 = (imm >> 1) & 0xf;
  const b11 = (imm >> 11) & 1;
  return (
    (b12 << 31) |
    (b10_5 << 25) |
    ((rs2 & 0x1f) << 20) |
    ((rs1 & 0x1f) << 15) |
    ((funct3 & 0x7) << 12) |
    (b4_1 << 8) |
    (b11 << 7) |
    (opcode & 0x7f)
  ) >>> 0;
}

export const addi = (rd, rs1, imm) => encodeI(OP_IMM, rd, 0x0, rs1, imm);
export const add = (rd, rs1, rs2) => encodeR(OP, rd, 0x0, rs1, rs2, 0x00);
export const sub = (rd, rs1, rs2) => encodeR(OP, rd, 0x0, rs1, rs2, 0x20);
export const bne = (rs1, rs2, offset) => encodeB(BRANCH, 0x1, rs1, rs2, offset);
export const blt = (rs1, rs2, offset) => encodeB(BRANCH, 0x4, rs1, rs2, offset);
export const ecall = () => encodeI(SYSTEM, 0, 0, 0, 0);

function signExtend(val, bits) {
  const shift = 32 - bits;
  return BigInt((val << shift) >> shift);
}

export class Rv64Interpreter {
  constructor() {
    this.regs = new BigInt64Array(32);
    this.pc = 0;
    this.instructionsExecuted = 0;
  }

  run(program, maxSteps = 100_000_000) {
    this.pc = 0;
    this.instructionsExecuted = 0;
    while (this.instructionsExecuted < maxSteps) {
      const idx = this.pc >>> 2;
      if (idx >= program.length) break;
      const insn = program[idx];
      this.instructionsExecuted++;

      const opcode = insn & 0x7f;
      const rd = (insn >>> 7) & 0x1f;
      const funct3 = (insn >>> 12) & 0x7;
      const rs1 = (insn >>> 15) & 0x1f;
      const rs2 = (insn >>> 20) & 0x1f;
      const funct7 = (insn >>> 25) & 0x7f;

      if (opcode === OP_IMM && funct3 === 0x0) {
        const imm = signExtend((insn >>> 20) & 0xfff, 12);
        if (rd !== 0) this.regs[rd] = this.regs[rs1] + imm;
        this.pc += 4;
      } else if (opcode === OP && funct3 === 0x0) {
        if (rd !== 0) {
          this.regs[rd] =
            funct7 === 0x20
              ? this.regs[rs1] - this.regs[rs2]
              : this.regs[rs1] + this.regs[rs2];
        }
        this.pc += 4;
      } else if (opcode === BRANCH) {
        const b12 = (insn >>> 31) & 1;
        const b10_5 = (insn >>> 25) & 0x3f;
        const b4_1 = (insn >>> 8) & 0xf;
        const b11 = (insn >>> 7) & 1;
        const imm = Number(
          signExtend((b12 << 12) | (b11 << 11) | (b10_5 << 5) | (b4_1 << 1), 13)
        );
        let taken = false;
        if (funct3 === 0x1) taken = this.regs[rs1] !== this.regs[rs2];
        else if (funct3 === 0x4) taken = this.regs[rs1] < this.regs[rs2];
        this.pc += taken ? imm : 4;
      } else if (opcode === SYSTEM) {
        break;
      } else {
        throw new Error(`Unsupported opcode 0x${opcode.toString(16)} at pc=${this.pc}`);
      }
      this.regs[0] = 0n;
    }
    return this.regs;
  }
}
