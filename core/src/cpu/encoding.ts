/**
 * RV32IM(A) instruction encoding, decoding and disassembly.
 *
 * This is the single source of truth for instruction semantics shared by:
 *   - the assembler (`asm.ts`) used to build benchmark kernels and conformance tests
 *   - the interpreter tier (`interp.ts`)
 *   - the JIT translator (`../../jit/translate.ts`)
 *
 * Keeping encode/decode in one place is what makes the differential fuzzing in
 * `core/test/differential.test.ts` meaningful: both tiers are checked against the
 * same decoding, and any divergence is a codegen bug, not a spec disagreement.
 */

// ---------------------------------------------------------------------------
// Major opcodes
// ---------------------------------------------------------------------------

export const OP_LUI = 0b0110111;
export const OP_AUIPC = 0b0010111;
export const OP_JAL = 0b1101111;
export const OP_JALR = 0b1100111;
export const OP_BRANCH = 0b1100011;
export const OP_LOAD = 0b0000011;
export const OP_STORE = 0b0100011;
export const OP_OPI = 0b0010011;
export const OP_OP = 0b0110011;
export const OP_MISC_MEM = 0b0001111;
export const OP_SYSTEM = 0b1110011;
export const OP_AMO = 0b0101111;

// funct3 for branches
export const F3_BEQ = 0b000;
export const F3_BNE = 0b001;
export const F3_BLT = 0b100;
export const F3_BGE = 0b101;
export const F3_BLTU = 0b110;
export const F3_BGEU = 0b111;

// funct3 for loads / stores (width)
export const F3_B = 0b000;
export const F3_H = 0b001;
export const F3_W = 0b010;
export const F3_BU = 0b100;
export const F3_HU = 0b101;

// funct3 for OP / OPI
export const F3_ADD = 0b000; // ADD / SUB, ADDI
export const F3_SLL = 0b001; // SLL, SLLI
export const F3_SLT = 0b010;
export const F3_SLTU = 0b011;
export const F3_XOR = 0b100;
export const F3_SRL = 0b101; // SRL / SRA, SRLI / SRAI
export const F3_OR = 0b110;
export const F3_AND = 0b111;

// funct7
export const F7_NORMAL = 0b0000000;
export const F7_ALT = 0b0100000; // SUB / SRA / SRAI
export const F7_MULDIV = 0b0000001; // M extension

// funct3 for M extension
export const F3_MUL = 0b000;
export const F3_MULH = 0b001;
export const F3_MULHSU = 0b010;
export const F3_MULHU = 0b011;
export const F3_DIV = 0b100;
export const F3_DIVU = 0b101;
export const F3_REM = 0b110;
export const F3_REMU = 0b111;

// funct5 for A extension (AMO), encoded in instr[31:27]
export const AMO5_ADD = 0b00000;
export const AMO5_SWAP = 0b00001;
export const AMO5_LR = 0b00010;
export const AMO5_SC = 0b00011;
export const AMO5_XOR = 0b00100;
export const AMO5_OR = 0b00110;
export const AMO5_AND = 0b00111;
export const AMO5_MIN = 0b01000;
export const AMO5_MAX = 0b01010;
export const AMO5_MINU = 0b01100;
export const AMO5_MAXU = 0b01110;

// SYSTEM funct3 / funct12
export const F3_PRIV = 0b000;
export const F3_CSRRW = 0b001;
export const F3_CSRRS = 0b010;
export const F3_CSRRC = 0b011;
export const F3_CSRRWI = 0b101;
export const F3_CSRRSI = 0b110;
export const F3_CSRRCI = 0b111;

export const F12_ECALL = 0x000;
export const F12_EBREAK = 0x001;
export const F12_URET = 0x002;
export const F12_SRET = 0x102;
export const F12_MRET = 0x302;
export const F12_WFI = 0x105;

// ---------------------------------------------------------------------------
// Field extraction
// ---------------------------------------------------------------------------

export const rd = (i: number): number => (i >>> 7) & 0x1f;
export const funct3 = (i: number): number => (i >>> 12) & 0b111;
export const rs1 = (i: number): number => (i >>> 15) & 0x1f;
export const rs2 = (i: number): number => (i >>> 20) & 0x1f;
export const funct7 = (i: number): number => (i >>> 25) & 0x7f;
export const opcode = (i: number): number => i & 0x7f;
export const amoFunct5 = (i: number): number => (i >>> 27) & 0x1f;
/** aq/rl bits of an AMO instruction. */
export const amoAq = (i: number): boolean => ((i >>> 26) & 1) === 1;
export const amoRl = (i: number): boolean => ((i >>> 25) & 1) === 1;

/** I-type immediate (sign extended). */
export const immI = (i: number): number => i >> 20;

/** S-type immediate (sign extended). */
export const immS = (i: number): number => ((((i >>> 25) << 5) | ((i >>> 7) & 0x1f)) << 20) >> 20;

/** B-type immediate (sign extended, always even). */
export const immB = (i: number): number => {
  const v =
    (((i >>> 31) & 1) << 12) |
    (((i >>> 7) & 1) << 11) |
    (((i >>> 25) & 0x3f) << 5) |
    (((i >>> 8) & 0xf) << 1);
  return (v << 19) >> 19;
};

/** U-type immediate (already in bits 31:12). */
export const immU = (i: number): number => i & 0xfffff000;

/** J-type immediate (sign extended, always even). */
export const immJ = (i: number): number => {
  const v =
    (((i >>> 31) & 1) << 20) |
    (((i >>> 12) & 0xff) << 12) |
    (((i >>> 20) & 1) << 11) |
    (((i >>> 21) & 0x3ff) << 1);
  return (v << 11) >> 11;
};

/** CSR address (instr[31:20]). */
export const csrAddr = (i: number): number => (i >>> 20) & 0xfff;

// ---------------------------------------------------------------------------
// Encoders (used by the assembler, by tests, and by the fuzzer)
// ---------------------------------------------------------------------------

const checkReg = (r: number, what: string): number => {
  if (!Number.isInteger(r) || r < 0 || r > 31) throw new Error(`${what} out of range: ${r}`);
  return r;
};

export function rType(op: number, f3: number, f7: number, rd_: number, rs1_: number, rs2_: number): number {
  return (
    (((f7 & 0x7f) << 25) |
      (checkReg(rs2_, 'rs2') << 20) |
      (checkReg(rs1_, 'rs1') << 15) |
      ((f3 & 7) << 12) |
      (checkReg(rd_, 'rd') << 7) |
      (op & 0x7f)) >>>
    0
  );
}

export function iType(op: number, f3: number, rd_: number, rs1_: number, imm: number): number {
  if (!Number.isInteger(imm) || imm < -2048 || imm > 2047)
    throw new Error(`I-type immediate out of range: ${imm}`);
  return (
    ((((imm & 0xfff) << 20) >>> 0) |
      (checkReg(rs1_, 'rs1') << 15) |
      ((f3 & 7) << 12) |
      (checkReg(rd_, 'rd') << 7) |
      (op & 0x7f)) >>>
    0
  );
}

export function sType(op: number, f3: number, rs1_: number, rs2_: number, imm: number): number {
  if (!Number.isInteger(imm) || imm < -2048 || imm > 2047)
    throw new Error(`S-type immediate out of range: ${imm}`);
  const v = imm & 0xfff;
  return (
    (((((v >>> 5) & 0x7f) << 25) >>> 0) |
      (checkReg(rs2_, 'rs2') << 20) |
      (checkReg(rs1_, 'rs1') << 15) |
      ((f3 & 7) << 12) |
      (((v & 0x1f) << 7) >>> 0) |
      (op & 0x7f)) >>>
    0
  );
}

export function bType(op: number, f3: number, rs1_: number, rs2_: number, offset: number): number {
  if (!Number.isInteger(offset) || offset < -4096 || offset > 4095 || (offset & 1) !== 0) {
    throw new Error(`B-type offset out of range or odd: ${offset}`);
  }
  const v = offset & 0x1fff;
  return (
    (((((v >>> 12) & 1) << 31) >>> 0) |
      ((((v >>> 5) & 0x3f) << 25) >>> 0) |
      (checkReg(rs2_, 'rs2') << 20) |
      (checkReg(rs1_, 'rs1') << 15) |
      ((f3 & 7) << 12) |
      (((v & 0x1e) << 7) >>> 0) |
      ((((v >>> 11) & 1) << 7) >>> 0) |
      (op & 0x7f)) >>>
    0
  );
}

/**
 * U-type (lui / auipc).
 *
 * `imm20` is the 20-bit immediate *field*, matching GNU as: writing
 * "lui a0, 0xdeadb" puts 0xdeadb in bits 31:12, so a0 becomes 0xdeadb000.
 * Relocation fixups that already carry a shifted value go through `patchU`.
 */
export function uType(op: number, rd_: number, imm20: number): number {
  if (!Number.isInteger(imm20) || imm20 < -524288 || imm20 > 0xfffff) {
    throw new Error(
      'U-type immediate out of range: ' +
        imm20 +
        ' (expected the 20-bit field, not a value already shifted to bits 31:12)',
    );
  }
  return ((((imm20 << 12) & 0xfffff000) >>> 0) | (checkReg(rd_, 'rd') << 7) | (op & 0x7f)) >>> 0;
}

/**
 * SYSTEM-type (CSR instructions, ecall/ebreak/mret/wfi).
 *
 * Like `iType` but the 12-bit field is an *unsigned* CSR address or funct12, so
 * it must not be range-checked as a signed immediate: csrr t0, minstret (0xb02)
 * is perfectly legal and would otherwise be rejected.
 */
export function systemType(f3: number, rd_: number, rs1_: number, csr: number): number {
  if (!Number.isInteger(csr) || csr < 0 || csr > 0xfff) {
    throw new Error('CSR address out of range (12 bits unsigned): ' + csr);
  }
  return (
    ((((csr & 0xfff) << 20) >>> 0) |
      (checkReg(rs1_, 'rs1') << 15) |
      ((f3 & 7) << 12) |
      (checkReg(rd_, 'rd') << 7) |
      (OP_SYSTEM & 0x7f)) >>>
    0
  );
}

export function jType(op: number, rd_: number, offset: number): number {
  if (!Number.isInteger(offset) || offset < -1048576 || offset > 1048575 || (offset & 1) !== 0) {
    throw new Error(`J-type offset out of range or odd: ${offset}`);
  }
  const v = offset & 0x1fffff;
  return (
    (((((v >>> 20) & 1) << 31) >>> 0) |
      ((((v >>> 1) & 0x3ff) << 21) >>> 0) |
      ((((v >>> 11) & 1) << 20) >>> 0) |
      ((((v >>> 12) & 0xff) << 12) >>> 0) |
      (checkReg(rd_, 'rd') << 7) |
      (op & 0x7f)) >>>
    0
  );
}

export function amoType(
  f5: number,
  aq: boolean,
  rl: boolean,
  rd_: number,
  rs1_: number,
  rs2_: number,
  f3: number,
): number {
  return (
    ((((f5 & 0x1f) << 27) >>> 0) |
      ((aq ? 1 : 0) << 26) |
      ((rl ? 1 : 0) << 25) |
      (checkReg(rs2_, 'rs2') << 20) |
      (checkReg(rs1_, 'rs1') << 15) |
      ((f3 & 7) << 12) |
      (checkReg(rd_, 'rd') << 7) |
      OP_AMO) >>>
    0
  );
}

// ---------------------------------------------------------------------------
// Structured decode (disassembly, CFG building, fuzzing)
// ---------------------------------------------------------------------------

export type InsnFormat = 'R' | 'I' | 'S' | 'B' | 'U' | 'J' | 'AMO' | 'CSR' | 'SYS' | 'unknown';

export interface Decoded {
  instr: number;
  /** Canonical mnemonic, or `illegal` when the word does not decode. */
  mnemonic: string;
  format: InsnFormat;
  rd: number;
  rs1: number;
  rs2: number;
  /** Immediate value (already sign extended / shifted per format). */
  imm: number;
  /** For B/J: the target given `pc`. For JALR: `pc + 4` (link). */
  target: number;
  /** True when control flow does not fall through unconditionally. */
  isBranch: boolean;
  /** True for JAL with rd=0 to a non-sequential target, or a never-taken pattern. */
  isJump: boolean;
  /** True when the instruction can leave the current basic block. */
  terminatesBlock: boolean;
  /** True for loads/stores/AMOs. */
  touchesMemory: boolean;
  isLoad: boolean;
  isStore: boolean;
  isAmo: boolean;
  /** True for ECALL/EBREAK/CSR/FENCE.I/MRET/WFI - everything the JIT sends to the host. */
  isSlowPath: boolean;
  csr: number;
  illegal: boolean;
}

const REG_ABI = [
  'zero',
  'ra',
  'sp',
  'gp',
  'tp',
  't0',
  't1',
  't2',
  's0',
  's1',
  'a0',
  'a1',
  'a2',
  'a3',
  'a4',
  'a5',
  'a6',
  'a7',
  's2',
  's3',
  's4',
  's5',
  's6',
  's7',
  's8',
  's9',
  's10',
  's11',
  't3',
  't4',
  't5',
  't6',
];

export const regName = (r: number): string => REG_ABI[r] ?? `x${r}`;

export const CSR_NAMES: Record<number, string> = {
  0xc00: 'cycle',
  0xc01: 'time',
  0xc02: 'instret',
  0x300: 'mstatus',
  0x301: 'misa',
  0x304: 'mie',
  0x305: 'mtvec',
  0x340: 'mscratch',
  0x341: 'mepc',
  0x342: 'mcause',
  0x343: 'mtval',
  0x344: 'mip',
  0xb00: 'mcycle',
  0xb02: 'minstret',
  0xf14: 'mhartid',
};

/** Decode a 32-bit instruction word. Never throws. */
export function decode(instr: number, pc = 0): Decoded {
  const d: Decoded = {
    instr: instr >>> 0,
    mnemonic: 'illegal',
    format: 'unknown',
    rd: 0,
    rs1: 0,
    rs2: 0,
    imm: 0,
    target: (pc + 4) >>> 0,
    isBranch: false,
    isJump: false,
    terminatesBlock: false,
    touchesMemory: false,
    isLoad: false,
    isStore: false,
    isAmo: false,
    isSlowPath: false,
    csr: 0,
    illegal: false,
  };
  const op = opcode(instr);
  const f3 = funct3(instr);
  const f7 = funct7(instr);
  d.rd = rd(instr);
  d.rs1 = rs1(instr);
  d.rs2 = rs2(instr);

  switch (op) {
    case OP_LUI:
      d.format = 'U';
      d.mnemonic = 'lui';
      d.imm = immU(instr);
      break;
    case OP_AUIPC:
      d.format = 'U';
      d.mnemonic = 'auipc';
      d.imm = immU(instr);
      break;
    case OP_JAL: {
      d.format = 'J';
      d.mnemonic = 'jal';
      d.imm = immJ(instr);
      d.target = (pc + d.imm) >>> 0;
      d.isJump = true;
      d.isBranch = true;
      d.terminatesBlock = true;
      break;
    }
    case OP_JALR: {
      d.format = 'I';
      d.mnemonic = 'jalr';
      d.imm = immI(instr);
      d.isJump = true;
      d.isBranch = true;
      d.terminatesBlock = true;
      break;
    }
    case OP_BRANCH: {
      d.format = 'B';
      d.imm = immB(instr);
      d.target = (pc + d.imm) >>> 0;
      d.isBranch = true;
      d.terminatesBlock = true;
      d.mnemonic =
        f3 === F3_BEQ
          ? 'beq'
          : f3 === F3_BNE
            ? 'bne'
            : f3 === F3_BLT
              ? 'blt'
              : f3 === F3_BGE
                ? 'bge'
                : f3 === F3_BLTU
                  ? 'bltu'
                  : f3 === F3_BGEU
                    ? 'bgeu'
                    : 'illegal';
      if (d.mnemonic === 'illegal') d.illegal = true;
      break;
    }
    case OP_LOAD: {
      d.format = 'I';
      d.imm = immI(instr);
      d.isLoad = true;
      d.touchesMemory = true;
      d.mnemonic =
        f3 === F3_B
          ? 'lb'
          : f3 === F3_H
            ? 'lh'
            : f3 === F3_W
              ? 'lw'
              : f3 === F3_BU
                ? 'lbu'
                : f3 === F3_HU
                  ? 'lhu'
                  : 'illegal';
      if (d.mnemonic === 'illegal') d.illegal = true;
      break;
    }
    case OP_STORE: {
      d.format = 'S';
      d.imm = immS(instr);
      d.isStore = true;
      d.touchesMemory = true;
      d.mnemonic = f3 === F3_B ? 'sb' : f3 === F3_H ? 'sh' : f3 === F3_W ? 'sw' : 'illegal';
      if (d.mnemonic === 'illegal') d.illegal = true;
      break;
    }
    case OP_OPI: {
      d.format = 'I';
      d.imm = immI(instr);
      const shamt = (instr >>> 20) & 0x1f;
      switch (f3) {
        case F3_ADD:
          d.mnemonic = 'addi';
          break;
        case F3_SLT:
          d.mnemonic = 'slti';
          break;
        case F3_SLTU:
          d.mnemonic = 'sltiu';
          break;
        case F3_XOR:
          d.mnemonic = 'xori';
          break;
        case F3_OR:
          d.mnemonic = 'ori';
          break;
        case F3_AND:
          d.mnemonic = 'andi';
          break;
        case F3_SLL:
          d.mnemonic = f7 === F7_NORMAL ? 'slli' : 'illegal';
          d.imm = shamt;
          break;
        case F3_SRL:
          d.mnemonic = f7 === F7_NORMAL ? 'srli' : f7 === F7_ALT ? 'srai' : 'illegal';
          d.imm = shamt;
          break;
        default:
          d.mnemonic = 'illegal';
      }
      if (d.mnemonic === 'illegal') d.illegal = true;
      break;
    }
    case OP_OP: {
      d.format = 'R';
      if (f7 === F7_MULDIV) {
        d.mnemonic =
          f3 === F3_MUL
            ? 'mul'
            : f3 === F3_MULH
              ? 'mulh'
              : f3 === F3_MULHSU
                ? 'mulhsu'
                : f3 === F3_MULHU
                  ? 'mulhu'
                  : f3 === F3_DIV
                    ? 'div'
                    : f3 === F3_DIVU
                      ? 'divu'
                      : f3 === F3_REM
                        ? 'rem'
                        : f3 === F3_REMU
                          ? 'remu'
                          : 'illegal';
      } else if (f7 === F7_NORMAL || f7 === F7_ALT) {
        switch (f3) {
          case F3_ADD:
            d.mnemonic = f7 === F7_NORMAL ? 'add' : 'sub';
            break;
          case F3_SLL:
            d.mnemonic = f7 === F7_NORMAL ? 'sll' : 'illegal';
            break;
          case F3_SLT:
            d.mnemonic = f7 === F7_NORMAL ? 'slt' : 'illegal';
            break;
          case F3_SLTU:
            d.mnemonic = f7 === F7_NORMAL ? 'sltu' : 'illegal';
            break;
          case F3_XOR:
            d.mnemonic = f7 === F7_NORMAL ? 'xor' : 'illegal';
            break;
          case F3_SRL:
            d.mnemonic = f7 === F7_NORMAL ? 'srl' : 'sra';
            break;
          case F3_OR:
            d.mnemonic = f7 === F7_NORMAL ? 'or' : 'illegal';
            break;
          case F3_AND:
            d.mnemonic = f7 === F7_NORMAL ? 'and' : 'illegal';
            break;
        }
      } else {
        d.mnemonic = 'illegal';
      }
      if (d.mnemonic === 'illegal') d.illegal = true;
      break;
    }
    case OP_MISC_MEM:
      d.format = 'I';
      d.mnemonic = f3 === 0 ? 'fence' : f3 === 1 ? 'fence.i' : 'illegal';
      if (d.mnemonic === 'fence.i') d.isSlowPath = true;
      if (d.mnemonic === 'illegal') d.illegal = true;
      break;
    case OP_AMO: {
      d.format = 'AMO';
      d.isAmo = true;
      d.touchesMemory = true;
      d.isLoad = true;
      d.isStore = true;
      const f5 = amoFunct5(instr);
      if (f3 !== 0b010) {
        d.mnemonic = 'illegal';
        d.illegal = true;
      } else {
        d.mnemonic =
          f5 === AMO5_LR
            ? 'lr.w'
            : f5 === AMO5_SC
              ? 'sc.w'
              : f5 === AMO5_SWAP
                ? 'amoswap.w'
                : f5 === AMO5_ADD
                  ? 'amoadd.w'
                  : f5 === AMO5_XOR
                    ? 'amoxor.w'
                    : f5 === AMO5_OR
                      ? 'amoor.w'
                      : f5 === AMO5_AND
                        ? 'amoand.w'
                        : f5 === AMO5_MIN
                          ? 'amomin.w'
                          : f5 === AMO5_MAX
                            ? 'amomax.w'
                            : f5 === AMO5_MINU
                              ? 'amominu.w'
                              : f5 === AMO5_MAXU
                                ? 'amomaxu.w'
                                : 'illegal';
        if (d.mnemonic === 'illegal') d.illegal = true;
      }
      break;
    }
    case OP_SYSTEM: {
      if (f3 === F3_PRIV) {
        d.format = 'SYS';
        d.isSlowPath = true;
        d.terminatesBlock = true;
        const f12 = (instr >>> 20) & 0xfff;
        d.mnemonic =
          f12 === F12_ECALL
            ? 'ecall'
            : f12 === F12_EBREAK
              ? 'ebreak'
              : f12 === F12_MRET
                ? 'mret'
                : f12 === F12_SRET
                  ? 'sret'
                  : f12 === F12_WFI
                    ? 'wfi'
                    : 'illegal';
        if (d.mnemonic === 'illegal') d.illegal = true;
      } else {
        d.format = 'CSR';
        d.isSlowPath = true;
        d.csr = csrAddr(instr);
        d.imm = (instr >>> 15) & 0x1f;
        d.mnemonic =
          f3 === F3_CSRRW
            ? 'csrrw'
            : f3 === F3_CSRRS
              ? 'csrrs'
              : f3 === F3_CSRRC
                ? 'csrrc'
                : f3 === F3_CSRRWI
                  ? 'csrrwi'
                  : f3 === F3_CSRRSI
                    ? 'csrrsi'
                    : f3 === F3_CSRRCI
                      ? 'csrrci'
                      : 'illegal';
        if (d.mnemonic === 'illegal') d.illegal = true;
      }
      break;
    }
    default:
      d.mnemonic = 'illegal';
      d.illegal = true;
  }
  return d;
}

/** Human readable disassembly, mostly for test failure messages and tracing. */
export function disasm(instr: number, pc = 0): string {
  const d = decode(instr, pc);
  const hex = `0x${(instr >>> 0).toString(16).padStart(8, '0')}`;
  if (d.illegal) return `${hex}  .word ${hex}  # illegal`;
  const r = (n: number) => regName(n);
  switch (d.mnemonic) {
    case 'lui':
    case 'auipc':
      return `${hex}  ${d.mnemonic} ${r(d.rd)}, 0x${(d.imm >>> 12).toString(16)}`;
    case 'jal':
      return `${hex}  jal ${r(d.rd)}, 0x${d.target.toString(16)}`;
    case 'jalr':
      return `${hex}  jalr ${r(d.rd)}, ${d.imm}(${r(d.rs1)})`;
    case 'beq':
    case 'bne':
    case 'blt':
    case 'bge':
    case 'bltu':
    case 'bgeu':
      return `${hex}  ${d.mnemonic} ${r(d.rs1)}, ${r(d.rs2)}, 0x${d.target.toString(16)}`;
    case 'lb':
    case 'lh':
    case 'lw':
    case 'lbu':
    case 'lhu':
      return `${hex}  ${d.mnemonic} ${r(d.rd)}, ${d.imm}(${r(d.rs1)})`;
    case 'sb':
    case 'sh':
    case 'sw':
      return `${hex}  ${d.mnemonic} ${r(d.rs2)}, ${d.imm}(${r(d.rs1)})`;
    case 'addi':
    case 'slti':
    case 'sltiu':
    case 'xori':
    case 'ori':
    case 'andi':
    case 'slli':
    case 'srli':
    case 'srai':
      return `${hex}  ${d.mnemonic} ${r(d.rd)}, ${r(d.rs1)}, ${d.imm}`;
    case 'ecall':
    case 'ebreak':
    case 'mret':
    case 'sret':
    case 'wfi':
    case 'fence':
    case 'fence.i':
      return `${hex}  ${d.mnemonic}`;
    case 'csrrw':
    case 'csrrs':
    case 'csrrc':
      return `${hex}  ${d.mnemonic} ${r(d.rd)}, ${CSR_NAMES[d.csr] ?? `0x${d.csr.toString(16)}`}, ${r(d.rs1)}`;
    case 'csrrwi':
    case 'csrrsi':
    case 'csrrci':
      return `${hex}  ${d.mnemonic} ${r(d.rd)}, ${CSR_NAMES[d.csr] ?? `0x${d.csr.toString(16)}`}, ${d.imm}`;
    case 'lr.w':
      return `${hex}  lr.w ${r(d.rd)}, (${r(d.rs1)})`;
    case 'sc.w':
      return `${hex}  sc.w ${r(d.rd)}, ${r(d.rs2)}, (${r(d.rs1)})`;
    default:
      if (d.isAmo) return `${hex}  ${d.mnemonic} ${r(d.rd)}, ${r(d.rs2)}, (${r(d.rs1)})`;
      return `${hex}  ${d.mnemonic} ${r(d.rd)}, ${r(d.rs1)}, ${r(d.rs2)}`;
  }
}

// ---------------------------------------------------------------------------
// Immediate patching
//
// The assembler emits instructions with a zeroed immediate field and ORs the
// resolved value in afterwards, so each format needs a "patch" counterpart to
// its encoder. The JIT emitter never needs these (it knows immediates up front)
// but keeping them next to the encoders avoids a second source of truth for the
// scrambled B/J bit layouts.
// ---------------------------------------------------------------------------

export function patchU(word: number, value: number): number {
  return ((word >>> 0) | ((value >>> 0) & 0xfffff000)) >>> 0;
}

export function patchI(word: number, imm: number): number {
  if (!Number.isInteger(imm) || imm < -2048 || imm > 2047)
    throw new Error(`I-type immediate out of range: ${imm}`);
  return ((word >>> 0) | (((imm & 0xfff) << 20) >>> 0)) >>> 0;
}

export function patchS(word: number, imm: number): number {
  if (!Number.isInteger(imm) || imm < -2048 || imm > 2047)
    throw new Error(`S-type immediate out of range: ${imm}`);
  const v = imm & 0xfff;
  return ((word >>> 0) | ((((v >>> 5) & 0x7f) << 25) >>> 0) | (((v & 0x1f) << 7) >>> 0)) >>> 0;
}

export function patchB(word: number, offset: number): number {
  // No compressed extension, so every branch target is word aligned. Saying so
  // beats reporting a misaligned target as "out of range".
  if (!Number.isInteger(offset) || (offset & 3) !== 0) {
    throw new Error(`branch offset must be a multiple of 4: ${offset}`);
  }
  if (offset < -4096 || offset > 4095) {
    throw new Error(`branch offset out of range (±4 KiB): ${offset}`);
  }
  const v = offset & 0x1fff;
  return (
    ((word >>> 0) |
      ((((v >>> 12) & 1) << 31) >>> 0) |
      ((((v >>> 5) & 0x3f) << 25) >>> 0) |
      (((v & 0x1e) << 7) >>> 0) |
      ((((v >>> 11) & 1) << 7) >>> 0)) >>>
    0
  );
}

export function patchJ(word: number, offset: number): number {
  if (!Number.isInteger(offset) || (offset & 3) !== 0) {
    throw new Error(`jump offset must be a multiple of 4: ${offset}`);
  }
  if (offset < -1048576 || offset > 1048575) {
    throw new Error(`jump offset out of range (±1 MiB): ${offset}`);
  }
  const v = offset & 0x1fffff;
  return (
    ((word >>> 0) |
      ((((v >>> 20) & 1) << 31) >>> 0) |
      ((((v >>> 1) & 0x3ff) << 21) >>> 0) |
      ((((v >>> 11) & 1) << 20) >>> 0) |
      ((((v >>> 12) & 0xff) << 12) >>> 0)) >>>
    0
  );
}

/** Which immediate format an (already encoded, immediate-zeroed) word uses. */
export function immFormat(word: number): 'U' | 'I' | 'S' | 'B' | 'J' {
  switch (word & 0x7f) {
    case OP_LUI:
    case OP_AUIPC:
      return 'U';
    case OP_JAL:
      return 'J';
    case OP_BRANCH:
      return 'B';
    case OP_STORE:
      return 'S';
    default:
      return 'I';
  }
}
