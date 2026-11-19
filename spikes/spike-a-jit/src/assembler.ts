/**
 * Minimal RV64 assembler for the spike. Supports the subset in rv64.ts plus
 * the pseudo-instructions used by the kernels: li, mv, nop, halt,
 * ble/bgt/bleu/bgtu (branch-composition pseudos).
 *
 * Syntax (one instruction per line, `#` comments):
 *   label:
 *     addi  a0, x0, 1
 *     li    a0, 0x1000
 *     blt   t0, t1, label
 * Addresses are byte addresses; entry is always address 0.
 */
import { REG_BY_NAME, OP, encR, encI, encS, encB, encU, encJ, regName } from './rv64.js';

export interface AssembledProgram {
  /** Machine code, 4-byte little-endian words. Entry at offset 0. */
  bytes: Uint8Array;
  /** Label name -> byte address. */
  symbols: Map<string, number>;
}

const IMM32_MIN = -0x8000_0000, IMM32_MAX = 0x7fff_ffff;

function parseNumber(tok: string): bigint {
  const t = tok.trim();
  if (/^-?0x[0-9a-fA-F]+$/.test(t)) {
    const neg = t.startsWith('-');
    const v = BigInt(neg ? t.slice(1) : t);
    return neg ? -v : v;
  }
  if (/^-?[0-9]+$/.test(t)) return BigInt(t);
  throw new Error(`bad number literal: ${tok}`);
}

function reg(tok: string): number {
  const r = REG_BY_NAME[tok.trim().toLowerCase()];
  if (r === undefined) throw new Error(`unknown register: ${tok}`);
  return r;
}

interface RawInstr {
  addr: number;
  text: string;
  line: number;
}

function swapOperandOrder(a: bigint, b: bigint): [bigint, bigint] { return [b, a]; }
void swapOperandOrder;

export function assemble(source: string): AssembledProgram {
  // ---- Pass 1: label resolution + instruction layout ----
  const lines = source.split('\n');
  const labels = new Map<string, number>();
  const raw: RawInstr[] = [];
  let addr = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!.replace(/#.*$/, '').trim();
    if (!line) continue;
    // Extract any leading labels (allow "label:" then instruction on same line).
    let rest = line;
    for (;;) {
      const m = rest.match(/^([A-Za-z_.][\w.]*):/);
      if (!m) break;
      const name = m[1]!;
      if (labels.has(name)) throw new Error(`duplicate label: ${name}`);
      labels.set(name, addr);
      rest = rest.slice(m[0].length).trim();
    }
    if (!rest) continue;
    raw.push({ addr, text: rest, line: i + 1 });
    addr += 4;
  }

  // ---- Pass 2: encoding ----
  const out = new Uint8Array(addr);
  const dv = new DataView(out.buffer);
  const labelAddr = (name: string): number => {
    const a = labels.get(name);
    if (a === undefined) throw new Error(`unknown label: ${name}`);
    return a;
  };

  const parseBranchTarget = (tok: string, fromAddr: number): number => {
    const t = tok.trim();
    if (/^[A-Za-z_.][\w.]*$/.test(t)) return labelAddr(t) - fromAddr;
    return Number(parseNumber(t)); // absolute number treated as relative offset
  };

  for (const ins of raw) {
    const mParts = ins.text.match(/^([^\s]+)\s*(.*)$/)!;
    const opstr = mParts[1]!.toLowerCase();
    const argstr = mParts[2]!.trim();
    const args = argstr ? argstr.split(',').map(s => s.trim()) : [];
    const pc = ins.addr;
    let word: number;

    const need = (n: number) => {
      if (args.length !== n) {
        throw new Error(`line ${ins.line}: '${opstr}' expects ${n} operands, got ${args.length} (${ins.text})`);
      }
    };

    switch (opstr) {
      // ---- R-type ----
      case 'add': case 'sub': case 'xor': case 'or': case 'and':
      case 'sll': case 'srl': case 'sra': case 'slt': case 'sltu':
      case 'mul': case 'div': case 'divu': case 'rem': case 'remu': {
        need(3);
        const rd = reg(args[0]!), rs1 = reg(args[1]!), rs2 = reg(args[2]!);
        const table: Record<string, [number, number]> = {
          add: [0x00, 0x00], sub: [0x20, 0x00],
          sll: [0x00, 0x01], slt: [0x00, 0x02], sltu: [0x00, 0x03],
          xor: [0x00, 0x04], srl: [0x00, 0x05], sra: [0x20, 0x05],
          or:  [0x00, 0x06], and:  [0x00, 0x07],
          mul: [0x01, 0x00], div: [0x01, 0x04], divu: [0x01, 0x05],
          rem: [0x01, 0x06], remu: [0x01, 0x07],
        };
        const [f7, f3] = table[opstr]!;
        word = encR(f7, rs2, rs1, f3, rd, OP.ArithReg);
        break;
      }
      // ---- Arithmetic immediate ----
      case 'addi': case 'slti': case 'sltiu': case 'xori': case 'ori': case 'andi':
      case 'slli': case 'srli': case 'srai': {
        need(3);
        const rd = reg(args[0]!), rs1 = reg(args[1]!);
        const imm = Number(parseNumber(args[2]!));
        const shifts: Record<string, [number, number]> = {
          slli: [0b000000, 0x1], srli: [0b000000, 0x5], srai: [0b010000, 0x5],
        };
        if (opstr in shifts) {
          const [f7, f3] = shifts[opstr]!;
          if (imm < 0 || imm > 63) throw new Error(`line ${ins.line}: shift amount ${imm} out of range`);
          word = encI((f7 << 6) | (imm & 0x3f), rs1, f3, rd, OP.ArithImm);
        } else {
          const f3: Record<string, number> = { addi: 0, slti: 2, sltiu: 3, xori: 4, ori: 6, andi: 7 };
          if (imm < -2048 || imm > 2047) {
            throw new Error(`line ${ins.line}: immediate ${imm} out of 12-bit range (use li/lui)`);
          }
          word = encI(imm, rs1, f3[opstr]!, rd, OP.ArithImm);
        }
        break;
      }
      // ---- Loads ----
      case 'lb': case 'lbu': case 'lh': case 'lhu': case 'lw': case 'lwu': case 'ld': {
        need(2);
        const rd = reg(args[0]!);
        const m = args[1]!.match(/^(-?(?:0x[0-9a-fA-F]+|[0-9]+))\s*\(\s*([A-Za-z_][\w.]*|x\d+)\s*\)$/);
        if (!m) throw new Error(`line ${ins.line}: load syntax: ld rd, imm(rs1), got '${args[1]}'`);
        const imm = Number(parseNumber(m[1]!));
        const rs1 = reg(m[2]!);
        const f3: Record<string, number> = { lb: 0, lh: 1, lw: 2, ld: 3, lbu: 4, lhu: 5, lwu: 6 };
        word = encI(imm, rs1, f3[opstr]!, rd, OP.Load);
        break;
      }
      // ---- Stores ----
      case 'sb': case 'sh': case 'sw': case 'sd': {
        need(2);
        const rs2 = reg(args[0]!);
        const m = args[1]!.match(/^(-?(?:0x[0-9a-fA-F]+|[0-9]+))\s*\(\s*([A-Za-z_][\w.]*|x\d+)\s*\)$/);
        if (!m) throw new Error(`line ${ins.line}: store syntax: sd rs2, imm(rs1), got '${args[1]}'`);
        const imm = Number(parseNumber(m[1]!));
        const rs1 = reg(m[2]!);
        const f3: Record<string, number> = { sb: 0, sh: 1, sw: 2, sd: 3 };
        word = encS(imm, rs2, rs1, f3[opstr]!, OP.Store);
        break;
      }
      // ---- Branches ----
      case 'beq': case 'bne': case 'blt': case 'bge': case 'bltu': case 'bgeu':
      case 'ble': case 'bleu': case 'bgt': case 'bgtu': {
        need(3);
        let rs1 = reg(args[0]!), rs2 = reg(args[1]!);
        let eff = opstr;
        // ble rs1, rs2 == bge rs2, rs1 ; bleu rs1, rs2 == bgeu rs2, rs1 ; bgt==blt swap; bgtu==bltu swap
        if (opstr === 'ble') { eff = 'bge'; [rs1, rs2] = [rs2, rs1]; }
        else if (opstr === 'bleu') { eff = 'bgeu'; [rs1, rs2] = [rs2, rs1]; }
        else if (opstr === 'bgt') { eff = 'blt'; [rs1, rs2] = [rs2, rs1]; }
        else if (opstr === 'bgtu') { eff = 'bltu'; [rs1, rs2] = [rs2, rs1]; }
        const f3: Record<string, number> = { beq: 0, bne: 1, blt: 4, bge: 5, bltu: 6, bgeu: 7 };
        const off = parseBranchTarget(args[2]!, pc);
        word = encB(off, rs2, rs1, f3[eff]!, OP.Branch);
        break;
      }
      // ---- Upper immediates / jumps ----
      case 'lui': case 'auipc': {
        need(2);
        const rd = reg(args[0]!);
        const imm = parseNumber(args[1]!);
        // Operand is the 20-bit signed upper immediate; the assembler
        // positions it at bits 12..31 (single shift). Range-check instead
        // of wrapping: out-of-range upper immediates are almost always a
        // user error.
        if (imm < -0x80000n || imm > 0x7ffffn) {
          throw new Error(`line ${ins.line}: ${opstr} immediate out of 20-bit range: ${imm}`);
        }
        const positioned = (Number(imm & 0xfffffn) << 12) | 0;
        word = encU(positioned >>> 0, rd, opstr === 'lui' ? OP.Lui : OP.Auipc);
        break;
      }
      case 'jal': {
        if (args.length === 1) {
          // jal target (ra implicit)
          const off = parseBranchTarget(args[0]!, pc);
          word = encJ(off, 1, OP.Jal);
        } else if (args.length === 2) {
          const rd = reg(args[0]!);
          const off = parseBranchTarget(args[1]!, pc);
          word = encJ(off, rd, OP.Jal);
        } else {
          throw new Error(`line ${ins.line}: jal expects 1 or 2 operands`);
        }
        break;
      }
      case 'jalr': {
        need(2);
        const rd = reg(args[0]!);
        const m = args[1]!.match(/^(-?(?:0x[0-9a-fA-F]+|[0-9]+))\s*\(\s*([A-Za-z_][\w.]*|x\d+)\s*\)$/);
        if (!m) throw new Error(`line ${ins.line}: jalr syntax: jalr rd, imm(rs1)`);
        word = encI(Number(parseNumber(m[1]!)), reg(m[2]!), 0, rd, OP.Jalr);
        break;
      }
      // ---- Pseudo instructions ----
      case 'mv': {
        need(2);
        word = encI(0, reg(args[1]!), 0, reg(args[0]!), OP.ArithImm);
        break;
      }
      case 'nop': {
        need(0);
        word = encI(0, 0, 0, 0, OP.ArithImm);
        break;
      }
      case 'li': {
        need(2);
        const rd = reg(args[0]!);
        let v = parseNumber(args[1]!);
        // Clamp into signed 64-bit for emission decisions.
        v = BigInt.asIntN(64, v);
        const lo12 = (v & 0x7ffn); // low 12 bits, sign-checked via sext later
        if (v >= -2048n && v <= 2047n) {
          word = encI(Number(v), 0, 0, rd, OP.ArithImm);
        } else if (v >= IMM32_MIN && v <= IMM32_MAX) {
          // lui + addi with sign-fixup
          let lo = Number(v) & 0xfff;
          if (lo >= 0x800) lo -= 0x1000; // sign-extended addi
          const hi = (Number(v) - lo) >> 12;
          // We encode lui inline here by emitting a temporary approach:
          // emit lui as this instruction and stash addi for next word.
          // Simpler: reject — kernels use li only for small constants or lui() directly.
          throw new Error(`line ${ins.line}: li with value ${v} needs lui+addi; use lui explicitly`);
        } else {
          throw new Error(`line ${ins.line}: li with value ${v} out of supported range`);
        }
        break;
      }
      case 'ecall': {
        need(0);
        word = 0x00000073;
        break;
      }
      case 'halt': {
        need(0);
        word = 0x00000073;
        break;
      }
      default:
        throw new Error(`line ${ins.line}: unknown opcode '${opstr}'`);
    }
    dv.setUint32(pc, word >>> 0, true);
  }

  return { bytes: out, symbols: labels };
}

export function disasm(bytes: Uint8Array): string[] {
  // Tiny helper for debugging/tests: shows raw words only.
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const lines: string[] = [];
  for (let a = 0; a < bytes.length; a += 4) {
    lines.push(`${a.toString(16).padStart(8, '0')}  ${(dv.getUint32(a, true) >>> 0).toString(16).padStart(8, '0')}`);
  }
  return lines;
}
