/**
 * Tier 0: the RV32IMA interpreter.
 *
 * Correctness first - this is the oracle the JIT is differentially fuzzed
 * against (`core/test/differential.test.ts`) and the fallback for every
 * instruction the translator does not handle (CSRs, FENCE.I, anything illegal).
 * It is deliberately a plain `switch`: a decode-cached interpreter is a Phase 1
 * optimisation, and Phase 0 needs the *unoptimised* number because that is the
 * baseline the JIT speedup is measured against.
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
  F3_BEQ,
  F3_BGE,
  F3_BGEU,
  F3_BLT,
  F3_BLTU,
  F3_BNE,
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
  amoFunct5,
  csrAddr,
  funct3,
  funct7,
  immB,
  immI,
  immJ,
  immS,
  immU,
  opcode,
} from './encoding.ts';
import { F12_EBREAK, F12_ECALL, F12_MRET, F12_WFI } from './encoding.ts';
import { CAUSE, CSR, type CpuState, type StopReason } from './state.ts';
import type { GuestMemory } from '../machine/memory.ts';
import type { AccessKind, TranslateResult } from '../mmu/mmu.ts';

/** What the interpreter needs from the machine. Implemented by `Machine`. */
export interface MachinePort {
  readonly mem: GuestMemory;
  readonly mmuActive?: boolean;
  /**
   * Translate a guest virtual address for `kind`. Identity in M-mode/bare mode.
   * A page fault is reported, not thrown, so the interpreter can raise the
   * RISC-V trap with the faulting VA in `mtval`. Optional so lightweight test
   * ports that never enable paging keep working; absence means identity.
   */
  translate?(kind: AccessKind, va: number): TranslateResult;
  onSyscall(cpu: CpuState): void;
  onMMIORead(cpu: CpuState, addr: number, size: number): number;
  onMMIOWrite(cpu: CpuState, addr: number, size: number, value: number): void;
  /** Called on WFI. Returns true when the vCPU should stop instead of idling. */
  onIdle(cpu: CpuState): boolean;
  /** `satp` was written: translation state must be invalidated. */
  onSatpWrite?(value: number): void;
  /** `sfence.vma rs1, rs2` retired. */
  onSfenceVma?(address: number | null, asid: number | null): void;
  // -- SMP barriers (absent on a single-hart machine) ------------------------
  /** Before a shared store/AMO writes. */
  onWriteBegin?(hart: number): void;
  /** After a shared store/AMO, with the guest physical address written. */
  onWriteEnd?(hart: number, addr: number, size: number): void;
  /** Record an LR reservation. */
  onLr?(hart: number, addr: number, index: number): number | null;
  /**
   * Attempt an SC. `true`/`false` is an SMP verdict; `null` means "no SMP
   * channel", so the interpreter uses its single-hart compare-exchange path.
   */
  onSc?(hart: number, addr: number, value: number, index: number): boolean | null;
}

export class Interpreter {
  constructor(private readonly port: MachinePort) {}

  /** Identity when the port does not install an MMU. */
  private translate(kind: AccessKind, va: number): TranslateResult {
    return this.port.translate?.(kind, va) ?? { ok: true, pa: va >>> 0, tlbHit: false };
  }

  /**
   * Execute exactly one instruction, updating `cpu`.
   *
   * mcycle advances with minstret: the spike models 1 IPC, which is the honest
   * baseline until Phase 1 adds a pipeline model. Counting here (rather than in
   * the machine's run loop) is what makes mcycle readable *inside* a program.
   */
  step(cpu: CpuState): void {
    const at = cpu.instret;
    this.execute(cpu);
    cpu.cycles += cpu.instret - at;
  }

  private execute(cpu: CpuState): void {
    const mem = this.port.mem;
    const pc = cpu.pc >>> 0;
    // Instruction fetches go through the MMU exactly like loads and stores:
    // with paging enabled a fetch from an unmapped or non-executable page is an
    // instruction page fault, not a physical RAM read.
    const fetchTr = this.translate('fetch', pc);
    if (!fetchTr.ok) {
      this.trap(cpu, fetchTr.cause, fetchTr.tval);
      return;
    }
    const off = mem.ramOffset(fetchTr.pa);
    if (off < 0 || off + 4 > mem.ramSize) {
      this.trap(cpu, CAUSE.INSTRUCTION_ACCESS_FAULT, pc);
      return;
    }
    if ((off & 3) !== 0) {
      this.trap(cpu, CAUSE.INSTRUCTION_ADDRESS_MISALIGNED, pc);
      return;
    }
    const instr = mem.view.getUint32(off, true);
    const op = opcode(instr);
    const rd = (instr >>> 7) & 0x1f;
    const f3 = funct3(instr);
    const rs1 = (instr >>> 15) & 0x1f;
    const rs2 = (instr >>> 20) & 0x1f;
    const regs = cpu.regs;
    let next = (pc + 4) >>> 0;

    switch (op) {
      case OP_LUI:
        if (rd) regs[rd] = immU(instr);
        break;
      case OP_AUIPC:
        if (rd) regs[rd] = (pc + immU(instr)) | 0;
        break;
      case OP_JAL:
        if (rd) regs[rd] = next | 0;
        next = (pc + immJ(instr)) >>> 0;
        break;
      case OP_JALR: {
        const target = (((regs[rs1]! + immI(instr)) | 0) & ~1) >>> 0;
        if (rd) regs[rd] = next | 0;
        next = target;
        break;
      }
      case OP_BRANCH: {
        const a = regs[rs1]!;
        const b = regs[rs2]!;
        let taken = false;
        switch (f3) {
          case F3_BEQ:
            taken = a === b;
            break;
          case F3_BNE:
            taken = a !== b;
            break;
          case F3_BLT:
            taken = a < b;
            break;
          case F3_BGE:
            taken = a >= b;
            break;
          case F3_BLTU:
            taken = a >>> 0 < b >>> 0;
            break;
          case F3_BGEU:
            taken = a >>> 0 >= b >>> 0;
            break;
          default:
            this.illegal(cpu, instr, pc);
            return;
        }
        if (taken) next = (pc + immB(instr)) >>> 0;
        break;
      }
      case OP_LOAD: {
        const addr = ((regs[rs1]! + immI(instr)) | 0) >>> 0;
        const value = this.load(cpu, addr, f3, pc);
        if (value === null) return; // trapped into a handler
        if (cpu.stop !== 'running') return;
        if (rd) regs[rd] = value;
        break;
      }
      case OP_STORE: {
        const addr = ((regs[rs1]! + immS(instr)) | 0) >>> 0;
        if (!this.store(cpu, addr, f3, regs[rs2]!, pc)) return;
        if (cpu.stop !== 'running') return;
        break;
      }
      case OP_OPI: {
        const a = regs[rs1]!;
        const imm = immI(instr);
        let result: number;
        switch (f3) {
          case 0b000:
            result = (a + imm) | 0;
            break; // addi
          case 0b001: {
            // slli
            const sh = (instr >>> 20) & 0x1f;
            if (funct7(instr) !== 0) {
              this.illegal(cpu, instr, pc);
              return;
            }
            result = (a << sh) | 0;
            break;
          }
          case 0b010:
            result = a < imm ? 1 : 0;
            break; // slti
          case 0b011:
            result = a >>> 0 < imm >>> 0 ? 1 : 0;
            break; // sltiu
          case 0b100:
            result = a ^ imm;
            break; // xori
          case 0b101: {
            // srli / srai
            const sh = (instr >>> 20) & 0x1f;
            const f7 = funct7(instr);
            if (f7 === 0) result = a >>> sh;
            else if (f7 === 0x20) result = a >> sh;
            else {
              this.illegal(cpu, instr, pc);
              return;
            }
            break;
          }
          case 0b110:
            result = a | imm;
            break; // ori
          case 0b111:
            result = a & imm;
            break; // andi
          default:
            this.illegal(cpu, instr, pc);
            return;
        }
        if (rd) regs[rd] = result;
        break;
      }
      case OP_OP: {
        const a = regs[rs1]!;
        const b = regs[rs2]!;
        const f7 = funct7(instr);
        let result: number;
        if (f7 === 0x01) {
          // M extension
          switch (f3) {
            case 0b000:
              result = Math.imul(a, b);
              break; // mul
            case 0b001:
              result = mulh(a, b, false, false);
              break; // mulh
            case 0b010:
              result = mulh(a, b, false, true);
              break; // mulhsu
            case 0b011:
              result = mulh(a, b, true, true);
              break; // mulhu
            case 0b100: // div
              if (b === 0) result = -1;
              else if (a === -2147483648 && b === -1) result = -2147483648;
              else result = (a / b) | 0;
              break;
            case 0b101: // divu
              if (b === 0) result = -1;
              else result = ((a >>> 0) / (b >>> 0)) | 0;
              break;
            case 0b110: // rem
              if (b === 0) result = a;
              else if (a === -2147483648 && b === -1) result = 0;
              else result = a % b;
              break;
            case 0b111: // remu
              if (b === 0) result = a;
              else result = ((a >>> 0) % (b >>> 0)) | 0;
              break;
            default:
              this.illegal(cpu, instr, pc);
              return;
          }
        } else if (f7 === 0x00 || f7 === 0x20) {
          switch (f3) {
            case 0b000:
              result = f7 === 0 ? (a + b) | 0 : (a - b) | 0;
              break;
            case 0b001:
              if (f7 !== 0) {
                this.illegal(cpu, instr, pc);
                return;
              }
              result = (a << (b & 31)) | 0;
              break;
            case 0b010:
              if (f7 !== 0) {
                this.illegal(cpu, instr, pc);
                return;
              }
              result = a < b ? 1 : 0;
              break;
            case 0b011:
              if (f7 !== 0) {
                this.illegal(cpu, instr, pc);
                return;
              }
              result = a >>> 0 < b >>> 0 ? 1 : 0;
              break;
            case 0b100:
              if (f7 !== 0) {
                this.illegal(cpu, instr, pc);
                return;
              }
              result = a ^ b;
              break;
            case 0b101:
              result = f7 === 0 ? a >>> (b & 31) : a >> (b & 31);
              break;
            case 0b110:
              if (f7 !== 0) {
                this.illegal(cpu, instr, pc);
                return;
              }
              result = a | b;
              break;
            case 0b111:
              if (f7 !== 0) {
                this.illegal(cpu, instr, pc);
                return;
              }
              result = a & b;
              break;
            default:
              this.illegal(cpu, instr, pc);
              return;
          }
        } else {
          this.illegal(cpu, instr, pc);
          return;
        }
        if (rd) regs[rd] = result;
        break;
      }
      case OP_MISC_MEM:
        // FENCE / FENCE.I: JS has no reordering to fence inside one thread, and
        // cross-worker ordering is handled by atomics. Treated as a nop.
        break;
      case OP_AMO: {
        if (f3 !== 0b010) {
          this.illegal(cpu, instr, pc);
          return;
        }
        const addr = regs[rs1]! >>> 0;
        if (!this.amo(cpu, amoFunct5(instr), addr, regs[rs2]!, rd, pc)) return;
        break;
      }
      case OP_SYSTEM: {
        if (f3 === 0) {
          // sfence.vma: funct7=0x09, rd=0; rs1/rs2 select an address and ASID
          // and are both legal. It is not an f12 match because rs2 occupies
          // bits 24:20.
          if (funct7(instr) === 0x09 && rd === 0) {
            cpu.pc = next;
            cpu.instret++;
            this.port.onSfenceVma?.(rs1 === 0 ? null : regs[rs1]! >>> 0, rs2 === 0 ? null : regs[rs2]! >>> 0);
            return;
          }
          const f12 = (instr >>> 20) & 0xfff;
          switch (f12) {
            case F12_ECALL:
              cpu.pc = next;
              cpu.instret++;
              this.port.onSyscall(cpu);
              return;
            case F12_EBREAK:
              cpu.pc = next;
              cpu.instret++;
              cpu.stop = 'breakpoint';
              return;
            case F12_WFI:
              cpu.pc = next;
              cpu.instret++;
              if (this.port.onIdle(cpu)) return;
              cpu.stop = 'idle';
              return;
            case F12_MRET: {
              const mepc = cpu.readCsr(CSR.mepc) >>> 0;
              cpu.pc = mepc;
              cpu.instret++;
              return;
            }
            default:
              this.illegal(cpu, instr, pc);
              return;
          }
        }
        // CSR instructions
        const addrCsr = csrAddr(instr);
        const old = cpu.readCsr(addrCsr);
        const src = f3 >= 0b101 ? (instr >>> 15) & 0x1f : regs[rs1]!;
        let value = old;
        switch (f3) {
          case 0b001:
          case 0b101:
            value = src;
            break; // csrrw(i)
          case 0b010:
          case 0b110:
            value = old | src;
            break; // csrrs(i)
          case 0b011:
          case 0b111:
            value = old & ~src;
            break; // csrrc(i)
          default:
            this.illegal(cpu, instr, pc);
            return;
        }
        // csrrs/csrrc with rs1=x0 must not write (a read-only CSR stays read-only).
        const writes =
          f3 === 0b001 ||
          f3 === 0b101 ||
          ((f3 === 0b010 || f3 === 0b110) && src !== 0) ||
          ((f3 === 0b011 || f3 === 0b111) && src !== 0);
        if (writes) {
          cpu.writeCsr(addrCsr, value);
          if (addrCsr === CSR.satp) this.port.onSatpWrite?.(value);
        }
        if (rd) regs[rd] = old;
        break;
      }
      default:
        this.illegal(cpu, instr, pc);
        return;
    }

    cpu.pc = next;
    cpu.instret++;
  }

  /** Run up to `budget` instructions. Returns why it stopped. */
  run(cpu: CpuState, budget: number): StopReason {
    let n = 0;
    while (n < budget && cpu.stop === 'running') {
      this.step(cpu);
      n++;
    }
    return cpu.stop;
  }

  // -- helpers --------------------------------------------------------------

  /** Returns `null` when the access trapped into a handler. */
  private load(cpu: CpuState, addr: number, f3: number, pc: number): number | null {
    const mem = this.port.mem;
    const size = f3 === 0 || f3 === 4 ? 1 : f3 === 1 || f3 === 5 ? 2 : 4;
    const tr = this.translate('load', addr);
    if (!tr.ok) {
      this.trap(cpu, tr.cause, tr.tval);
      return null;
    }
    const off = mem.ramOffset(tr.pa);
    if (off < 0 || off + size > mem.ramSize) {
      const value = this.port.onMMIORead(cpu, tr.pa, size);
      if (cpu.stop !== 'running') return 0;
      return signExtend(value, size, f3 < 4);
    }
    try {
      switch (f3) {
        case 0b000:
          return mem.view.getInt8(off);
        case 0b001:
          return mem.view.getInt16(off, true);
        case 0b010:
          return mem.view.getInt32(off, true);
        case 0b100:
          return mem.u8[off]!;
        case 0b101:
          return mem.view.getUint16(off, true);
        default:
          this.illegal(cpu, 0, pc);
          return null;
      }
    } catch {
      this.trap(cpu, CAUSE.LOAD_ACCESS_FAULT, addr);
      return null;
    }
  }

  /** Returns false when the access trapped into a handler or stopped the machine. */
  private store(cpu: CpuState, addr: number, f3: number, value: number, pc: number): boolean {
    const mem = this.port.mem;
    const size = f3 === 0 ? 1 : f3 === 1 ? 2 : 4;
    const tr = this.translate('store', addr);
    if (!tr.ok) {
      this.trap(cpu, tr.cause, tr.tval);
      return false;
    }
    const off = mem.ramOffset(tr.pa);
    if (off < 0 || off + size > mem.ramSize) {
      this.port.onMMIOWrite(cpu, tr.pa, size, value);
      return cpu.stop === 'running';
    }
    this.port.onWriteBegin?.(cpu.hartId);
    if (cpu.lrValid && tr.pa >>> 0 < (cpu.lrAddr >>> 0) + 4 && cpu.lrAddr >>> 0 < (tr.pa >>> 0) + size)
      cpu.lrValid = false;
    try {
      switch (f3) {
        case 0b000:
          mem.u8[off] = value & 0xff;
          break;
        case 0b001:
          mem.view.setUint16(off, value & 0xffff, true);
          break;
        case 0b010:
          mem.view.setUint32(off, value >>> 0, true);
          break;
        default:
          this.illegal(cpu, 0, pc);
          return false;
      }
    } catch {
      this.trap(cpu, CAUSE.STORE_ACCESS_FAULT, addr);
      return false;
    } finally {
      this.port.onWriteEnd?.(cpu.hartId, tr.pa, size);
    }
    return true;
  }

  /**
   * A-extension. Returns false when execution must stop (trap or MMIO), which
   * the caller treats as "state already updated".
   */
  private amo(cpu: CpuState, f5: number, addr: number, src: number, rd: number, pc: number): boolean {
    if ((addr & 3) !== 0) {
      this.trap(cpu, CAUSE.STORE_ADDRESS_MISALIGNED, addr);
      return false;
    }
    const mem = this.port.mem;
    const tr = this.translate('amo', addr);
    if (!tr.ok) {
      this.trap(cpu, tr.cause, tr.tval);
      return false;
    }
    const off = mem.ramOffset(tr.pa);
    if (off < 0 || off + 4 > mem.ramSize) {
      // Atomics on MMIO are not supported by the spike machine.
      this.trap(cpu, CAUSE.STORE_ACCESS_FAULT, addr);
      return false;
    }
    const idx = off >> 2;
    if (f5 === AMO5_LR) {
      const value = this.port.onLr?.(cpu.hartId, tr.pa, idx) ?? Atomics.load(mem.i32, idx);
      cpu.lrAddr = tr.pa;
      cpu.lrValue = value;
      cpu.lrValid = true;
      if (rd) cpu.regs[rd] = value;
      return true;
    }
    if (f5 === AMO5_SC) {
      let success = 0;
      const sc = this.port.onSc?.(cpu.hartId, tr.pa, src, idx);
      if (sc !== undefined && sc !== null) {
        // The SMP channel checks the reservation and stores under its write
        // lock, so a store-then-restore by another hart cannot commit a stale SC.
        success = sc ? 0 : 1;
      } else if (cpu.lrValid && cpu.lrAddr === tr.pa) {
        // Single-hart fallback: `compareExchange` gives the SC semantics.
        const old = Atomics.compareExchange(mem.i32, idx, cpu.lrValue, src);
        success = old === cpu.lrValue ? 0 : 1;
      } else {
        success = 1;
      }
      cpu.lrValid = false;
      if (rd) cpu.regs[rd] = success;
      return true;
    }
    this.port.onWriteBegin?.(cpu.hartId);
    if (cpu.lrValid && cpu.lrAddr === tr.pa) cpu.lrValid = false;
    let old: number;
    let illegal = false;
    switch (f5) {
      case AMO5_SWAP:
        old = Atomics.exchange(mem.i32, idx, src);
        break;
      case AMO5_ADD:
        old = Atomics.add(mem.i32, idx, src);
        break;
      case AMO5_XOR:
        old = Atomics.xor(mem.i32, idx, src);
        break;
      case AMO5_OR:
        old = Atomics.or(mem.i32, idx, src);
        break;
      case AMO5_AND:
        old = Atomics.and(mem.i32, idx, src);
        break;
      case AMO5_MIN: {
        old = Atomics.load(mem.i32, idx);
        while (Atomics.compareExchange(mem.i32, idx, old, Math.min(old, src)) !== old) {
          old = Atomics.load(mem.i32, idx);
        }
        break;
      }
      case AMO5_MAX: {
        old = Atomics.load(mem.i32, idx);
        while (Atomics.compareExchange(mem.i32, idx, old, Math.max(old, src)) !== old) {
          old = Atomics.load(mem.i32, idx);
        }
        break;
      }
      case AMO5_MINU: {
        old = Atomics.load(mem.i32, idx);
        while (Atomics.compareExchange(mem.i32, idx, old, old >>> 0 < src >>> 0 ? old : src) !== old) {
          old = Atomics.load(mem.i32, idx);
        }
        break;
      }
      case AMO5_MAXU: {
        old = Atomics.load(mem.i32, idx);
        while (Atomics.compareExchange(mem.i32, idx, old, old >>> 0 > src >>> 0 ? old : src) !== old) {
          old = Atomics.load(mem.i32, idx);
        }
        break;
      }
      default:
        this.illegal(cpu, 0, pc);
        illegal = true;
        old = 0;
    }
    this.port.onWriteEnd?.(cpu.hartId, tr.pa, 4);
    if (illegal) return false;
    if (rd) cpu.regs[rd] = old;
    return true;
  }

  /**
   * Raise a synchronous trap. Returns true when a handler was entered (mtvec
   * nonzero) and false when the machine has no handler and stopped. `mepc` is
   * the faulting instruction's own pc: `cpu.pc` is only advanced after the
   * instruction body, so it still points at the instruction that trapped.
   */
  private trap(cpu: CpuState, cause: number, tval: number): boolean {
    const mtvec = cpu.readCsr(CSR.mtvec) >>> 0;
    cpu.cause = cause;
    cpu.tval = tval | 0;
    if (mtvec !== 0) {
      cpu.writeCsr(CSR.mepc, cpu.pc);
      cpu.writeCsr(CSR.mcause, cause);
      cpu.writeCsr(CSR.mtval, tval | 0);
      cpu.pc = (mtvec & ~0x3) >>> 0;
      return true;
    }
    cpu.stop = 'trap';
    return false;
  }

  private illegal(cpu: CpuState, instr: number, _pc: number): void {
    this.trap(cpu, CAUSE.ILLEGAL_INSTRUCTION, instr);
  }
}

export function signExtend(value: number, size: number, signed: boolean): number {
  if (!signed) return value >>> 0;
  switch (size) {
    case 1:
      return (value << 24) >> 24;
    case 2:
      return (value << 16) >> 16;
    default:
      return value | 0;
  }
}

/**
 * High 32 bits of a 32x32 multiplication, using BigInt because JS has no
 * widening multiply. Only used by the interpreter; the JIT emits i64.mul.
 */
export function mulh(a: number, b: number, aUnsigned: boolean, bUnsigned: boolean): number {
  const x = aUnsigned ? BigInt(a >>> 0) : BigInt(a | 0);
  const y = bUnsigned ? BigInt(b >>> 0) : BigInt(b | 0);
  const prod = x * y;
  return Number(BigInt.asIntN(32, prod >> 32n)) | 0;
}
