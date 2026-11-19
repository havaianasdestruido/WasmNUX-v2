/**
 * Spike A JIT: translates RV64 (subset) machine code into a WebAssembly module,
 * one Wasm "region" per function with in-function `br_table`-style dispatch
 * between basic blocks (validates ADR-0003's region-per-module design).
 *
 * Guest model:
 *   - 32 x i64 Wasm locals for the integer register file (x0 reads fold to 0).
 *   - Guest RAM = an imported WebAssembly.Memory ("env"."mem"), memory32.
 *   - A Wasm local `$b` (i32) holds the current block index; every terminator
 *     sets it to a compile-time constant and branches to the dispatch loop.
 *   - `ecall` branches to $stop; "jalr" traps (unsupported in this subset).
 *
 * Entry is block index 0 (address 0). `run()` returns a0 (x10) at halt.
 */
import binaryen from 'binaryen';
import { OP, field } from './rv64.js';

type Module = binaryen.Module;
type Expr = binaryen.ExpressionRef;
type Type = binaryen.Type;

export interface CompileOptions {
  /** Minimum pages of the imported guest memory (64 KiB each). */
  memoryPages: number;
  /** Run binaryen's optimize pipeline before emitting. */
  optimize: boolean;
}

export interface CompiledRegion {
  wasmBinary: Uint8Array<ArrayBuffer>;
  validate: boolean;
  blockCount: number;
  emitMilliseconds: number;
  optimized: boolean;
}

const X0 = 0;
const BINDEX = 32; // local index of $b

interface Block {
  addr: number;
  endAddr: number;
  index: number;
}

const TERM_BRANCH = new Set<number>([OP.Branch, OP.Jal]);

export function compileToWasm(program: Uint8Array, opts: CompileOptions): CompiledRegion {
  const t0 = process.hrtime.bigint();
  const dv = new DataView(program.buffer, program.byteOffset, program.byteLength);
  const wordAt = (a: number) => dv.getUint32(a, true) >>> 0;
  const numWords = program.length >>> 2;
  if (numWords === 0) throw new Error('empty program');

  // ---- Block discovery ----
  const leaders = new Set<number>([0]);
  const isTermAt = (a: number): boolean => {
    if (a >= program.length) return false;
    const w = wordAt(a);
    const op = field.opcode(w);
    return TERM_BRANCH.has(op) || field.isEcall(w);
  };
  for (let a = 0; a < program.length; a += 4) {
    const w = wordAt(a);
    const op = field.opcode(w);
    if (field.isEcall(w)) { if (a + 4 < program.length) leaders.add(a + 4); continue; }
    if (op === OP.Branch || op === OP.Jal) {
      const off = op === OP.Branch ? Number(field.immB(w)) : Number(field.immJ(w));
      const target = a + off;
      if (target < 0 || target >= program.length || target % 4 !== 0) {
        throw new Error(`branch target 0x${target.toString(16)} out of bounds at 0x${a.toString(16)}`);
      }
      leaders.add(target);
      if (a + 4 < program.length) leaders.add(a + 4);
    }
  }
  const sorted = [...leaders].sort((x, y) => x - y);
  const blocks: Block[] = sorted.map((addr, i) => {
    const endAddr = i + 1 < sorted.length ? sorted[i + 1]! : program.length;
    return { addr, endAddr, index: i };
  });
  const blockIndexOf = new Map<number, number>(blocks.map(b => [b.addr, b.index]));

  // ---- Module emission ----
  const b = new binaryen.Module();
  // Features.Atomics enables the threads proposal (required for shared memory).
  b.setFeatures(binaryen.Features.Atomics + binaryen.Features.BulkMemory + binaryen.Features.SignExt);
  // Shared memory defined in-module and exported; shared memories require
  // an explicit maximum. Exporting keeps the door open for cross-worker
  // sharing in Spike B (postMessage of the Memory object).
  b.setMemory(opts.memoryPages, Math.max(opts.memoryPages, 4096), 'mem', [], true, false, 'mem');
  const i64 = binaryen.i64, i32 = binaryen.i32;
  const locals: Type[] = [];
  for (let i = 0; i < 32; i++) locals.push(i64);
  locals.push(i32); // $b

  const getReg = (r: number): Expr => r === X0 ? b.i64.const(0, 0) : b.local.get(r, i64);
  const setReg = (r: number, v: Expr): Expr | null =>
    r === X0 ? null : b.local.set(r, v);
  const setB = (idx: number): Expr => b.local.set(BINDEX, b.i32.const(idx));
  const i64c = (v: bigint): Expr => {
    const u = BigInt.asUintN(64, v);
    return b.i64.const(Number(u & 0xffffffffn), Number((u >> 32n) & 0xffffffffn));
  };
  const effAddr = (rs1: number, imm: bigint): Expr =>
    b.i32.wrap(b.i64.add(getReg(rs1), i64c(imm)));

  const translateTermBlock = (blk: Block): Expr[] => {
    const exprs: Expr[] = [];
    const w = wordAt(blk.endAddr - 4);
    const pc = blk.endAddr - 4;
    const op = field.opcode(w);
    if (field.isEcall(w)) { exprs.push(b.br('$stop')); return exprs; }
    if (op === OP.Jal) {
      const off = Number(field.immJ(w));
      const target = blockIndexOf.get(pc + off);
      if (target === undefined) throw new Error(`jal target 0x${(pc + off).toString(16)} is not a block boundary`);
      const setRa = setReg(field.rd(w), i64c(BigInt(pc + 4)));
      if (setRa) exprs.push(setRa);
      exprs.push(setB(target), b.br('$top'));
      return exprs;
    }
    if (op === OP.Branch) {
      const rs1 = field.rs1(w), rs2 = field.rs2(w), f3 = field.funct3(w);
      const off = Number(field.immB(w));
      const taken = blockIndexOf.get(pc + off);
      const fall = blockIndexOf.get(pc + 4);
      if (taken === undefined || fall === undefined) {
        throw new Error(`branch target 0x${(pc + off).toString(16)} is not a block boundary at 0x${pc.toString(16)}`);
      }
      const a = getReg(rs1), rhs = getReg(rs2);
      let cond: Expr;
      switch (f3) {
        case 0x0: cond = b.i64.eq(a, rhs); break;
        case 0x1: cond = b.i64.ne(a, rhs); break;
        case 0x4: cond = b.i64.lt_s(a, rhs); break;
        case 0x5: cond = b.i64.ge_s(a, rhs); break;
        case 0x6: cond = b.i64.lt_u(a, rhs); break;
        case 0x7: cond = b.i64.ge_u(a, rhs); break;
        default: throw new Error(`unsupported branch funct3 ${f3}`);
      }
      exprs.push(b.if(cond,
        b.block(null, [setB(taken)]),
        b.block(null, [setB(fall)]),
      ));
      exprs.push(b.br('$top'));
      return exprs;
    }
    // fall-through block: jump to next block (or halt at end of program)
    const next = blockIndexOf.get(blk.endAddr);
    if (next === undefined) { exprs.push(b.br('$stop')); } else { exprs.push(setB(next), b.br('$top')); }
    return exprs;
  };

  const translateBlock = (blk: Block): Expr[] => {
    const exprs: Expr[] = [];
    for (let pc = blk.addr; pc < blk.endAddr; pc += 4) {
      const isTerm = pc === blk.endAddr - 4 &&
        (TERM_BRANCH.has(field.opcode(wordAt(pc))) || field.isEcall(wordAt(pc)));
      if (isTerm) continue; // emitted by translateTermBlock
      const w = wordAt(pc);
      const op = field.opcode(w), rd = field.rd(w), f3 = field.funct3(w),
            rs1 = field.rs1(w), rs2 = field.rs2(w), f7 = field.funct7(w);
      const a = () => getReg(rs1), r2 = () => getReg(rs2);
      const out = (v: Expr) => { const s = setReg(rd, v); if (s) exprs.push(s); };
      const shiftMask = (e: Expr) => b.i64.and(e, i64c(63n));

      if (field.isEcall(w)) { exprs.push(b.br('$stop')); continue; }
      switch (op) {
        case OP.ArithReg: {
          if (f7 === 0x01) {
            switch (f3) {
              case 0x0: out(b.i64.mul(a(), r2())); break;
              case 0x4: out(b.i64.div_s(a(), r2())); break; // NOTE: wasm div-by-zero traps; RISC-V defines -1. Documented divergence.
              case 0x5: out(b.i64.div_u(a(), r2())); break;
              case 0x6: out(b.i64.rem_s(a(), r2())); break;
              case 0x7: out(b.i64.rem_u(a(), r2())); break;
              default: throw new Error(`M funct3 ${f3} unsupported in JIT at 0x${pc.toString(16)}`);
            }
            break;
          }
          switch (`${f7}:${f3}`) {
            case '0:0': out(b.i64.add(a(), r2())); break;
            case '32:0': out(b.i64.sub(a(), r2())); break;
            case '0:1': out(b.i64.shl(a(), shiftMask(r2()))); break;
            case '0:2': out(b.i64.extend_s(b.i64.lt_s(a(), r2()))); break;
            case '0:3': out(b.i64.extend_u(b.i64.lt_u(a(), r2()))); break;
            case '0:4': out(b.i64.xor(a(), r2())); break;
            case '0:5': out(b.i64.shr_u(a(), shiftMask(r2()))); break;
            case '32:5': out(b.i64.shr_s(a(), shiftMask(r2()))); break;
            case '0:6': out(b.i64.or(a(), r2())); break;
            case '0:7': out(b.i64.and(a(), r2())); break;
            default: throw new Error(`unsupported ArithReg ${f7}:${f3} at 0x${pc.toString(16)}`);
          }
          break;
        }
        case OP.ArithImm: {
          const imm = field.immI(w);
          switch (f3) {
            case 0x0: out(b.i64.add(a(), i64c(imm))); break;
            case 0x2: out(b.i64.extend_s(b.i64.lt_s(a(), i64c(imm)))); break;
            case 0x3: out(b.i64.extend_u(b.i64.lt_u(a(), i64c(imm)))); break;
            case 0x4: out(b.i64.xor(a(), i64c(imm))); break;
            case 0x6: out(b.i64.or(a(), i64c(imm))); break;
            case 0x7: out(b.i64.and(a(), i64c(imm))); break;
            case 0x1: out(b.i64.shl(a(), i64c(imm & 63n))); break;
            case 0x5: out((w >>> 30) === 0b01 ? b.i64.shr_s(a(), i64c(imm & 63n)) : b.i64.shr_u(a(), i64c(imm & 63n))); break;
            default: throw new Error(`unsupported ArithImm funct3 ${f3} at 0x${pc.toString(16)}`);
          }
          break;
        }
        case OP.Load: {
          const addr = effAddr(rs1, field.immI(w));
          switch (f3) {
            case 0x0: out(b.i64.extend_s(b.i32.load8_s(0, 1, addr))); break;
            case 0x1: out(b.i64.extend_s(b.i32.load16_s(0, 2, addr))); break;
            case 0x2: out(b.i64.extend_s(b.i32.load(0, 4, addr))); break;
            case 0x3: out(b.i64.load(0, 8, addr)); break;
            case 0x4: out(b.i64.extend_u(b.i32.load8_u(0, 1, addr))); break;
            case 0x5: out(b.i64.extend_u(b.i32.load16_u(0, 2, addr))); break;
            case 0x6: out(b.i64.extend_u(b.i32.load(0, 4, addr))); break;
            default: throw new Error(`unsupported load funct3 ${f3} at 0x${pc.toString(16)}`);
          }
          break;
        }
        case OP.Store: {
          const addr = effAddr(rs1, field.immS(w));
          switch (f3) {
            case 0x0: exprs.push(b.i32.store8(0, 1, addr, b.i32.wrap(getReg(rs2)))); break;
            case 0x1: exprs.push(b.i32.store16(0, 2, addr, b.i32.wrap(getReg(rs2)))); break;
            case 0x2: exprs.push(b.i32.store(0, 4, addr, b.i32.wrap(getReg(rs2)))); break;
            case 0x3: exprs.push(b.i64.store(0, 8, addr, getReg(rs2))); break;
            default: throw new Error(`unsupported store funct3 ${f3} at 0x${pc.toString(16)}`);
          }
          break;
        }
        case OP.Lui: out(i64c(field.immU(w))); break;
        case OP.Auipc: out(b.i64.add(i64c(BigInt(pc)), i64c(field.immU(w)))); break;
        case OP.Jalr: exprs.push(b.unreachable()); break; // unsupported in this subset
        default:
          throw new Error(`unsupported opcode 0x${op.toString(16)} at 0x${pc.toString(16)}`);
      }
    }
    exprs.push(...translateTermBlock(blk));
    return exprs;
  };

  // Build nested-block body.
  const B_LABEL = (i: number) => `B${i}`;
  const codeOf = blocks.map(translateBlock);
  // innermost: block B0 [ switch, unreachable ]
  const labels = blocks.map(blk => B_LABEL(blk.index));
  let inner: Expr = b.block(B_LABEL(0), [
    b.switch(labels, '$stop', b.local.get(BINDEX, i32)),
    b.unreachable(),
  ]);
  for (let i = 1; i < blocks.length; i++) {
    inner = b.block(B_LABEL(i), [inner, ...codeOf[i - 1]!, b.br('$top')]);
  }
  const loop = b.loop('$top', b.block(null, [inner, ...codeOf[blocks.length - 1]!, b.br('$top')]));
  const stop = b.block('$stop', [loop]);
  const body = b.block(null, [
    // zero the register file
    ...Array.from({ length: 32 }, (_, r) => r === 0 ? null : b.local.set(r, i64c(0n))).filter((e): e is Expr => e !== null),
    b.local.set(BINDEX, b.i32.const(0)),
    stop,
    b.return(getReg(10)),
  ]);

  b.addFunction('run', binaryen.none, i64, locals, body);
  b.addFunctionExport('run', 'run');

  const t1 = process.hrtime.bigint();
  if (opts.optimize) b.optimize();
  const t2 = process.hrtime.bigint();
  const valid = Number(b.validate()) !== 0;
  if (!valid) {
    const text = b.emitText();
    throw new Error('wasm module failed validation; WAT follows\n' + text.slice(0, 4000));
  }
  const binary = b.emitBinary();
  const t3 = process.hrtime.bigint();
  void t1; void t2;
  return {
    wasmBinary: new Uint8Array(binary),
    validate: valid,
    blockCount: blocks.length,
    emitMilliseconds: Number(t3 - t0) / 1e6,
    optimized: opts.optimize,
  };
}

export interface InstantiatedRegion {
  exports: { run(): bigint };
  memory: WebAssembly.Memory;
  instantiateMilliseconds: number;
}

export async function instantiateRegion(region: CompiledRegion, _memoryPages: number): Promise<InstantiatedRegion> {
  const t0 = process.hrtime.bigint();
  const mod = await WebAssembly.compile(region.wasmBinary);
  const instance = await WebAssembly.instantiate(mod, {});
  const t1 = process.hrtime.bigint();
  const memory = (instance.exports as Record<string, unknown>)['mem'] as WebAssembly.Memory;
  return {
    exports: instance.exports as unknown as { run(): bigint },
    memory,
    instantiateMilliseconds: Number(t1 - t0) / 1e6,
  };
}
