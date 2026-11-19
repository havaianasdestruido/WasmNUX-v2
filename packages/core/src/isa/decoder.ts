/**
 * RV64 decoder (Phase 0 subset): RV64I + M + A + Zicsr + basic privileged
 * (ecall/ebreak/mret/sret/wfi/sfence.vma), 32-bit encodings only (no C ext yet;
 * see ADR-0001 on compressed-instruction handling).
 *
 * The decoder is shared by the interpreter and the JIT so both tiers agree on
 * semantics by construction (JIT-vs-interpreter equivalence is then a property
 * of emission, not of decoding).
 */

export const OP_LUI = 0x37;
export const OP_AUIPC = 0x17;
export const OP_JAL = 0x6f;
export const OP_JALR = 0x67;
export const OP_BRANCH = 0x63;
export const OP_LOAD = 0x03;
export const OP_STORE = 0x23;
export const OP_OP_IMM = 0x13;
export const OP_OP = 0x33;
export const OP_MISC_MEM = 0x0f;
export const OP_SYSTEM = 0x73;
export const OP_AMO = 0x2f;

/** All instruction mnemonics the core understands. */
export type Op =
  // RV64I
  | "lui" | "auipc" | "jal" | "jalr"
  | "beq" | "bne" | "blt" | "bge" | "bltu" | "bgeu"
  | "lb" | "lh" | "lw" | "ld" | "lbu" | "lhu" | "lwu"
  | "sb" | "sh" | "sw" | "sd"
  | "addi" | "slti" | "sltiu" | "xori" | "ori" | "andi"
  | "slli" | "srli" | "srai"
  | "add" | "sub" | "sll" | "slt" | "sltu" | "xor" | "srl" | "sra" | "or" | "and"
  | "fence" | "fence_i"
  // Zicsr
  | "csrrw" | "csrrs" | "csrrc" | "csrrwi" | "csrrsi" | "csrrci"
  // M
  | "mul" | "mulh" | "mulhsu" | "mulhu" | "div" | "divu" | "rem" | "remu"
  // A
  | "lr_w" | "lr_d" | "sc_w" | "sc_d"
  | "amoswap_w" | "amoswap_d" | "amoadd_w" | "amoadd_d"
  | "amoxor_w" | "amoxor_d" | "amoand_w" | "amoand_d"
  | "amoor_w" | "amoor_d" | "amomin_w" | "amomin_d"
  | "amomax_w" | "amomax_d" | "amominu_w" | "amominu_d"
  | "amomaxu_w" | "amomaxu_d"
  // Privileged / sync
  | "ecall" | "ebreak" | "mret" | "sret" | "wfi" | "sfence_vma"
  // Not decodable
  | "illegal";

export type InsnFormat = "r" | "i" | "s" | "b" | "u" | "j" | "csr" | "amo" | "sys" | "none";

export interface Insn {
  readonly op: Op;
  readonly raw: number;
  readonly rd: number;
  readonly rs1: number;
  readonly rs2: number;
  /** Immediate, already sign-extended to a BigInt (semantic value). */
  readonly imm: bigint;
  readonly funct3: number;
  readonly funct7: number;
  readonly len: number;
  readonly format: InsnFormat;
}

const SEXT = (value: number, bits: number): bigint => {
  // BigInts are unbounded: interpret as unsigned 32-bit, narrow to `bits`
  // (signed), then widen — this sign-extends correctly for any imm field.
  const v32 = BigInt.asIntN(32, BigInt(value >>> 0));
  return BigInt.asIntN(bits, v32);
};

const REG_NAMES = [
  "zero", "ra", "sp", "gp", "tp", "t0", "t1", "t2",
  "s0", "s1", "a0", "a1", "a2", "a3", "a4", "a5",
  "a6", "a7", "s2", "s3", "s4", "s5", "s6", "s7",
  "s8", "s9", "s10", "s11", "t3", "t4", "t5", "t6",
];

export function regName(n: number): string {
  return REG_NAMES[n] ?? `x${n}`;
}

function immI(raw: number): bigint {
  return SEXT(raw >>> 20, 12);
}
function immS(raw: number): bigint {
  const v = ((raw >>> 25) << 5) | ((raw >>> 7) & 0x1f);
  return SEXT(v, 12);
}
function immB(raw: number): bigint {
  const v =
    (((raw >>> 31) & 1) << 12) |
    (((raw >>> 7) & 1) << 11) |
    (((raw >>> 25) & 0x3f) << 5) |
    (((raw >>> 8) & 0xf) << 1);
  return SEXT(v, 13);
}
function immU(raw: number): bigint {
  return SEXT(raw & 0xfffff000, 32);
}
function immJ(raw: number): bigint {
  const v =
    (((raw >>> 31) & 1) << 20) |
    (((raw >>> 12) & 0xff) << 12) |
    (((raw >>> 20) & 1) << 11) |
    (((raw >>> 21) & 0x3ff) << 1);
  return SEXT(v, 21);
}

const OP_IMM_F3: Record<number, Op> = {
  0: "addi", 2: "slti", 3: "sltiu", 4: "xori", 6: "ori", 7: "andi",
};
const LOAD_F3: Record<number, Op> = {
  0: "lb", 1: "lh", 2: "lw", 3: "ld", 4: "lbu", 5: "lhu", 6: "lwu",
};
const STORE_F3: Record<number, Op> = { 0: "sb", 1: "sh", 2: "sw", 3: "sd" };
const BRANCH_F3: Record<number, Op> = {
  0: "beq", 1: "bne", 4: "blt", 5: "bge", 6: "bltu", 7: "bgeu",
};
const CSR_F3: Record<number, Op> = {
  1: "csrrw", 2: "csrrs", 3: "csrrc", 5: "csrrwi", 6: "csrrsi", 7: "csrrci",
};

function decodeOpImm(raw: number, f3: number): Op {
  if (f3 === 1) {
    // RV64: shamt is 6 bits; funct6 = raw[31:26]
    return (raw >>> 26) === 0b000000 ? "slli" : "illegal";
  }
  if (f3 === 5) {
    const f6 = raw >>> 26;
    if (f6 === 0b000000) return "srli";
    if (f6 === 0b010000) return "srai";
    return "illegal";
  }
  return OP_IMM_F3[f3] ?? "illegal";
}

function decodeOp(raw: number, f3: number): Op {
  const f7 = raw >>> 25;
  if (f7 === 0b0000000) {
    switch (f3) {
      case 0: return "add";
      case 1: return "sll";
      case 2: return "slt";
      case 3: return "sltu";
      case 4: return "xor";
      case 5: return "srl";
      case 6: return "or";
      case 7: return "and";
    }
  } else if (f7 === 0b0100000) {
    if (f3 === 0) return "sub";
    if (f3 === 5) return "sra";
    return "illegal";
  } else if (f7 === 0b0000001) {
    switch (f3) {
      case 0: return "mul";
      case 1: return "mulh";
      case 2: return "mulhsu";
      case 3: return "mulhu";
      case 4: return "div";
      case 5: return "divu";
      case 6: return "rem";
      case 7: return "remu";
    }
  }
  return "illegal";
}

function decodeAmo(raw: number, f3: number): Op {
  const f5 = raw >>> 27;
  const width = f3 === 2 ? "_w" : f3 === 3 ? "_d" : null;
  if (width === null) return "illegal";
  switch (f5) {
    case 0x02: return (`lr${width}` as Op);
    case 0x03: return (`sc${width}` as Op);
    case 0x01: return (`amoswap${width}` as Op);
    case 0x00: return (`amoadd${width}` as Op);
    case 0x04: return (`amoxor${width}` as Op);
    case 0x0c: return (`amoand${width}` as Op);
    case 0x08: return (`amoor${width}` as Op);
    case 0x10: return (`amomin${width}` as Op);
    case 0x14: return (`amomax${width}` as Op);
    case 0x18: return (`amominu${width}` as Op);
    case 0x1c: return (`amomaxu${width}` as Op);
    default: return "illegal";
  }
}

function decodeSystem(raw: number): Op {
  const f3 = (raw >>> 12) & 7;
  if (f3 !== 0) return CSR_F3[f3] ?? "illegal";
  const rd = (raw >>> 7) & 0x1f;
  const funct7 = (raw >>> 25) & 0x7f;
  // sfence.vma: funct7 = 0001001, rd must be zero; rs1 (address) and rs2
  // (ASID) are legal operands and simply widen the flush.
  if (funct7 === 0x09) return rd === 0 ? "sfence_vma" : "illegal";
  const imm = raw >>> 20;
  const isPrivEncoding = rd === 0 && ((raw >>> 15) & 0x1f) === 0;
  if (!isPrivEncoding) return "illegal";
  if (imm === 0x000) return "ecall";
  if (imm === 0x001) return "ebreak";
  if (imm === 0x102) return "sret";
  if (imm === 0x302) return "mret";
  if (imm === 0x105) return "wfi";
  if (imm === 0x120) return "sfence_vma";
  return "illegal";
}

function formatFor(op: Op): InsnFormat {
  switch (op) {
    case "lui": case "auipc": return "u";
    case "jal": return "j";
    case "jalr":
    case "lb": case "lh": case "lw": case "ld":
    case "lbu": case "lhu": case "lwu":
    case "addi": case "slti": case "sltiu": case "xori": case "ori": case "andi":
    case "slli": case "srli": case "srai": return "i";
    case "sb": case "sh": case "sw": case "sd": return "s";
    case "beq": case "bne": case "blt": case "bge": case "bltu": case "bgeu": return "b";
    case "csrrw": case "csrrs": case "csrrc":
    case "csrrwi": case "csrrsi": case "csrrci": return "csr";
    case "lr_w": case "lr_d":
    case "amoswap_w": case "amoswap_d": case "amoadd_w": case "amoadd_d":
    case "amoxor_w": case "amoxor_d": case "amoand_w": case "amoand_d":
    case "amoor_w": case "amoor_d": case "amomin_w": case "amomin_d":
    case "amomax_w": case "amomax_d": case "amominu_w": case "amominu_d":
    case "amomaxu_w": case "amomaxu_d": return "amo";
    case "ecall": case "ebreak": case "mret": case "sret": case "wfi":
    case "sfence_vma": case "fence": case "fence_i": return "sys";
    case "illegal": return "none";
    default: return "r";
  }
}

/** Decode one 32-bit instruction word. `raw` is the little-endian word. */
export function decode(raw: number): Insn {
  const opcode = raw & 0x7f;
  const rd = (raw >>> 7) & 0x1f;
  const funct3 = (raw >>> 12) & 7;
  const rs1 = (raw >>> 15) & 0x1f;
  const rs2 = (raw >>> 20) & 0x1f;
  const funct7 = raw >>> 25;

  let op: Op = "illegal";
  let imm = 0n;

  switch (opcode) {
    case OP_LUI: op = "lui"; imm = immU(raw); break;
    case OP_AUIPC: op = "auipc"; imm = immU(raw); break;
    case OP_JAL: op = "jal"; imm = immJ(raw); break;
    case OP_JALR:
      if (funct3 === 0) { op = "jalr"; imm = immI(raw); }
      break;
    case OP_BRANCH: {
      const b = BRANCH_F3[funct3];
      if (b) { op = b; imm = immB(raw); }
      break;
    }
    case OP_LOAD: {
      const l = LOAD_F3[funct3];
      if (l) { op = l; imm = immI(raw); }
      break;
    }
    case OP_STORE: {
      const s = STORE_F3[funct3];
      if (s !== undefined) { op = s; imm = immS(raw); }
      break;
    }
    case OP_OP_IMM:
      op = decodeOpImm(raw, funct3);
      imm = (funct3 === 1 || funct3 === 5) ? BigInt(raw >>> 20) : immI(raw);
      break;
    case OP_OP:
      op = decodeOp(raw, funct3);
      break;
    case OP_MISC_MEM:
      if (funct3 === 0) op = "fence";
      else if (funct3 === 1) op = "fence_i";
      break;
    case OP_SYSTEM:
      op = decodeSystem(raw);
      imm = (op === "csrrw" || op === "csrrs" || op === "csrrc" || op === "csrrwi" || op === "csrrsi" || op === "csrrci")
        ? BigInt(raw >>> 20) // csr number (also rs1/uimm source)
        : BigInt(raw >>> 20);
      break;
    case OP_AMO:
      op = decodeAmo(raw, funct3);
      break;
    default:
      op = "illegal";
  }

  return { op, raw, rd, rs1, rs2, imm, funct3, funct7, len: 4, format: formatFor(op) };
}

/** Fetch + decode a 32-bit instruction at `pc` from a byte view of guest RAM. */
export function decodeAt(bytes: Uint8Array, pc: number): Insn {
  const raw =
    (bytes[pc]! |
      (bytes[pc + 1]! << 8) |
      (bytes[pc + 2]! << 16) |
      (bytes[pc + 3]! << 24)) >>> 0;
  return decode(raw);
}

export function isTerminator(op: Op): boolean {
  return (
    op === "jal" || op === "jalr" ||
    op === "beq" || op === "bne" || op === "blt" || op === "bge" ||
    op === "bltu" || op === "bgeu" ||
    op === "ecall" || op === "ebreak" || op === "mret" || op === "sret" ||
    op === "wfi" || op === "illegal" || op === "fence_i" ||
    op === "sfence_vma" ||
    // CSR ops / atomics / mulh* go through the interpreter slow path for now
    // (documented in docs/phase0/RESULTS.md coverage table).
    op.startsWith("csr") || op.startsWith("amo") || op.startsWith("lr_") || op.startsWith("sc_") ||
    op === "mulh" || op === "mulhu" || op === "mulhsu"
  );
}
