/**
 * Spike A — block compiler: guest basic block → standalone Wasm module.
 *
 * Design (ADR-0002/0003/0004):
 *  - Region-per-module: one module per translated block, cached and reused
 *    so `WebAssembly.Module` compile + instantiate cost is paid once.
 *  - Registers live in the memory footer (regfile), so the host and the
 *    module share state with zero marshalling.
 *  - Wasm has no guard pages: every memory access gets an explicit inline
 *    range/TLB probe; failures return a slow-path sentinel to the host,
 *    which re-executes the instruction on the interpreter (traps, MMU,
 *    atomics, CSRs, ecall...). This is the "explicit TLB check in generated
 *    code" from ADR-0004 and the cost spike A measures.
 *  - Return value: `next_pc` (≥ 0), or `-(pc + 1)` for slow path.
 */

import { decodeAt, isTerminator, type Insn, type Op } from "../isa/decoder.js";
import {
  I32, I64, OP, SEC_CODE, SEC_EXPORT, SEC_FUNCTION, SEC_IMPORT, SEC_TYPE,
  encodeLimits, funcType, memarg, module as buildModule, name, section, sleb, uleb, vec,
} from "./wasm-emit.js";
import type { GuestMemory } from "../memory.js";

export const MAX_BLOCK_INSNS = 64;

/** Instruction classes the Phase 0 block compiler can emit. */
const FAST_OPS = new Set<Op>([
  "lui", "auipc", "jal", "jalr",
  "beq", "bne", "blt", "bge", "bltu", "bgeu",
  "lb", "lh", "lw", "ld", "lbu", "lhu", "lwu",
  "sb", "sh", "sw", "sd",
  "addi", "slti", "sltiu", "xori", "ori", "andi", "slli", "srli", "srai",
  "add", "sub", "sll", "slt", "sltu", "xor", "srl", "sra", "or", "and",
  "mul",
  "fence", // emitted as a no-op
]);

export function isFastOp(op: Op): boolean {
  return FAST_OPS.has(op);
}

export interface CompiledBlock {
  pc: number;
  endPc: number;
  /** Guest instructions compiled into this block (excludes slow tail). */
  insns: number;
  /** PC of the trailing unsupported instruction, if the block ends on one. */
  slowPc: number | null;
  bytes: Uint8Array;
  compileNs: number;
  instantiateNs: number;
  instance: WebAssembly.Instance;
  fn: () => number;
}

export interface CompileStats {
  compileNs: number;
  instantiateNs: number;
}

export class BlockCompileError extends Error {}

const REG = (mem: GuestMemory, r: number): number => mem.regFileOffset + r * 8;

class Emitter {
  readonly code: number[] = [];

  push(...bytes: number[]): void { this.code.push(...bytes); }

  /** i64.load from register r → stack top */
  getReg(mem: GuestMemory, r: number): void {
    // Load address = absolute register-file offset in linear memory.
    this.push(OP.i32_const, ...sleb(BigInt(REG(mem, r))));
    this.push(OP.i64_load, ...memarg(3));
  }

  /** stack: value → register r (wasm stores want [addr, value], value on top) */
  setReg(mem: GuestMemory, r: number): void {
    if (r === 0) { this.push(OP.drop); return; }
    this.push(OP.local_set, 1);                             // value → local 1
    this.push(OP.i32_const, ...sleb(BigInt(REG(mem, r))));  // [addr]
    this.push(OP.local_get, 1);                             // [addr, value]
    this.push(OP.i64_store, ...memarg(3));
  }

  i64const(v: bigint): void {
    this.push(OP.i64_const, ...sleb(v));
  }

  i32const(v: number): void {
    this.push(OP.i32_const, ...sleb(BigInt(v)));
  }

  /** Return the slow-path sentinel for `pc`. */
  slowReturn(pc: number): void {
    this.i32const(-(pc + 1));
    this.push(OP.return);
  }

  /**
   * Inline range probe for the address on the stack.
   * Keeps the address (via local 0) when in range, else returns slow(pc).
   * This is the ADR-0004 explicit bounds/TLB check.
   */
  rangeProbe(mem: GuestMemory, pc: number): void {
    this.push(OP.local_tee, 0); // addr → local0, keep on stack
    this.i64const(BigInt(mem.base));
    this.push(OP.i64_sub);          // rel = addr - base (unsigned wrap covers addr<base)
    this.i64const(BigInt(mem.ramBytes));
    this.push(OP.i64_lt_u);
    this.push(OP.i32_eqz);
    this.push(OP.if, 0x40);         // void block
    this.slowReturn(pc);
    this.push(OP.end);
    // address still on stack? local_tee kept it; slow branch returned; here stack has addr
  }
}

export interface CompileOptions {
  memory: GuestMemory;
  /** Entry physical offset of the block (host offset, = pc - base). */
  offset: number;
}

export function compileBlock(opts: CompileOptions): CompiledBlock {
  const { memory: mem } = opts;
  const startPc = BigInt(mem.base) + BigInt(opts.offset);
  const tCompile0 = performance.now();

  const em = new Emitter();
  let pc = opts.offset;
  const endLimit = mem.ramBytes;
  let insns = 0;
  let slowPc: number | null = null;
  let endPc = Number(startPc);
  const maxOffset = endLimit;

  const bytes = mem.bytes;

  for (;;) {
    if (pc + 4 > maxOffset) {
      // Fell off the end of RAM: hand back a sentinel the host treats as step.
      em.slowReturn(mem.base + pc);
      endPc = mem.base + pc;
      break;
    }
    const insn: Insn = decodeAt(bytes, pc);
    const insnPc = mem.base + pc;
    const pcBig = BigInt(insnPc);

    if (!isFastOp(insn.op)) {
      em.slowReturn(insnPc);
      slowPc = insnPc;
      endPc = insnPc;
      break;
    }

    emitInsn(em, mem, insn, insnPc, pcBig);
    insns++;
    pc += 4;
    endPc = mem.base + pc;

    const endsBlock = insn.op === "jal" || insn.op === "jalr";
    if (endsBlock) break;
    if (insns >= MAX_BLOCK_INSNS) {
      em.i32const(endPc);
      em.push(OP.return);
      break;
    }
    // If the next word isn't decodable code we stop at a fallthrough return.
    if (pc + 4 > maxOffset) {
      em.i32const(endPc);
      em.push(OP.return);
      break;
    }
  }

  em.push(OP.end); // function body

  // ---- assemble module ----
  const memPages = Math.ceil(mem.totalBytes / 65536);
  const typeSec = section(SEC_TYPE, vec([funcType([], [I32])]));
  const importSec = section(SEC_IMPORT, vec([
    [...name("env"), ...name("memory"), 0x02,
      ...encodeLimits(mem.shared ? { min: 0, max: memPages, shared: true } : { min: 0 })],
  ]));
  const funcSec = section(SEC_FUNCTION, vec([[0]]));
  const exportSec = section(SEC_EXPORT, vec([[...name("b"), 0x00, 0x00]]));

  const localsDecl = [...uleb(1), ...uleb(2), I64]; // 2 × i64 temps
  const bodyBytes = [...localsDecl, ...em.code];
  const body = [...uleb(bodyBytes.length), ...bodyBytes];
  const codeSec = section(SEC_CODE, vec([body]));

  const image = buildModule(typeSec, importSec, funcSec, exportSec, codeSec);
  const _tCompiled = performance.now();

  let mod: WebAssembly.Module;
  try {
    mod = new WebAssembly.Module(image);
  } catch (e) {
    const err = new BlockCompileError(`wasm compile failed at pc=0x${insnPcHex(opts.offset, mem.base)}: ${String(e)}`);
    (err as Error & { image?: Uint8Array }).image = image;
    throw err;
  }
  const tModule = performance.now();

  let instance: WebAssembly.Instance;
  try {
    instance = new WebAssembly.Instance(mod, { env: { memory: mem.memory } });
  } catch (e) {
    throw new BlockCompileError(`wasm instantiate failed: ${String(e)}`);
  }
  const tDone = performance.now();

  const fn = instance.exports["b"] as () => number;
  if (typeof fn !== "function") throw new BlockCompileError("missing export b");

  return {
    pc: mem.base + opts.offset,
    endPc,
    insns,
    slowPc,
    bytes: image,
    compileNs: (tModule - tCompile0) * 1e6,
    instantiateNs: (tDone - tModule) * 1e6,
    instance,
    fn,
  };
}

function insnPcHex(offset: number, base: number): string {
  return (base + offset).toString(16);
}

const BRANCH_CMP: Partial<Record<Op, number>> = {
  beq: OP.i64_eq, bne: OP.i64_ne,
  blt: OP.i64_lt_s, bge: OP.i64_ge_s,
  bltu: OP.i64_lt_u, bgeu: OP.i64_ge_u,
};

const LOAD_EXT: Partial<Record<Op, number>> = {
  lb: OP.i64_load8_s, lh: OP.i64_load16_s, lw: OP.i64_load32_s, ld: OP.i64_load,
  lbu: OP.i64_load8_u, lhu: OP.i64_load16_u, lwu: OP.i64_load32_u,
};
const LOAD_ALIGN: Partial<Record<Op, number>> = {
  lb: 0, lbu: 0, lh: 1, lhu: 1, lw: 2, lwu: 2, ld: 3,
};
const STORE_SIZE: Partial<Record<Op, number>> = {
  sb: OP.i64_store8, sh: OP.i64_store16, sw: OP.i64_store32, sd: OP.i64_store,
};
const STORE_ALIGN: Partial<Record<Op, number>> = { sb: 0, sh: 1, sw: 2, sd: 3 };

const ALU2: Partial<Record<Op, number>> = {
  add: OP.i64_add, sub: OP.i64_sub, sll: OP.i64_shl, slt: OP.i64_lt_s,
  sltu: OP.i64_lt_u, xor: OP.i64_xor, srl: OP.i64_shr_u, sra: OP.i64_shr_s,
  or: OP.i64_or, and: OP.i64_and, mul: OP.i64_mul,
};

const ALU_IMM: Partial<Record<Op, number>> = {
  addi: OP.i64_add, xori: OP.i64_xor, ori: OP.i64_or, andi: OP.i64_and,
  slti: OP.i64_lt_s, sltiu: OP.i64_lt_u,
};

function emitInsn(em: Emitter, mem: GuestMemory, insn: Insn, insnPc: number, pcBig: bigint): void {
  switch (insn.op) {
    case "lui":
      em.i64const(insn.imm);
      em.setReg(mem, insn.rd);
      return;
    case "auipc":
      em.i64const(BigInt.asUintN(64, pcBig + insn.imm));
      em.setReg(mem, insn.rd);
      return;
    case "jal":
      if (insn.rd !== 0) {
        em.i64const(BigInt.asUintN(64, pcBig + 4n));
        em.setReg(mem, insn.rd);
      }
      em.i32const(Number(BigInt.asUintN(64, pcBig + insn.imm)));
      em.push(OP.return);
      return;
    case "jalr": {
      const target = em.code; void target;
      // rd = pc + 4
      if (insn.rd !== 0) {
        em.i64const(BigInt.asUintN(64, pcBig + 4n));
        em.setReg(mem, insn.rd);
      }
      // target = (rs1 + imm) & ~1
      em.getReg(mem, insn.rs1);
      em.i64const(insn.imm);
      em.push(OP.i64_add);
      em.i64const(-2n);
      em.push(OP.i64_and);
      em.push(OP.local_tee, 0);
      // probe [base, base+ram)
      em.i64const(BigInt(mem.base));
      em.push(OP.i64_sub);
      em.i64const(BigInt(mem.ramBytes));
      em.push(OP.i64_lt_u);
      em.push(OP.i32_eqz);
      em.push(OP.if, 0x40);
      em.slowReturn(insnPc);
      em.push(OP.end);
      em.push(OP.local_get, 0, OP.i32_wrap_i64);
      em.push(OP.return);
      return;
    }

    case "beq": case "bne": case "blt": case "bge": case "bltu": case "bgeu": {
      em.getReg(mem, insn.rs1);
      em.getReg(mem, insn.rs2);
      em.push(BRANCH_CMP[insn.op]!);
      em.push(OP.if, 0x40);
      em.i32const(Number(BigInt.asUintN(64, pcBig + insn.imm)));
      em.push(OP.return);
      em.push(OP.end);
      return;
    }

    case "lb": case "lh": case "lw": case "ld":
    case "lbu": case "lhu": case "lwu": {
      em.getReg(mem, insn.rs1);
      em.i64const(insn.imm);
      em.push(OP.i64_add);
      em.rangeProbe(mem, insnPc);
      // stack: addr (kept)
      em.push(OP.local_get, 0, OP.i32_wrap_i64);
      em.push(LOAD_EXT[insn.op]!, ...memarg(LOAD_ALIGN[insn.op]!));
      em.setReg(mem, insn.rd);
      return;
    }

    case "sb": case "sh": case "sw": case "sd": {
      // Wasm stores take [addr, value] with value on TOP: compute/probe the
      // address into local 0 first, then push addr and value in that order.
      em.getReg(mem, insn.rs1);
      em.i64const(insn.imm);
      em.push(OP.i64_add);
      em.rangeProbe(mem, insnPc); // addr → local 0, stack empty
      em.push(OP.local_get, 0, OP.i32_wrap_i64); // [addr]
      em.getReg(mem, insn.rs2);                  // [addr, value]
      em.push(STORE_SIZE[insn.op]!, ...memarg(STORE_ALIGN[insn.op]!));
      return;
    }

    case "addi": case "xori": case "ori": case "andi": case "slti": case "sltiu": {
      em.getReg(mem, insn.rs1);
      em.i64const(insn.imm);
      em.push(ALU_IMM[insn.op]!);
      em.setReg(mem, insn.rd);
      return;
    }

    case "slli": case "srli": case "srai": {
      em.getReg(mem, insn.rs1);
      em.i64const(insn.imm & 0x3fn);
      em.push(insn.op === "slli" ? OP.i64_shl : insn.op === "srli" ? OP.i64_shr_u : OP.i64_shr_s);
      em.setReg(mem, insn.rd);
      return;
    }

    case "add": case "sub": case "sll": case "slt": case "sltu":
    case "xor": case "srl": case "sra": case "or": case "and": case "mul": {
      em.getReg(mem, insn.rs1);
      em.getReg(mem, insn.rs2);
      em.push(ALU2[insn.op]!);
      em.setReg(mem, insn.rd);
      return;
    }

    case "fence":
      return; // no-op

    default:
      throw new BlockCompileError(`emit: unsupported op ${insn.op} at pc=${insnPc}`);
  }
}

/** Coverage helper for reports/benchmarks: fraction of RV64IMAZicsr static ops in FAST_OPS. */
export function coverageNote(): { fast: number; total: number } {
  const all: Op[] = [
    "lui", "auipc", "jal", "jalr", "beq", "bne", "blt", "bge", "bltu", "bgeu",
    "lb", "lh", "lw", "ld", "lbu", "lhu", "lwu", "sb", "sh", "sw", "sd",
    "addi", "slti", "sltiu", "xori", "ori", "andi", "slli", "srli", "srai",
    "add", "sub", "sll", "slt", "sltu", "xor", "srl", "sra", "or", "and", "fence", "fence_i",
    "csrrw", "csrrs", "csrrc", "csrrwi", "csrrsi", "csrrci",
    "mul", "mulh", "mulhsu", "mulhu", "div", "divu", "rem", "remu",
    "lr_w", "lr_d", "sc_w", "sc_d",
    "amoswap_w", "amoswap_d", "amoadd_w", "amoadd_d", "amoxor_w", "amoxor_d",
    "amoand_w", "amoand_d", "amoor_w", "amoor_d", "amomin_w", "amomin_d",
    "amomax_w", "amomax_d", "amominu_w", "amominu_d", "amomaxu_w", "amomaxu_d",
    "ecall", "ebreak", "mret", "sret", "wfi", "sfence_vma",
  ];
  const fast = all.filter((op) => isFastOp(op)).length;
  return { fast, total: all.length };
}

export { isTerminator };
