/**
 * Minimal RV64 assembler for Phase 0 tests and benchmark kernels.
 *
 * Supports the interpreter's subset, labels, ABI names, `imm(reg)` memory
 * operands, and pseudo-instructions (`li`, `la`, `mv`, `j`, `call`, ...).
 * `li` materializes any 64-bit constant using only `rd` (11-bit ori chunk
 * chain), so it never clobbers a temp register.
 */

import type { Op } from "./decoder.js";

export const ABI: Record<string, number> = {
  zero: 0, ra: 1, sp: 2, gp: 3, tp: 4,
  t0: 5, t1: 6, t2: 7, s0: 8, fp: 8, s1: 9,
  a0: 10, a1: 11, a2: 12, a3: 13, a4: 14, a5: 15, a6: 16, a7: 17,
  s2: 18, s3: 19, s4: 20, s5: 21, s6: 22, s7: 23,
  s8: 24, s9: 25, s10: 26, s11: 27,
  t3: 28, t4: 29, t5: 30, t6: 31,
};

const REG_RE = /^(x\d+|zero|ra|sp|gp|tp|fp|t\d|s\d|a\d)$/;

export class AsmError extends Error {}

interface Fixup {
  pc: number;
  kind: "b" | "j" | "jal" | "call" | "la_hi" | "la_lo";
  label: string;
  rd: number;
}

export interface AssembleResult {
  image: Uint8Array;
  labels: Record<string, number>;
  entry: number;
  size: number;
}

const R_OPS: Partial<Record<string, { f3: number; f7: number }>> = {
  add: { f3: 0, f7: 0 }, sub: { f3: 0, f7: 0x20 }, sll: { f3: 1, f7: 0 },
  slt: { f3: 2, f7: 0 }, sltu: { f3: 3, f7: 0 }, xor: { f3: 4, f7: 0 },
  srl: { f3: 5, f7: 0 }, sra: { f3: 5, f7: 0x20 }, or: { f3: 6, f7: 0 },
  and: { f3: 7, f7: 0 },
  mul: { f3: 0, f7: 1 }, mulh: { f3: 1, f7: 1 }, mulhsu: { f3: 2, f7: 1 },
  mulhu: { f3: 3, f7: 1 }, div: { f3: 4, f7: 1 }, divu: { f3: 5, f7: 1 },
  rem: { f3: 6, f7: 1 }, remu: { f3: 7, f7: 1 },
};
const I_OPS: Partial<Record<string, number>> = {
  addi: 0, slti: 2, sltiu: 3, xori: 4, ori: 6, andi: 7,
};
const LOAD_OPS: Partial<Record<string, number>> = {
  lb: 0, lh: 1, lw: 2, ld: 3, lbu: 4, lhu: 5, lwu: 6,
};
const STORE_OPS: Partial<Record<string, number>> = { sb: 0, sh: 1, sw: 2, sd: 3 };
const BR_OPS: Partial<Record<string, number>> = {
  beq: 0, bne: 1, blt: 4, bge: 5, bltu: 6, bgeu: 7,
};
const CSR_OPS: Partial<Record<string, number>> = {
  csrrw: 1, csrrs: 2, csrrc: 3, csrrwi: 5, csrrsi: 6, csrrci: 7,
};
const AMO_F5: Partial<Record<string, number>> = {
  amoadd: 0x00, amoswap: 0x01, lr: 0x02, sc: 0x03, amoxor: 0x04,
  amoor: 0x08, amoand: 0x0c, amomin: 0x10, amomax: 0x14,
  amominu: 0x18, amomaxu: 0x1c,
};

const W = (v: number): number => v >>> 0;
const encR = (op: number, f3: number, f7: number, rd: number, rs1: number, rs2: number): number =>
  W((f7 << 25) | (rs2 << 20) | (rs1 << 15) | (f3 << 12) | (rd << 7) | op);
const encI = (op: number, f3: number, rd: number, rs1: number, imm: number): number =>
  W(((imm & 0xfff) << 20) | (rs1 << 15) | (f3 << 12) | (rd << 7) | op);
const encS = (op: number, f3: number, rs1: number, rs2: number, imm: number): number => {
  const i = imm & 0xfff;
  return W((((i >> 5) & 0x7f) << 25) | (rs2 << 20) | (rs1 << 15) | (f3 << 12) | ((i & 0x1f) << 7) | op);
};
const encB = (op: number, f3: number, rs1: number, rs2: number, imm: number): number => {
  const i = imm & 0x1fff;
  return W(
    ((((i >> 12) & 1) << 31) | (((i >> 5) & 0x3f) << 25) | (rs2 << 20) | (rs1 << 15) |
      (f3 << 12) | (((i >> 1) & 0xf) << 8) | (((i >> 11) & 1) << 7) | op),
  );
};
const encU = (op: number, rd: number, imm: number): number =>
  W((imm & 0xfffff000) | (rd << 7) | op);
const encJ = (op: number, rd: number, imm: number): number => {
  const i = imm & 0x1fffff;
  return W(
    ((((i >> 20) & 1) << 31) | (((i >> 1) & 0x3ff) << 21) | (((i >> 11) & 1) << 20) |
      (((i >> 12) & 0xff) << 12) | (rd << 7) | op),
  );
};

function reg(tok: string): number {
  const t = tok.trim();
  if (t.startsWith("x") && /^x\d+$/.test(t)) {
    const n = Number(t.slice(1));
    if (n >= 0 && n < 32) return n;
    throw new AsmError(`bad register: "${tok}"`);
  }
  if (!REG_RE.test(t)) throw new AsmError(`bad register: "${tok}"`);
  const r = ABI[t];
  if (r === undefined) throw new AsmError(`bad register: "${tok}"`);
  return r;
}

const MEM_RE = /^(-?\w+)?\s*\(\s*(\w+)\s*\)$/;
function parseMem(tok: string): { imm: number; rs1: number } | null {
  const m = MEM_RE.exec(tok.trim());
  if (!m) return null;
  const immTok = m[1];
  const imm = immTok === undefined ? 0 : (/^-?\d+$/.test(immTok) ? Number(immTok) : Number(BigInt(immTok)));
  return { imm, rs1: reg(m[2]!) };
}

function splitOperands(s: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = "";
  for (const ch of s) {
    if (ch === "(") depth++;
    if (ch === ")") depth--;
    if (ch === "," && depth === 0) { out.push(cur.trim()); cur = ""; }
    else cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

function parseIntel(v: string): bigint {
  const t = v.trim();
  if (/^-?0x[0-9a-fA-F_]+$/.test(t)) {
    const neg = t.startsWith("-");
    const mag = BigInt(t.replace(/^-/, "").replace(/_/g, ""));
    return neg ? -mag : mag;
  }
  if (/^-?\d+$/.test(t)) return BigInt(t);
  throw new AsmError(`bad integer: "${v}"`);
}

/** CSR names accepted in CSR instructions (subset; numbers always allowed). */
export const CSR_NAMES: Record<string, number> = {
  cycle: 0xc00, time: 0xc01, instret: 0xc02,
  sstatus: 0x100, sie: 0x104, stvec: 0x105, sscratch: 0x140,
  sepc: 0x141, scause: 0x142, stval: 0x143, sip: 0x144, satp: 0x180,
  mstatus: 0x300, misa: 0x301, medeleg: 0x302, mideleg: 0x303,
  mie: 0x304, mtvec: 0x305, mscratch: 0x340, mepc: 0x341,
  mcause: 0x342, mtval: 0x343, mip: 0x344,
  mcycle: 0xb00, minstret: 0xb02, mhartid: 0xf14,
  fflags: 0x001, frm: 0x002, fcsr: 0x003,
};

function parseCsr(v: string): number {
  const t = v.trim();
  const named = CSR_NAMES[t.toLowerCase()];
  if (named !== undefined) return named;
  return Number(parseIntel(t)) & 0xfff;
}

/**
 * Materialize any 64-bit constant into `rd` alone.
 * Splits the value into 11-bit chunks (always positive → `ori` is safe) and
 * folds them from the most-significant chunk down.
 */
export function materialize64(rd: number, value: bigint): number[] {
  const v = BigInt.asUintN(64, value);
  const words: number[] = [];
  const CHUNK = 11;
  const totalChunks = Math.ceil(64 / CHUNK); // 6
  const chunks: number[] = [];
  for (let i = totalChunks - 1; i >= 0; i--) {
    chunks.push(Number((v >> BigInt(i * CHUNK)) & 0x7ffn));
  }
  // chunks[0] is the most-significant chunk (may be < 2048 always)
  words.push(encI(0x13, 0, rd, 0, chunks[0]!)); // addi rd, zero, c0
  for (let i = 1; i < chunks.length; i++) {
    words.push(encI(0x13, 1, rd, rd, CHUNK)); // slli rd, rd, 11
    const c = chunks[i]!;
    if (c !== 0) words.push(encI(0x13, 6, rd, rd, c)); // ori rd, rd, c
  }
  return words;
}

/** Materialize a signed 32-bit constant into `rd` (lui+addi, sign-extended). */
function materialize32s(rd: number, value: number): number[] {
  const v = value | 0;
  if (v >= -2048 && v <= 2047) return [encI(0x13, 0, rd, 0, v)];
  const lo = v & 0xfff;
  const loAdj = lo >= 2048 ? lo - 4096 : lo;
  const hiAdj = ((v - loAdj) >>> 12) & 0xfffff;
  // lui+addi cannot represent positive values in [0x7ffff800, 0x7fffffff]
  // (the carry flips bit 31 and lui sign-extends). Fall back to the chunked
  // 64-bit materializer for that 2 KiB gap — zero-extension equals the value.
  if (v >= 0x7ffff800) return materialize64(rd, BigInt(v >>> 0));
  const words: number[] = [];
  if (hiAdj !== 0) words.push(encU(0x37, rd, hiAdj << 12));
  else words.push(encI(0x13, 0, rd, 0, 0)); // ensure rd is defined
  if (hiAdj !== 0 || loAdj !== 0) words.push(encI(0x13, 0, rd, hiAdj !== 0 ? rd : 0, loAdj));
  return words;
}

type Item =
  | { kind: "insn"; pc: number; size: number; word?: number }
  | { kind: "bytes"; pc: number; data: number[] };

export function assemble(source: string, opts?: { base?: number }): AssembleResult {
  const base = opts?.base ?? 0;
  const items: Item[] = [];
  const labels: Record<string, number> = {};
  /** Numeric local labels (`1:`, `2:` ...) in definition order, for `1f`/`1b`. */
  const numbered = new Map<number, number[]>();
  const fixups: Fixup[] = [];
  const brInfo = new Map<number, { op: Op; rs1: number; rs2: number }>();
  const laLo = new Map<number, { label: string; rd: number }>();
  let pc = base;

  const lines = source.split(/\r?\n/);
  for (let ln = 0; ln < lines.length; ln++) {
    let line = lines[ln]!;
    const c1 = line.search(/[#;]/);
    if (c1 >= 0) line = line.slice(0, c1);
    line = line.trim();
    if (!line) continue;

    for (;;) {
      const num = /^(\d+)\s*:/.exec(line);
      if (num) {
        const n = Number(num[1]);
        const list = numbered.get(n) ?? [];
        list.push(pc);
        numbered.set(n, list);
        line = line.slice(num[0].length).trim();
        if (!line) break;
        continue;
      }
      const m = /^([A-Za-z_.$][\w.$]*)\s*:/.exec(line);
      if (!m) break;
      labels[m[1]!] = pc;
      line = line.slice(m[0].length).trim();
      if (!line) break;
    }
    if (!line) continue;

    const ws = line.indexOf(" ");
    const mnem = (ws < 0 ? line : line.slice(0, ws)).toLowerCase();
    const rest = ws < 0 ? "" : line.slice(ws + 1).trim();
    const ops = splitOperands(rest);
    const at = pc;
    const err = (msg: string): AsmError => new AsmError(`line ${ln + 1}: ${msg}`);

    const emit = (word: number): void => { items.push({ kind: "insn", pc, size: 4, word }); pc += 4; };
    const emitHole = (size = 4): void => { items.push({ kind: "insn", pc, size }); pc += size; };

    if (mnem.startsWith(".")) {
      switch (mnem) {
        case ".text": case ".data": case ".globl": case ".global": case ".section": break;
        case ".align": case ".balign": {
          const n = Number(rest.split(/\s+/)[0]);
          const align = mnem === ".align" ? 1 << n : n;
          while (pc % align !== 0) { items.push({ kind: "bytes", pc, data: [0] }); pc += 1; }
          break;
        }
        case ".word": case ".dword": case ".quad": {
          const size = mnem === ".word" ? 4 : 8;
          for (const t of splitOperands(rest)) {
            const v = parseIntel(t);
            const data: number[] = [];
            for (let i = 0; i < size; i++) data.push(Number((v >> BigInt(8 * i)) & 0xffn));
            items.push({ kind: "bytes", pc, data });
            pc += size;
          }
          break;
        }
        case ".ascii": case ".asciiz": case ".string": {
          const m = /^"((?:[^"\\]|\\.)*)"$/.exec(rest);
          if (!m) throw err("bad string literal");
          const text = JSON.parse(`"${m[1]}"`) as string;
          const data = [...new TextEncoder().encode(text)];
          if (mnem !== ".ascii") data.push(0);
          items.push({ kind: "bytes", pc, data });
          pc += data.length;
          break;
        }
        case ".space": case ".zero": {
          const n = Number(rest.split(/\s+/)[0]);
          items.push({ kind: "bytes", pc, data: new Array(n).fill(0) });
          pc += n;
          break;
        }
        default: throw err(`unknown directive ${mnem}`);
      }
      continue;
    }

    // pseudo-instructions
    switch (mnem) {
      case "nop": emit(encI(0x13, 0, 0, 0, 0)); continue;
      case "ret": emit(encI(0x67, 0, 0, 1, 0)); continue;
      case "mv": emit(encI(0x13, 0, reg(ops[0]!), reg(ops[1]!), 0)); continue;
      case "not": emit(encI(0x13, 4, reg(ops[0]!), reg(ops[1]!), -1)); continue;
      case "neg": emit(encR(0x33, 0, 0x20, reg(ops[0]!), 0, reg(ops[1]!))); continue;
      case "seqz": emit(encI(0x13, 3, reg(ops[0]!), reg(ops[1]!), 1)); continue;
      case "snez": emit(encR(0x33, 3, 0, reg(ops[0]!), 0, reg(ops[1]!))); continue;
      case "sltz": emit(encR(0x33, 2, 0, reg(ops[0]!), reg(ops[1]!), 0)); continue;
      case "sgtz": emit(encR(0x33, 2, 0, reg(ops[0]!), 0, reg(ops[1]!))); continue;
      case "j": fixups.push({ pc: at, kind: "j", label: ops[0]!, rd: 0 }); emitHole(); continue;
      case "jal":
        if (ops.length === 1) { fixups.push({ pc: at, kind: "jal", label: ops[0]!, rd: 1 }); }
        else { fixups.push({ pc: at, kind: "jal", label: ops[1]!, rd: reg(ops[0]!) }); }
        emitHole(); continue;
      case "call": fixups.push({ pc: at, kind: "call", label: ops[0]!, rd: 1 }); emitHole(); continue;
      case "beqz": case "bnez": case "bltz": case "bgez": case "bgtz": case "blez": {
        const map: Record<string, [Op, boolean]> = {
          beqz: ["beq", true], bnez: ["bne", true],
          bltz: ["blt", true], bgez: ["bge", true],
          bgtz: ["bge", false], blez: ["blt", false],
        };
        const [op, rs1First] = map[mnem]!;
        fixups.push({ pc: at, kind: "b", label: ops[1]!, rd: 0 });
        brInfo.set(at, { op, rs1: reg(ops[0]!), rs2: rs1First ? 0 : reg(ops[0]!) });
        // For bgtz/blez semantics with single reg: bge rs1, zero / blt rs1, zero — fixed below.
        if (!rs1First) brInfo.set(at, { op, rs1: reg(ops[0]!), rs2: 0 });
        emitHole(); continue;
      }
      case "li": {
        const rd = reg(ops[0]!);
        const v = parseIntel(ops[1]!);
        if (v >= -2147483648n && v <= 2147483647n) {
          for (const w of materialize32s(rd, Number(v))) emit(w);
        } else {
          for (const w of materialize64(rd, v)) emit(w);
        }
        continue;
      }
      case "la": {
        const rd = reg(ops[0]!);
        fixups.push({ pc: at, kind: "la_hi", label: ops[1]!, rd });
        laLo.set(at, { label: ops[1]!, rd });
        emitHole(); // auipc
        emitHole(); // addi
        continue;
      }
      case "csrr": { // csrr rd, csr → csrrs rd, csr, x0
        emit(encI(0x73, 2, reg(ops[0]!), 0, parseCsr(ops[1]!)));
        continue;
      }
      case "csrw": { // csrw csr, rs → csrrw x0, csr, rs
        emit(encI(0x73, 1, 0, reg(ops[1]!), parseCsr(ops[0]!)));
        continue;
      }
      case "csrs": {
        emit(encI(0x73, 2, 0, reg(ops[1]!), parseCsr(ops[0]!)));
        continue;
      }
      case "csrc": {
        emit(encI(0x73, 3, 0, reg(ops[1]!), parseCsr(ops[0]!)));
        continue;
      }
      case "csrwi": {
        emit(W((parseCsr(ops[0]!) << 20) | ((Number(parseIntel(ops[1]!)) & 0x1f) << 15) | (5 << 12) | (0 << 7) | 0x73));
        continue;
      }
      case "ecall": emit(0x00000073); continue;
      case "ebreak": emit(0x00100073); continue;
      case "mret": emit(0x30200073); continue;
      case "sret": emit(0x10200073); continue;
      case "wfi": emit(0x10500073); continue;
      case "fence": emit(0x0ff0000f); continue;
      case "fence.i": emit(0x0000100f); continue;
      case "sfence.vma": emit(0x12000073); continue;
      default: break;
    }

    if (mnem === "lui" || mnem === "auipc") {
      const imm = parseIntel(ops[1]!);
      emit(encU(mnem === "lui" ? 0x37 : 0x17, reg(ops[0]!), Number(BigInt.asIntN(32, imm))));
      continue;
    }
    if (mnem === "jalr") {
      if (ops.length === 2) {
        const mem = parseMem(ops[1]!);
        if (!mem) throw err("bad jalr operand");
        emit(encI(0x67, 0, reg(ops[0]!), mem.rs1, mem.imm));
      } else if (ops.length === 3) {
        emit(encI(0x67, 0, reg(ops[0]!), reg(ops[1]!), Number(parseIntel(ops[2]!))));
      } else throw err("bad jalr operand count");
      continue;
    }
    if (LOAD_OPS[mnem] !== undefined) {
      const mem = parseMem(ops[1] ?? "");
      if (!mem) throw err("bad memory operand");
      emit(encI(0x03, LOAD_OPS[mnem]!, reg(ops[0]!), mem.rs1, mem.imm));
      continue;
    }
    if (STORE_OPS[mnem] !== undefined) {
      const mem = parseMem(ops[1] ?? "");
      if (!mem) throw err("bad memory operand");
      emit(encS(0x23, STORE_OPS[mnem]!, mem.rs1, reg(ops[0]!), mem.imm));
      continue;
    }
    if (BR_OPS[mnem] !== undefined) {
      if (ops.length !== 3) throw err("branch needs 3 operands");
      fixups.push({ pc: at, kind: "b", label: ops[2]!, rd: 0 });
      brInfo.set(at, { op: mnem as Op, rs1: reg(ops[0]!), rs2: reg(ops[1]!) });
      emitHole(); continue;
    }
    if (I_OPS[mnem] !== undefined) {
      emit(encI(0x13, I_OPS[mnem]!, reg(ops[0]!), reg(ops[1]!), Number(parseIntel(ops[2]!))));
      continue;
    }
    if (mnem === "slli" || mnem === "srli" || mnem === "srai") {
      const sh = Number(parseIntel(ops[2]!)) & 0x3f;
      const f6 = mnem === "srai" ? 0x10 : 0x00;
      emit(encI(0x13, mnem === "slli" ? 1 : 5, reg(ops[0]!), reg(ops[1]!), (f6 << 6) | sh));
      continue;
    }
    if (R_OPS[mnem] !== undefined) {
      const f = R_OPS[mnem]!;
      emit(encR(0x33, f.f3, f.f7, reg(ops[0]!), reg(ops[1]!), reg(ops[2]!)));
      continue;
    }
    if (CSR_OPS[mnem] !== undefined) {
      const csr = parseCsr(ops[1]!);
      const isImm = mnem.endsWith("i");
      const f3 = CSR_OPS[mnem]!;
      if (isImm) {
        const uimm = Number(parseIntel(ops[2]!)) & 0x1f;
        emit(W((csr << 20) | (uimm << 15) | (f3 << 12) | (reg(ops[0]!) << 7) | 0x73));
      } else {
        emit(encI(0x73, f3, reg(ops[0]!), reg(ops[2]!), csr));
      }
      continue;
    }
    const amoMatch = /^(lr|sc|amo\w+)\.(w|d)$/.exec(mnem);
    if (amoMatch) {
      const baseName = amoMatch[1]!;
      const width = amoMatch[2]!;
      const f5 = AMO_F5[baseName];
      if (f5 === undefined) throw err(`bad amo ${mnem}`);
      const f3 = width === "w" ? 2 : 3;
      if (baseName === "lr") {
        const mem = parseMem(ops[1] ?? "");
        if (!mem) throw err("bad lr operand");
        emit(W((f5 << 27) | (mem.rs1 << 15) | (f3 << 12) | (reg(ops[0]!) << 7) | 0x2f));
      } else if (baseName === "sc") {
        const mem = parseMem(ops[2] ?? "");
        if (!mem) throw err("bad sc operand");
        emit(W((f5 << 27) | (reg(ops[1]!) << 20) | (mem.rs1 << 15) | (f3 << 12) | (reg(ops[0]!) << 7) | 0x2f));
      } else {
        const mem = parseMem(ops[2] ?? "");
        if (!mem) throw err("bad amo operand");
        emit(W((f5 << 27) | (reg(ops[1]!) << 20) | (mem.rs1 << 15) | (f3 << 12) | (reg(ops[0]!) << 7) | 0x2f));
      }
      continue;
    }

    throw err(`unknown mnemonic "${mnem}"`);
  }

  // ---- resolve ----
  let maxPc = base;
  for (const it of items) maxPc = Math.max(maxPc, it.pc + (it.kind === "insn" ? it.size : it.data.length));
  const image = new Uint8Array(Math.max(0, maxPc - base));
  const view = new DataView(image.buffer);
  const putWord = (wpc: number, w: number): void => view.setUint32(wpc - base, w >>> 0, true);
  const resolve = (label: string, at: number): number => {
    const local = /^(\d+)([fb])$/.exec(label);
    if (local) {
      const n = Number(local[1]);
      const positions = numbered.get(n) ?? [];
      if (local[2] === "f") {
        const next = positions.find((p) => p > at);
        if (next === undefined) throw new AsmError(`undefined label "${label}" (referenced at pc ${at})`);
        return next;
      }
      let prev: number | undefined;
      for (const p of positions) { if (p <= at) prev = p; else break; }
      if (prev === undefined) throw new AsmError(`undefined label "${label}" (referenced at pc ${at})`);
      return prev;
    }
    const t = labels[label];
    if (t === undefined) throw new AsmError(`undefined label "${label}" at pc ${at}`);
    return t;
  };

  for (const it of items) {
    if (it.kind === "bytes") image.set(it.data, it.pc - base);
    else if (it.word !== undefined) putWord(it.pc, it.word);
  }

  for (const f of fixups) {
    const target = resolve(f.label, f.pc);
    const rel = target - f.pc;
    switch (f.kind) {
      case "b": {
        const info = brInfo.get(f.pc);
        if (!info) throw new AsmError(`missing branch info at ${f.pc}`);
        putWord(f.pc, encB(0x63, BR_OPS[info.op]!, info.rs1, info.rs2, rel));
        break;
      }
      case "j": putWord(f.pc, encJ(0x6f, 0, rel)); break;
      case "jal": putWord(f.pc, encJ(0x6f, f.rd, rel)); break;
      case "call": putWord(f.pc, encJ(0x6f, 1, rel)); break;
      case "la_hi": {
        const hi = Number(BigInt.asIntN(32, (BigInt(rel) + 0x800n) & ~0xfffn));
        putWord(f.pc, encU(0x17, f.rd, hi));
        break;
      }
      case "la_lo": break;
    }
  }
  for (const [auipcPc, info] of laLo) {
    const f = fixups.find((x) => x.pc === auipcPc && x.kind === "la_hi");
    if (!f) continue;
    const target = resolve(info.label, auipcPc);
    const rel = BigInt(target - auipcPc);
    const hi = BigInt.asIntN(32, (rel + 0x800n) & ~0xfffn);
    const lo = Number(rel - hi);
    putWord(auipcPc + 4, encI(0x13, 0, info.rd, info.rd, lo));
    void f;
  }

  return { image, labels, entry: labels["start"] ?? base, size: image.byteLength };
}
