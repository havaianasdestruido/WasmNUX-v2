/**
 * RV64I (+M subset) interpreter. Correctness-first reference tier.
 * 64-bit registers modelled as BigInt; memory is a flat byte array.
 */
import { OP, field } from './rv64.js';

export interface RunResult {
  /** Value of a0 (x10) at halt. */
  a0: bigint;
  /** Instructions executed. */
  instructions: bigint;
  /** Halt reason. */
  reason: 'ecall' | 'fuel';
}

export interface Memory {
  bytes: Uint8Array;
}

export class Machine {
  readonly regs = new BigInt64Array(32); // NaN-boxed? no: real 64-bit ints
  readonly memory: DataView | undefined;
  private raw: Uint8Array;
  instructions = 0n;

  constructor(program: Uint8Array, memBytes: number) {
    this.raw = program;
    this.memBytes = memBytes;
    this._mem = new Uint8Array(memBytes);
    this._dv = new DataView(this._mem.buffer);
  }
  readonly memBytes: number;
  private _mem: Uint8Array;
  private _dv: DataView;

  get mem(): Uint8Array { return this._mem; }

  private readMem(addr: bigint, size: number): bigint {
    const a = Number(addr);
    if (a + size > this._mem.length || a < 0) {
      throw new RangeError(`guest load out of bounds: addr=${a} size=${size}`);
    }
    switch (size) {
      case 1: return BigInt(this._mem[a]!);
      case 2: return BigInt(this._dv.getUint16(a, true));
      case 4: return BigInt(this._dv.getUint32(a, true));
      case 8: return this._dv.getBigUint64(a, true);
      default: throw new Error('bad load size');
    }
  }

  private writeMem(addr: bigint, size: number, value: bigint): void {
    const a = Number(addr);
    if (a + size > this._mem.length || a < 0) {
      throw new RangeError(`guest store out of bounds: addr=${a} size=${size}`);
    }
    switch (size) {
      case 1: this._mem[a] = Number(value & 0xffn); break;
      case 2: this._dv.setUint16(a, Number(value & 0xffffn), true); break;
      case 4: this._dv.setUint32(a, Number(value & 0xffffffffn), true); break;
      case 8: this._dv.setBigUint64(a, BigInt.asUintN(64, value), true); break;
      default: throw new Error('bad store size');
    }
  }

  private checkedRead(addr: number): number {
    if (addr + 4 > this.raw.length || addr < 0) throw new RangeError(`pc out of bounds: ${addr}`);
    return new DataView(this.raw.buffer, this.raw.byteOffset + addr, 4).getUint32(0, true) >>> 0;
  }

  writeU64(addr: number, value: bigint): void {
    if (addr + 8 > this._mem.length) throw new RangeError('writeU64 out of bounds');
    this._dv.setBigUint64(addr, BigInt.asUintN(64, value), true);
  }
  readU64(addr: number): bigint {
    return this._dv.getBigUint64(addr, true);
  }

  run(maxInstructions = 1_000_000_000n): RunResult {
    const R = this.regs;
    R[0] = 0n;
    let pc = 0;
    for (;;) {
      if (this.instructions >= maxInstructions) {
        R[0] = 0n;
        return { a0: BigInt.asIntN(64, R[10]!), instructions: this.instructions, reason: 'fuel' };
      }
      const w = this.checkedRead(pc);
      this.instructions++;
      if (field.isEcall(w)) {
        return { a0: BigInt.asIntN(64, R[10]!), instructions: this.instructions, reason: 'ecall' };
      }
      const op = field.opcode(w), rd = field.rd(w), f3 = field.funct3(w),
            rs1 = field.rs1(w), rs2 = field.rs2(w), f7 = field.funct7(w);
      const R1 = BigInt.asIntN(64, R[rs1]!), R2 = BigInt.asIntN(64, R[rs2]!);
      let next = pc + 4;
      const setRd = (v: bigint) => { if (rd !== 0) R[rd] = BigInt.asIntN(64, v); };

      switch (op) {
        case OP.ArithReg: {
          if (f7 === 0x01) { // M extension
            switch (f3) {
              case 0x0: setRd(R1 * R2); break;                    // mul
              case 0x4: setRd(R2 === 0n ? -1n : (R1 === -9223372036854775808n && R2 === -1n ? R1 : R1 / R2)); break; // div (RISC-V: div-by-zero -> -1)
              case 0x5: setRd(R2 === 0n ? (1n << 64n) - 1n : (R1 === -9223372036854775808n && R2 === -1n ? R1 : BigInt.asIntN(64, BigInt.asUintN(64, R1) / BigInt.asUintN(64, R2)))); break; // divu
              case 0x6: setRd(R2 === 0n ? R1 : (R1 === -9223372036854775808n && R2 === -1n ? 0n : R1 % R2)); break; // rem
              case 0x7: setRd(R2 === 0n ? BigInt.asUintN(64, R1) : BigInt.asUintN(64, BigInt.asUintN(64, R1) % BigInt.asUintN(64, R2))); break; // remu
              default: throw new Error(`unsupported M funct3 ${f3} at pc=${pc}`);
            }
            break;
          }
          switch (`${f7}:${f3}`) {
            case '0:0': setRd(R1 + R2); break;
            case '32:0': setRd(R1 - R2); break;
            case '0:1': setRd(R1 << (R2 & 63n)); break;
            case '0:2': setRd(R1 < R2 ? 1n : 0n); break;
            case '0:3': setRd(BigInt.asUintN(64, R1) < BigInt.asUintN(64, R2) ? 1n : 0n); break;
            case '0:4': setRd(R1 ^ R2); break;
            case '0:5': setRd(BigInt.asUintN(64, R1) >> (R2 & 63n)); break;
            case '32:5': setRd(R1 >> (R2 & 63n)); break;
            case '0:6': setRd(R1 | R2); break;
            case '0:7': setRd(R1 & R2); break;
            default: throw new Error(`unsupported R funct7:f3 ${f7}:${f3} at pc=${pc}`);
          }
          break;
        }
        case OP.ArithImm: {
          const imm = field.immI(w);
          switch (f3) {
            case 0x0: setRd(R1 + imm); break;
            case 0x2: setRd(R1 < imm ? 1n : 0n); break;
            case 0x3: setRd(BigInt.asUintN(64, R1) < BigInt.asUintN(64, imm) ? 1n : 0n); break;
            case 0x4: setRd(R1 ^ imm); break;
            case 0x6: setRd(R1 | imm); break;
            case 0x7: setRd(R1 & imm); break;
            case 0x1: setRd(R1 << (imm & 63n)); break;
            case 0x5: setRd((w >>> 30) === 0b01 ? (R1 >> (imm & 63n)) : (BigInt.asUintN(64, R1) >> (imm & 63n))); break; // srai (funct7 bit30) / srli
            default: throw new Error(`unsupported I funct3 ${f3} at pc=${pc}`);
          }
          break;
        }
        case OP.Load: {
          const addr = R1 + field.immI(w);
          let v: bigint;
          switch (f3) {
            case 0x0: v = BigInt.asIntN(64, this.readMem(addr, 1)) << 56n >> 56n; break;
            case 0x1: v = BigInt.asIntN(64, this.readMem(addr, 2)) << 48n >> 48n; break;
            case 0x2: v = BigInt.asIntN(64, this.readMem(addr, 4)) << 32n >> 32n; break;
            case 0x3: v = this.readMem(addr, 8); break;
            case 0x4: v = this.readMem(addr, 1); break;
            case 0x5: v = this.readMem(addr, 2); break;
            case 0x6: v = this.readMem(addr, 4); break;
            default: throw new Error(`unsupported load funct3 ${f3} at pc=${pc}`);
          }
          setRd(v);
          break;
        }
        case OP.Store: {
          const addr = R1 + field.immS(w);
          switch (f3) {
            case 0x0: this.writeMem(addr, 1, R2); break;
            case 0x1: this.writeMem(addr, 2, R2); break;
            case 0x2: this.writeMem(addr, 4, R2); break;
            case 0x3: this.writeMem(addr, 8, R2); break;
            default: throw new Error(`unsupported store funct3 ${f3} at pc=${pc}`);
          }
          break;
        }
        case OP.Branch: {
          const off = field.immB(w);
          let taken = false;
          switch (f3) {
            case 0x0: taken = R1 === R2; break;
            case 0x1: taken = R1 !== R2; break;
            case 0x4: taken = R1 < R2; break;
            case 0x5: taken = R1 >= R2; break;
            case 0x6: taken = BigInt.asUintN(64, R1) < BigInt.asUintN(64, R2); break;
            case 0x7: taken = BigInt.asUintN(64, R1) >= BigInt.asUintN(64, R2); break;
            default: throw new Error(`unsupported branch funct3 ${f3} at pc=${pc}`);
          }
          if (taken) next = pc + Number(off);
          break;
        }
        case OP.Lui: setRd(field.immU(w)); break;
        case OP.Auipc: setRd(BigInt(pc) + field.immU(w)); break;
        case OP.Jal: setRd(BigInt(pc + 4)); next = pc + Number(field.immJ(w)); break;
        case OP.Jalr: setRd(BigInt(pc + 4)); next = Number(BigInt.asUintN(64, R1 + field.immI(w)) & ~1n); break;
        default:
          throw new Error(`unsupported opcode 0x${op.toString(16)} at pc=${pc}`);
      }
      R[0] = 0n;
      pc = next;
    }
  }
}
