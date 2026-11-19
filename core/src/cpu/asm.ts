/**
 * Minimal two-pass RV32IM(A) assembler.
 *
 * Why we ship our own assembler in Phase 0:
 *  - there is no RISC-V toolchain inside a browser (nor inside our hermetic CI
 *    sandbox), yet every benchmark kernel and conformance test needs to be built
 *    from source that lives in the repository;
 *  - the assembler is the fuzzer's instruction generator and the writer of the
 *    ELF images we hand to `qemu-riscv32` as the QEMU-TCG baseline (see
 *    `benchmarks/suites/cpu.ts` and `.github/workflows/qemu-baseline.yml`).
 *
 * Supported: RV32I + M + A (word variants), labels, numeric literals,
 * `%hi/%lo/%pcrel_hi/%pcrel_lo`, the usual pseudo-instructions and data
 * directives. Deliberately *not* supported: macros, the compressed (C)
 * extension, floating point, relocatable output. Everything is assembled to a
 * flat image at a fixed base address.
 */

import {
  AMO5_ADD,
  AMO5_AND,
  AMO5_LR,
  AMO5_MAX,
  AMO5_MAXU,
  AMO5_MIN,
  AMO5_MINU,
  AMO5_OR,
  AMO5_SC,
  AMO5_SWAP,
  AMO5_XOR,
  F12_EBREAK,
  F12_ECALL,
  F12_MRET,
  F12_WFI,
  F3_ADD,
  F3_AND,
  F3_BEQ,
  F3_BGE,
  F3_BGEU,
  F3_BLT,
  F3_BLTU,
  F3_BNE,
  F3_BU,
  F3_B,
  F3_CSRRC,
  F3_CSRRCI,
  F3_CSRRS,
  F3_CSRRSI,
  F3_CSRRW,
  F3_CSRRWI,
  F3_DIV,
  F3_DIVU,
  F3_H,
  F3_HU,
  F3_MUL,
  F3_MULH,
  F3_MULHSU,
  F3_MULHU,
  F3_OR,
  F3_REM,
  F3_REMU,
  F3_SLL,
  F3_SLT,
  F3_SLTU,
  F3_SRL,
  F3_W,
  F3_XOR,
  F7_ALT,
  F7_MULDIV,
  F7_NORMAL,
  OP_AMO,
  OP_AUIPC,
  OP_BRANCH,
  OP_JAL,
  OP_JALR,
  OP_LOAD,
  OP_LUI,
  OP_MISC_MEM,
  OP_OP,
  OP_OPI,
  OP_STORE,
  OP_SYSTEM,
  amoType,
  bType,
  immFormat,
  iType,
  jType,
  patchB,
  patchI,
  patchJ,
  patchS,
  patchU,
  rType,
  sType,
  systemType,
  uType,
} from './encoding.ts';

const REGISTERS: Record<string, number> = {
  zero: 0,
  x0: 0,
  ra: 1,
  x1: 1,
  sp: 2,
  x2: 2,
  gp: 3,
  x3: 3,
  tp: 4,
  x4: 4,
  t0: 5,
  x5: 5,
  t1: 6,
  x6: 6,
  t2: 7,
  x7: 7,
  s0: 8,
  fp: 8,
  x8: 8,
  s1: 9,
  x9: 9,
  a0: 10,
  x10: 10,
  a1: 11,
  x11: 11,
  a2: 12,
  x12: 12,
  a3: 13,
  x13: 13,
  a4: 14,
  x14: 14,
  a5: 15,
  x15: 15,
  a6: 16,
  x16: 16,
  a7: 17,
  x17: 17,
  s2: 18,
  x18: 18,
  s3: 19,
  x19: 19,
  s4: 20,
  x20: 20,
  s5: 21,
  x21: 21,
  s6: 22,
  x22: 22,
  s7: 23,
  x23: 23,
  s8: 24,
  x24: 24,
  s9: 25,
  x25: 25,
  s10: 26,
  x26: 26,
  s11: 27,
  x27: 27,
  t3: 28,
  x28: 28,
  t4: 29,
  x29: 29,
  t5: 30,
  x30: 30,
  t6: 31,
  x31: 31,
};

export const CSR_ALIASES: Record<string, number> = {
  cycle: 0xc00,
  time: 0xc01,
  instret: 0xc02,
  mstatus: 0x300,
  misa: 0x301,
  mie: 0x304,
  mtvec: 0x305,
  mscratch: 0x340,
  mepc: 0x341,
  mcause: 0x342,
  mtval: 0x343,
  mip: 0x344,
  mcycle: 0xb00,
  minstret: 0xb02,
  mhartid: 0xf14,
};

export interface AssembleOptions {
  /** Address the image is linked at. Defaults to 0 (the `8086emu` baseline needs 0). */
  base?: number;
  /** Entry symbol. Defaults to `_start` when present, else `base`. */
  entry?: string;
  /** Predefined symbols (e.g. `__heap_base`). */
  defines?: Record<string, number>;
}

export interface Assembled {
  /** Flat image, starting at `base`. */
  bytes: Uint8Array;
  base: number;
  entry: number;
  size: number;
  labels: ReadonlyMap<string, number>;
  globals: string[];
  /** Source line -> address, for trace output. */
  lineMap: Array<{ line: number; addr: number }>;
}

export class AsmError extends Error {
  constructor(
    message: string,
    readonly line: number,
  ) {
    super(`line ${line}: ${message}`);
    this.name = 'AsmError';
  }
}

// ---------------------------------------------------------------------------
// Expressions
// ---------------------------------------------------------------------------

type Expr =
  | { kind: 'const'; value: number }
  | { kind: 'sym'; name: string; disp: number }
  | { kind: 'pc'; disp: number }
  | { kind: 'hi'; inner: Expr }
  | { kind: 'lo'; inner: Expr }
  | { kind: 'pcrelHi'; sym: string }
  | { kind: 'pcrelLo'; label: string }
  | { kind: 'pcrelLoBack'; back: number };

/** A relocation slot: `rel` means the resolved value is an absolute address. */
interface Slot {
  expr: Expr;
  rel: boolean;
}

interface Build {
  words: number[];
  slots: (Slot | null)[];
  /** Symbol referenced by `%pcrel_hi` at this instruction's own address. */
  pcrelSym?: string;
}

type Rec =
  | { t: 'label'; name: string; line: number }
  | { t: 'insn'; line: number; words: number[]; slots: (Slot | null)[]; pcrelSym?: string; addr: number }
  | { t: 'data'; line: number; bytes: number[] | null; slot: Slot | null; width: number; addr: number }
  | { t: 'align'; to: number }
  | { t: 'zero'; count: number; addr: number };

// ---------------------------------------------------------------------------
// Token helpers
// ---------------------------------------------------------------------------

function findComment(text: string): number {
  let inStr = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') inStr = !inStr;
    if (inStr) continue;
    if (c === '#') return i;
    if (c === '/' && text[i + 1] === '/') return i;
  }
  return -1;
}

function parseReg(tok: string, line: number): number {
  const r = REGISTERS[tok.trim().toLowerCase()];
  if (r === undefined) throw new AsmError(`unknown register '${tok}'`, line);
  return r;
}

function splitOperands(s: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = '';
  for (const ch of s) {
    if (ch === '(') depth++;
    else if (ch === ')') depth--;
    if (ch === ',' && depth === 0) {
      out.push(cur.trim());
      cur = '';
    } else cur += ch;
  }
  if (cur.trim().length) out.push(cur.trim());
  return out;
}

function parseConstNumber(t: string): number | null {
  const s = t.trim().replace(/_/g, '');
  if (/^[+-]?0x[0-9a-f]+$/i.test(s)) return parseInt(s, 16);
  if (/^[+-]?0b[01]+$/i.test(s)) {
    const neg = s.startsWith('-');
    return parseInt(s.replace(/^[+-]?0b/i, ''), 2) * (neg ? -1 : 1);
  }
  if (/^[+-]?\d+$/.test(s)) return parseInt(s, 10);
  const ch = /^'(\\?.)'$/.exec(s);
  if (ch) return escapeChar(ch[1]!.length === 2 ? ch[1]![1]! : ch[1]!) & 0xff;
  return null;
}

function escapeChar(c: string): number {
  switch (c) {
    case 'n':
      return 10;
    case 't':
      return 9;
    case 'r':
      return 13;
    case '0':
      return 0;
    case 'a':
      return 7;
    case 'b':
      return 8;
    case 'f':
      return 12;
    case 'v':
      return 11;
    case '\\':
      return 0x5c;
    case "'":
      return 0x27;
    case '"':
      return 0x22;
    default:
      return c.charCodeAt(0);
  }
}

function unescapeString(s: string): number[] {
  const out: number[] = [];
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (c === '\\' && i + 1 < s.length) out.push(escapeChar(s[++i]!) & 0xff);
    else out.push(c.charCodeAt(0) & 0xff);
  }
  return out;
}

/**
 * Constant expression evaluator.
 *
 * A recursive-descent parser over integer literals with the C operator
 * precedence, because real assembler output (and our own benchmark kernels)
 * write things like `.word (1 << 20) | 3`, `.balign 1 << 3` and
 * `li t0, 1000 * 60`. The earlier regex folder handled a single `a op b` and
 * silently rejected anything chained or parenthesised.
 *
 * Not supported: symbol arithmetic such as `.word .L2 - .L1`. Those need the
 * relocation machinery to carry an expression instead of a displacement; real
 * toolchain output is consumed as ELF instead (see machine/elf.ts).
 */
function foldConst(src: string, line: number): number {
  const s = src.trim();
  let i = 0;

  const fail = (why: string): never => {
    throw new AsmError(`cannot evaluate constant expression '${src}'` + (why ? `: ${why}` : ''), line);
  };
  const ws = (): void => {
    while (i < s.length && /\s/.test(s[i]!)) i++;
  };
  const eat = (op: string): boolean => {
    ws();
    if (s.startsWith(op, i) && !((op === '>' || op === '<') && false)) {
      i += op.length;
      return true;
    }
    return false;
  };
  const atom = (): number => {
    ws();
    if (s[i] === '(') {
      i++;
      const v = parseOr();
      if (!eat(')')) fail('missing closing parenthesis');
      return v;
    }
    const rest = s.slice(i);
    const m = /^[+-]?(?:0x[0-9a-f]+|0b[01]+|\d+)|^'(?:\\?.)'/.exec(rest);
    if (!m) return fail('expected a number');
    const tok = m[0];
    const v = parseConstNumber(tok);
    if (v === null) return fail('bad numeric literal');
    i += tok.length;
    return v | 0;
  };
  const unary = (): number => {
    ws();
    if (eat('-')) return -unary() | 0;
    if (eat('+')) return unary() | 0;
    if (eat('~')) return ~unary() | 0;
    if (eat('!')) return unary() === 0 ? 1 : 0;
    return atom();
  };
  const parseMul = (): number => {
    let v = unary();
    for (;;) {
      ws();
      if (eat('*')) v = Math.imul(v, unary()) | 0;
      else if (eat('/')) {
        const d = unary();
        v = d === 0 ? 0 : (v / d) | 0;
      } else if (eat('%')) {
        const d = unary();
        v = d === 0 ? 0 : v % d;
      } else return v;
    }
  };
  const parseAdd = (): number => {
    let v = parseMul();
    for (;;) {
      ws();
      if (eat('+')) v = (v + parseMul()) | 0;
      else if (eat('-')) v = (v - parseMul()) | 0;
      else return v;
    }
  };
  const parseShift = (): number => {
    let v = parseAdd();
    for (;;) {
      ws();
      if (s.startsWith('<<', i)) {
        i += 2;
        v = (v << (parseAdd() & 31)) | 0;
      } else if (s.startsWith('>>>', i)) {
        i += 3;
        v = v >>> (parseAdd() & 31);
      } else if (s.startsWith('>>', i)) {
        i += 2;
        v = v >> (parseAdd() & 31);
      } else return v;
    }
  };
  const parseAnd = (): number => {
    let v = parseShift();
    while (eat('&')) v = v & parseShift();
    return v;
  };
  const parseXor = (): number => {
    let v = parseAnd();
    while (eat('^')) v = v ^ parseAnd();
    return v;
  };
  function parseOr(): number {
    let v = parseXor();
    while (eat('|')) v = v | parseXor();
    return v;
  }

  if (!s.length) fail('empty');
  const value = parseOr() | 0;
  ws();
  if (i < s.length) fail(`unexpected trailing input '${s.slice(i)}'`);
  return value;
}

function parseExpr(src: string, line: number): Expr {
  const s = src.trim();
  const reloc = /^%(hi|lo|pcrel_hi|pcrel_lo)\((.*)\)$/i.exec(s);
  if (reloc) {
    const which = reloc[1]!.toLowerCase();
    const inner = reloc[2]!.trim();
    if (which === 'pcrel_hi') return { kind: 'pcrelHi', sym: inner };
    if (which === 'pcrel_lo') return { kind: 'pcrelLo', label: inner };
    const sub = parseExpr(inner, line);
    return which === 'hi' ? { kind: 'hi', inner: sub } : { kind: 'lo', inner: sub };
  }
  if (s === '.') return { kind: 'pc', disp: 0 };
  const sym = /^([A-Za-z_.$][\w.$]*)(?:\s*([+-])\s*(.+))?$/.exec(s);
  if (sym && parseConstNumber(sym[1]!) === null) {
    const name = sym[1]!;
    const disp = sym[2] ? foldConst(sym[3]!, line) * (sym[2] === '-' ? -1 : 1) : 0;
    return { kind: 'sym', name, disp };
  }
  return { kind: 'const', value: foldConst(s, line) };
}

/** `off(reg)` -> offset expression + base register. */
function parseMem(tok: string, line: number): { expr: Expr; reg: number } {
  const m = /^(.*)\(\s*(\w+)\s*\)$/.exec(tok.trim());
  if (!m) throw new AsmError(`expected offset(reg), got '${tok}'`, line);
  return { expr: parseExpr(m[1]!.trim() || '0', line), reg: parseReg(m[2]!, line) };
}

function parseCsr(tok: string, line: number): number {
  const t = tok.trim().toLowerCase();
  if (CSR_ALIASES[t] !== undefined) return CSR_ALIASES[t]!;
  const n = parseConstNumber(t);
  if (n === null || n < 0 || n > 0xfff) throw new AsmError(`bad CSR '${tok}'`, line);
  return n;
}

// ---------------------------------------------------------------------------
// Instruction building
// ---------------------------------------------------------------------------

const AMO_MNEMONICS: Record<string, number> = {
  'amoadd.w': AMO5_ADD,
  'amoswap.w': AMO5_SWAP,
  'lr.w': AMO5_LR,
  'sc.w': AMO5_SC,
  'amoxor.w': AMO5_XOR,
  'amoor.w': AMO5_OR,
  'amoand.w': AMO5_AND,
  'amomin.w': AMO5_MIN,
  'amomax.w': AMO5_MAX,
  'amominu.w': AMO5_MINU,
  'amomaxu.w': AMO5_MAXU,
};

const R_INSNS: Record<string, [number, number]> = {
  add: [F3_ADD, F7_NORMAL],
  sub: [F3_ADD, F7_ALT],
  sll: [F3_SLL, F7_NORMAL],
  slt: [F3_SLT, F7_NORMAL],
  sltu: [F3_SLTU, F7_NORMAL],
  xor: [F3_XOR, F7_NORMAL],
  srl: [F3_SRL, F7_NORMAL],
  sra: [F3_SRL, F7_ALT],
  or: [F3_OR, F7_NORMAL],
  and: [F3_AND, F7_NORMAL],
  mul: [F3_MUL, F7_MULDIV],
  mulh: [F3_MULH, F7_MULDIV],
  mulhsu: [F3_MULHSU, F7_MULDIV],
  mulhu: [F3_MULHU, F7_MULDIV],
  div: [F3_DIV, F7_MULDIV],
  divu: [F3_DIVU, F7_MULDIV],
  rem: [F3_REM, F7_MULDIV],
  remu: [F3_REMU, F7_MULDIV],
};

const I_ARITH: Record<string, number> = {
  addi: F3_ADD,
  slti: F3_SLT,
  sltiu: F3_SLTU,
  xori: F3_XOR,
  ori: F3_OR,
  andi: F3_AND,
};

const SHIFTS: Record<string, number> = { slli: F7_NORMAL, srli: F7_NORMAL, srai: F7_ALT };

const LOADS: Record<string, number> = { lb: F3_B, lh: F3_H, lw: F3_W, lbu: F3_BU, lhu: F3_HU };
const STORES: Record<string, number> = { sb: F3_B, sh: F3_H, sw: F3_W };
const BRANCHES: Record<string, number> = {
  beq: F3_BEQ,
  bne: F3_BNE,
  blt: F3_BLT,
  bge: F3_BGE,
  bltu: F3_BLTU,
  bgeu: F3_BGEU,
};

/** Expand `li rd, imm` the way binutils does (1 or 2 instructions). */
function expandLi(rd_: number, expr: Expr, line: number): Build {
  if (expr.kind === 'const') {
    const v = expr.value | 0;
    if (v >= -2048 && v <= 2047) {
      return { words: [iType(OP_OPI, F3_ADD, rd_, 0, v)], slots: [null] };
    }
    const hi = ((v + 0x800) >> 12) << 12;
    const lo = (v - hi) | 0;
    const words = [uType(OP_LUI, rd_, hi >> 12)];
    const slots: (Slot | null)[] = [null];
    if (lo !== 0) {
      words.push(iType(OP_OPI, F3_ADD, rd_, rd_, lo));
      slots.push(null);
    }
    return { words, slots };
  }
  // Symbolic: absolute address materialisation (lui + addi).
  return {
    words: [uType(OP_LUI, rd_, 0), iType(OP_OPI, F3_ADD, rd_, rd_, 0)],
    slots: [
      { expr: { kind: 'hi', inner: expr }, rel: false },
      { expr: { kind: 'lo', inner: expr }, rel: false },
    ],
  };
}

function buildInsn(mnemRaw: string, ops: string[], line: number): Build {
  const mnem = mnemRaw.toLowerCase();
  const need = (n: number): string[] => {
    if (ops.length !== n) throw new AsmError(`'${mnem}' expects ${n} operand(s), got ${ops.length}`, line);
    return ops;
  };
  const B = (words: number[], slots: (Slot | null)[], pcrelSym?: string): Build => ({
    words,
    slots,
    pcrelSym,
  });

  // ---- pseudo instructions ------------------------------------------------
  switch (mnem) {
    case 'nop':
      need(0);
      return B([iType(OP_OPI, F3_ADD, 0, 0, 0)], [null]);
    case 'mv': {
      need(2);
      return B([iType(OP_OPI, F3_ADD, parseReg(ops[0]!, line), parseReg(ops[1]!, line), 0)], [null]);
    }
    case 'not': {
      need(2);
      return B([iType(OP_OPI, F3_XOR, parseReg(ops[0]!, line), parseReg(ops[1]!, line), -1)], [null]);
    }
    case 'neg': {
      need(2);
      return B([rType(OP_OP, F3_ADD, F7_ALT, parseReg(ops[0]!, line), 0, parseReg(ops[1]!, line))], [null]);
    }
    case 'seqz': {
      need(2);
      return B([iType(OP_OPI, F3_SLTU, parseReg(ops[0]!, line), parseReg(ops[1]!, line), 1)], [null]);
    }
    case 'snez': {
      need(2);
      return B(
        [rType(OP_OP, F3_SLTU, F7_NORMAL, parseReg(ops[0]!, line), 0, parseReg(ops[1]!, line))],
        [null],
      );
    }
    case 'sltz': {
      need(2);
      return B(
        [rType(OP_OP, F3_SLT, F7_NORMAL, parseReg(ops[0]!, line), parseReg(ops[1]!, line), 0)],
        [null],
      );
    }
    case 'sgtz': {
      need(2);
      return B(
        [rType(OP_OP, F3_SLT, F7_NORMAL, parseReg(ops[0]!, line), 0, parseReg(ops[1]!, line))],
        [null],
      );
    }
    case 'li': {
      need(2);
      return expandLi(parseReg(ops[0]!, line), parseExpr(ops[1]!, line), line);
    }
    case 'la': {
      need(2);
      const r = parseReg(ops[0]!, line);
      const e = parseExpr(ops[1]!, line);
      return B(
        [uType(OP_LUI, r, 0), iType(OP_OPI, F3_ADD, r, r, 0)],
        [
          { expr: { kind: 'hi', inner: e }, rel: false },
          { expr: { kind: 'lo', inner: e }, rel: false },
        ],
      );
    }
    case 'lla': {
      need(2);
      const r = parseReg(ops[0]!, line);
      const sym = ops[1]!.trim();
      return B(
        [uType(OP_AUIPC, r, 0), iType(OP_OPI, F3_ADD, r, r, 0)],
        [
          { expr: { kind: 'pcrelHi', sym }, rel: false },
          { expr: { kind: 'pcrelLoBack', back: 4 }, rel: false },
        ],
        sym,
      );
    }
    case 'j': {
      need(1);
      return B([jType(OP_JAL, 0, 0)], [{ expr: parseExpr(ops[0]!, line), rel: true }]);
    }
    case 'jal': {
      if (ops.length === 1) return B([jType(OP_JAL, 1, 0)], [{ expr: parseExpr(ops[0]!, line), rel: true }]);
      need(2);
      return B([jType(OP_JAL, parseReg(ops[0]!, line), 0)], [{ expr: parseExpr(ops[1]!, line), rel: true }]);
    }
    case 'jr': {
      need(1);
      return B([iType(OP_JALR, 0, 0, parseReg(ops[0]!, line), 0)], [null]);
    }
    case 'ret': {
      need(0);
      return B([iType(OP_JALR, 0, 0, 1, 0)], [null]);
    }
    case 'call': {
      need(1);
      const sym = ops[0]!.trim();
      return B(
        [uType(OP_AUIPC, 1, 0), iType(OP_JALR, 0, 1, 1, 0)],
        [
          { expr: { kind: 'pcrelHi', sym }, rel: false },
          { expr: { kind: 'pcrelLoBack', back: 4 }, rel: false },
        ],
        sym,
      );
    }
    case 'tail': {
      need(1);
      const sym = ops[0]!.trim();
      return B(
        [uType(OP_AUIPC, 5, 0), iType(OP_JALR, 0, 0, 5, 0)],
        [
          { expr: { kind: 'pcrelHi', sym }, rel: false },
          { expr: { kind: 'pcrelLoBack', back: 4 }, rel: false },
        ],
        sym,
      );
    }
    case 'beqz': {
      need(2);
      return B(
        [bType(OP_BRANCH, F3_BEQ, parseReg(ops[0]!, line), 0, 0)],
        [{ expr: parseExpr(ops[1]!, line), rel: true }],
      );
    }
    case 'bnez': {
      need(2);
      return B(
        [bType(OP_BRANCH, F3_BNE, parseReg(ops[0]!, line), 0, 0)],
        [{ expr: parseExpr(ops[1]!, line), rel: true }],
      );
    }
    case 'blez': {
      need(2);
      return B(
        [bType(OP_BRANCH, F3_BGE, 0, parseReg(ops[0]!, line), 0)],
        [{ expr: parseExpr(ops[1]!, line), rel: true }],
      );
    }
    case 'bgez': {
      need(2);
      return B(
        [bType(OP_BRANCH, F3_BGE, parseReg(ops[0]!, line), 0, 0)],
        [{ expr: parseExpr(ops[1]!, line), rel: true }],
      );
    }
    case 'bltz': {
      need(2);
      return B(
        [bType(OP_BRANCH, F3_BLT, parseReg(ops[0]!, line), 0, 0)],
        [{ expr: parseExpr(ops[1]!, line), rel: true }],
      );
    }
    case 'bgtz': {
      need(2);
      return B(
        [bType(OP_BRANCH, F3_BLT, 0, parseReg(ops[0]!, line), 0)],
        [{ expr: parseExpr(ops[1]!, line), rel: true }],
      );
    }
    case 'csrr': {
      need(2);
      return B([systemType(F3_CSRRS, parseReg(ops[0]!, line), 0, parseCsr(ops[1]!, line))], [null]);
    }
    case 'csrw': {
      need(2);
      return B([systemType(F3_CSRRW, 0, parseReg(ops[1]!, line), parseCsr(ops[0]!, line))], [null]);
    }
    case 'csrs': {
      need(2);
      return B([systemType(F3_CSRRS, 0, parseReg(ops[1]!, line), parseCsr(ops[0]!, line))], [null]);
    }
    case 'csrc': {
      need(2);
      return B([systemType(F3_CSRRC, 0, parseReg(ops[1]!, line), parseCsr(ops[0]!, line))], [null]);
    }
    case 'csrwi': {
      need(2);
      return B([systemType(F3_CSRRWI, 0, foldConst(ops[1]!, line) & 0x1f, parseCsr(ops[0]!, line))], [null]);
    }
    default:
      break;
  }

  // ---- real instructions --------------------------------------------------
  if (R_INSNS[mnem]) {
    need(3);
    const [f3, f7] = R_INSNS[mnem]!;
    return B(
      [rType(OP_OP, f3, f7, parseReg(ops[0]!, line), parseReg(ops[1]!, line), parseReg(ops[2]!, line))],
      [null],
    );
  }
  if (I_ARITH[mnem] !== undefined) {
    need(3);
    const e = parseExpr(ops[2]!, line);
    if (e.kind === 'const') {
      return B(
        [iType(OP_OPI, I_ARITH[mnem]!, parseReg(ops[0]!, line), parseReg(ops[1]!, line), e.value)],
        [null],
      );
    }
    return B(
      [iType(OP_OPI, I_ARITH[mnem]!, parseReg(ops[0]!, line), parseReg(ops[1]!, line), 0)],
      [{ expr: e, rel: false }],
    );
  }
  if (SHIFTS[mnem] !== undefined) {
    need(3);
    const shamt = foldConst(ops[2]!, line);
    if (shamt < 0 || shamt > 31) throw new AsmError(`shift amount out of range: ${shamt}`, line);
    return B(
      [
        iType(
          OP_OPI,
          mnem === 'slli' ? F3_SLL : F3_SRL,
          parseReg(ops[0]!, line),
          parseReg(ops[1]!, line),
          shamt | (SHIFTS[mnem]! << 5),
        ),
      ],
      [null],
    );
  }
  if (LOADS[mnem] !== undefined) {
    need(2);
    const m = parseMem(ops[1]!, line);
    const word = iType(
      OP_LOAD,
      LOADS[mnem]!,
      parseReg(ops[0]!, line),
      m.reg,
      m.expr.kind === 'const' ? m.expr.value : 0,
    );
    return B([word], [m.expr.kind === 'const' ? null : { expr: m.expr, rel: false }]);
  }
  if (STORES[mnem] !== undefined) {
    need(2);
    const m = parseMem(ops[1]!, line);
    const word = sType(
      OP_STORE,
      STORES[mnem]!,
      m.reg,
      parseReg(ops[0]!, line),
      m.expr.kind === 'const' ? m.expr.value : 0,
    );
    return B([word], [m.expr.kind === 'const' ? null : { expr: m.expr, rel: false }]);
  }
  if (BRANCHES[mnem] !== undefined) {
    need(3);
    return B(
      [bType(OP_BRANCH, BRANCHES[mnem]!, parseReg(ops[0]!, line), parseReg(ops[1]!, line), 0)],
      [{ expr: parseExpr(ops[2]!, line), rel: true }],
    );
  }
  if (mnem === 'lui' || mnem === 'auipc') {
    need(2);
    const r = parseReg(ops[0]!, line);
    const e = parseExpr(ops[1]!, line);
    const op = mnem === 'lui' ? OP_LUI : OP_AUIPC;
    if (e.kind === 'const') return B([uType(op, r, e.value)], [null]);
    return B([uType(op, r, 0)], [{ expr: e, rel: false }], e.kind === 'pcrelHi' ? e.sym : undefined);
  }
  if (mnem === 'jalr') {
    if (ops.length === 1) {
      const m = parseMem(ops[0]!, line);
      return B(
        [iType(OP_JALR, 0, 1, m.reg, m.expr.kind === 'const' ? m.expr.value : 0)],
        [m.expr.kind === 'const' ? null : { expr: m.expr, rel: false }],
      );
    }
    if (ops.length === 2) {
      const r = parseReg(ops[0]!, line);
      const m = parseMem(ops[1]!, line);
      return B(
        [iType(OP_JALR, 0, r, m.reg, m.expr.kind === 'const' ? m.expr.value : 0)],
        [m.expr.kind === 'const' ? null : { expr: m.expr, rel: false }],
      );
    }
    need(3);
    return B(
      [iType(OP_JALR, 0, parseReg(ops[0]!, line), parseReg(ops[2]!, line), foldConst(ops[1]!, line))],
      [null],
    );
  }
  if (mnem === 'fence' || mnem === 'fence.i') {
    const word = iType(OP_MISC_MEM, mnem === 'fence' ? 0 : 1, 0, 0, 0);
    return B([word], [null]);
  }
  if (mnem === 'ecall') return B([systemType(0, 0, 0, F12_ECALL)], [null]);
  if (mnem === 'ebreak') return B([systemType(0, 0, 0, F12_EBREAK)], [null]);
  if (mnem === 'mret') return B([systemType(0, 0, 0, F12_MRET)], [null]);
  if (mnem === 'wfi') return B([systemType(0, 0, 0, F12_WFI)], [null]);

  // ---- A extension (word AMOs), with optional .aq/.rl/.aqrl suffixes ------
  {
    let base = mnem;
    let aq = false;
    let rl = false;
    if (base.endsWith('.aqrl')) {
      aq = rl = true;
      base = base.slice(0, -5);
    } else if (base.endsWith('.aq')) {
      aq = true;
      base = base.slice(0, -3);
    } else if (base.endsWith('.rl')) {
      rl = true;
      base = base.slice(0, -3);
    }
    const f5 = AMO_MNEMONICS[base];
    if (f5 !== undefined) {
      if (base === 'lr.w') {
        need(2);
        const m = parseMem(ops[1]!, line);
        return B([amoType(AMO5_LR, aq, rl, parseReg(ops[0]!, line), m.reg, 0, F3_W)], [null]);
      }
      need(3);
      const m = parseMem(ops[2]!, line);
      return B([amoType(f5, aq, rl, parseReg(ops[0]!, line), m.reg, parseReg(ops[1]!, line), F3_W)], [null]);
    }
  }

  // CSR instructions
  const CSR3: Record<string, number> = { csrrw: F3_CSRRW, csrrs: F3_CSRRS, csrrc: F3_CSRRC };
  const CSR3I: Record<string, number> = { csrrwi: F3_CSRRWI, csrrsi: F3_CSRRSI, csrrci: F3_CSRRCI };
  if (CSR3[mnem] !== undefined) {
    need(3);
    return B(
      [systemType(CSR3[mnem]!, parseReg(ops[0]!, line), parseReg(ops[2]!, line), parseCsr(ops[1]!, line))],
      [null],
    );
  }
  if (CSR3I[mnem] !== undefined) {
    need(3);
    const uimm = foldConst(ops[2]!, line) & 0x1f;
    return B([systemType(CSR3I[mnem]!, parseReg(ops[0]!, line), uimm, parseCsr(ops[1]!, line))], [null]);
  }

  throw new AsmError(`unknown instruction '${mnem}'`, line);
}

// ---------------------------------------------------------------------------
// Driver
// ---------------------------------------------------------------------------

export function assemble(source: string, opts: AssembleOptions = {}): Assembled {
  const base = (opts.base ?? 0) >>> 0;
  const lines = source.split('\n');
  const labels = new Map<string, number>();
  for (const [k, v] of Object.entries(opts.defines ?? {})) labels.set(k, v >>> 0);
  const defines = new Set(Object.keys(opts.defines ?? {}));
  const globals: string[] = [];
  const recs: Rec[] = [];
  /** `%pcrel_hi` sites, keyed by their own address -> symbol. */
  const pcrelSites = new Map<number, string>();

  // ---- pass 0: strip comments, split labels, size every record ------------
  const stmts: Array<{ line: number; text: string }> = [];
  for (let i = 0; i < lines.length; i++) {
    let text = lines[i]!;
    const hash = findComment(text);
    if (hash >= 0) text = text.slice(0, hash);
    text = text.trim();
    if (!text.length) continue;
    let rest = text;
    for (;;) {
      const lm = /^([A-Za-z_.$][\w.$]*):\s*(.*)$/.exec(rest);
      if (!lm) break;
      stmts.push({ line: i + 1, text: `\u0000label ${lm[1]}` });
      rest = lm[2]!.trim();
      if (!rest.length) break;
    }
    if (rest.length) stmts.push({ line: i + 1, text: rest });
  }

  let pc = base;
  const defineLabel = (name: string, addr: number, line: number) => {
    const existing = labels.get(name);
    if (existing !== undefined && !defines.has(name)) throw new AsmError(`duplicate label '${name}'`, line);
    labels.set(name, addr >>> 0);
  };

  for (const st of stmts) {
    const { line, text } = st;
    if (text.startsWith('\u0000label ')) {
      recs.push({ t: 'label', name: text.slice(7), line });
      continue;
    }
    if (text.startsWith('.')) {
      const space = text.search(/\s/);
      const dir = (space < 0 ? text : text.slice(0, space)).toLowerCase();
      const arg = space < 0 ? '' : text.slice(space + 1).trim();
      switch (dir) {
        case '.text':
        case '.data':
        case '.section':
        case '.option':
        case '.file':
        case '.type':
        case '.size':
        case '.ident':
        case '.attribute':
          continue;
        case '.globl':
        case '.global':
          globals.push(arg);
          continue;
        case '.align':
        case '.balign':
        case '.p2align': {
          const n = foldConst(arg, line);
          const to = dir === '.balign' ? n : 1 << n;
          recs.push({ t: 'align', to });
          pc = (pc + ((to - (pc % to)) % to)) >>> 0;
          continue;
        }
        case '.byte':
        case '.half':
        case '.word':
        case '.long': {
          const width = dir === '.byte' ? 1 : dir === '.half' ? 2 : 4;
          for (const part of splitOperands(arg)) {
            const e = parseExpr(part, line);
            if (e.kind === 'const') {
              const bytes: number[] = [];
              for (let b = 0; b < width; b++) bytes.push((e.value >>> (8 * b)) & 0xff);
              recs.push({ t: 'data', line, bytes, slot: null, width, addr: pc });
              pc = (pc + width) >>> 0;
            } else {
              recs.push({ t: 'data', line, bytes: null, slot: { expr: e, rel: false }, width, addr: pc });
              pc = (pc + width) >>> 0;
            }
          }
          continue;
        }
        case '.string':
        case '.asciz':
        case '.ascii': {
          const m = /^"((?:[^"\\]|\\.)*)"$/.exec(arg);
          if (!m) throw new AsmError(`expected a quoted string after ${dir}`, line);
          const bytes = unescapeString(m[1]!);
          if (dir !== '.ascii') bytes.push(0);
          recs.push({ t: 'data', line, bytes, slot: null, width: 1, addr: pc });
          pc = (pc + bytes.length) >>> 0;
          continue;
        }
        case '.zero':
        case '.space':
        case '.skip': {
          const n = foldConst(arg, line);
          recs.push({ t: 'zero', count: n, addr: pc });
          pc = (pc + n) >>> 0;
          continue;
        }
        case '.set':
        case '.equ': {
          const comma = arg.indexOf(',');
          if (comma < 0) throw new AsmError(`expected '.set name, value'`, line);
          const name = arg.slice(0, comma).trim();
          const e = parseExpr(arg.slice(comma + 1), line);
          if (e.kind !== 'const') throw new AsmError(`.set only supports constant values`, line);
          labels.set(name, e.value >>> 0);
          defines.add(name);
          continue;
        }
        default:
          throw new AsmError(`unsupported directive '${dir}'`, line);
      }
    }

    const space = text.search(/\s/);
    const mnem = space < 0 ? text : text.slice(0, space);
    const operandText = space < 0 ? '' : text.slice(space + 1).trim();
    const build = buildInsn(mnem, operandText.length ? splitOperands(operandText) : [], line);
    recs.push({
      t: 'insn',
      line,
      words: build.words,
      slots: build.slots,
      pcrelSym: build.pcrelSym,
      addr: pc,
    });
    pc = (pc + build.words.length * 4) >>> 0;
  }

  const size = pc - base;
  const img = new Uint8Array(size);

  // ---- pass 1: fix up label addresses ------------------------------------
  for (const r of recs) {
    if (r.t === 'label') defineLabel(r.name, currentAddrOf(recs, r, base), r.line);
  }

  // ---- pass 2: resolve expressions and emit bytes -------------------------
  const resolve = (expr: Expr, at: number, line: number): number => {
    switch (expr.kind) {
      case 'const':
        return expr.value | 0;
      case 'sym': {
        const v = labels.get(expr.name);
        if (v === undefined) throw new AsmError(`undefined symbol '${expr.name}'`, line);
        return (v + expr.disp) | 0;
      }
      case 'pc':
        return (at + expr.disp) | 0;
      case 'hi': {
        const v = resolve(expr.inner, at, line);
        return ((v + 0x800) >> 12) << 12;
      }
      case 'lo': {
        const v = resolve(expr.inner, at, line);
        return v - (((v + 0x800) >> 12) << 12);
      }
      case 'pcrelHi': {
        const v = labels.get(expr.sym);
        if (v === undefined) throw new AsmError(`undefined symbol '${expr.sym}'`, line);
        const delta = (v - at) | 0;
        const hi = ((delta + 0x800) >> 12) << 12;
        pcrelSites.set(at >>> 0, expr.sym);
        return hi;
      }
      case 'pcrelLo': {
        const site = labels.get(expr.label);
        if (site === undefined) throw new AsmError(`undefined label '${expr.label}'`, line);
        return pcrelLoAt(site >>> 0, at, line);
      }
      case 'pcrelLoBack':
        return pcrelLoAt((at - expr.back) >>> 0, at, line);
    }
  };

  const pcrelLoAt = (site: number, at: number, line: number): number => {
    const sym = pcrelSites.get(site);
    if (!sym) throw new AsmError(`address 0x${site.toString(16)} is not a %pcrel_hi site`, line);
    const target = labels.get(sym);
    if (target === undefined) throw new AsmError(`undefined symbol '${sym}'`, line);
    const delta = (target - site) | 0;
    const hi = ((delta + 0x800) >> 12) << 12;
    return delta - hi;
  };

  const lineMap: Array<{ line: number; addr: number }> = [];
  for (const r of recs) {
    if (r.t === 'insn') {
      const at = r.addr >>> 0;
      if (r.pcrelSym) pcrelSites.set(at, r.pcrelSym);
      for (let i = 0; i < r.words.length; i++) {
        let word = r.words[i]! >>> 0;
        const slot = r.slots[i];
        if (slot) {
          const wordAddr = (at + i * 4) >>> 0;
          let value = resolve(slot.expr, wordAddr, r.line);
          if (slot.rel) value = (value - wordAddr) | 0;
          word = patchImm(word, value, r.line);
          r.words[i] = word;
        }
        const off = at - base + i * 4;
        img[off] = word & 0xff;
        img[off + 1] = (word >>> 8) & 0xff;
        img[off + 2] = (word >>> 16) & 0xff;
        img[off + 3] = (word >>> 24) & 0xff;
      }
      lineMap.push({ line: r.line, addr: at });
    } else if (r.t === 'data') {
      const off = r.addr - base;
      if (r.slot) {
        const v = resolve(r.slot.expr, r.addr >>> 0, r.line) >>> 0;
        for (let b = 0; b < r.width; b++) img[off + b] = (v >>> (8 * b)) & 0xff;
      } else if (r.bytes) {
        for (let i = 0; i < r.bytes.length; i++) img[off + i] = r.bytes[i]! & 0xff;
      }
    }
  }

  const entrySym = opts.entry ?? (labels.has('_start') ? '_start' : undefined);
  const entry = entrySym !== undefined ? (labels.get(entrySym) ?? base) >>> 0 : base;

  return { bytes: img, base, entry, size, labels: new Map(labels), globals, lineMap };
}

/** Address a label record points at = the address of the next sized record. */
function currentAddrOf(recs: Rec[], label: Rec, base: number): number {
  const idx = recs.indexOf(label);
  for (let i = idx + 1; i < recs.length; i++) {
    const r = recs[i]!;
    if (r.t === 'insn' || r.t === 'data' || r.t === 'zero') return r.addr >>> 0;
  }
  // Trailing label at the very end of the image.
  let max = base;
  for (const r of recs) {
    if (r.t === 'insn') max = Math.max(max, r.addr + r.words.length * 4);
    else if (r.t === 'data') max = Math.max(max, r.addr + (r.bytes ? r.bytes.length : r.width));
    else if (r.t === 'zero') max = Math.max(max, r.addr + r.count);
  }
  return max >>> 0;
}

function patchImm(word: number, value: number, line: number): number {
  try {
    switch (immFormat(word)) {
      case 'U':
        return patchU(word, value);
      case 'I':
        return patchI(word, value);
      case 'S':
        return patchS(word, value);
      case 'B':
        return patchB(word, value);
      case 'J':
        return patchJ(word, value);
    }
  } catch (err) {
    throw new AsmError((err as Error).message, line);
  }
}
