/**
 * Interpreter tier (correctness reference for the JIT — ADR-0002/0003).
 *
 * Phase 0 scope: M-mode only, RV64IMA + Zicsr, no compressed instructions.
 * Register state lives in the GuestMemory footer (shared with JIT code) so
 * tier switching is copy-free.
 */

import { decodeAt, type Insn, type Op } from "./isa/decoder.js";
import { GuestMemory } from "./memory.js";
import { Mmu, type AccessKind, type MmuResult } from "./mmu.js";

// CSR addresses
export const CSR_SSTATUS = 0x100;
export const CSR_SIE = 0x104;
export const CSR_STVEC = 0x105;
export const CSR_SSCRATCH = 0x140;
export const CSR_SEPC = 0x141;
export const CSR_SCAUSE = 0x142;
export const CSR_STVAL = 0x143;
export const CSR_SIP = 0x144;
export const CSR_SATP = 0x180;
export const CSR_MSTATUS = 0x300;
export const CSR_MISA = 0x301;
export const CSR_MEDELEG = 0x302;
export const CSR_MIDELEG = 0x303;
export const CSR_MIE = 0x304;
export const CSR_MTVEC = 0x305;
export const CSR_MSCRATCH = 0x340;
export const CSR_MEPC = 0x341;
export const CSR_MCAUSE = 0x342;
export const CSR_MTVAL = 0x343;
export const CSR_MIP = 0x344;
export const CSR_MCYCLE = 0xb00;
export const CSR_MINSTRET = 0xb02;
export const CSR_MHARTID = 0xf14;
export const CSR_CYCLE = 0xc00;
export const CSR_TIME = 0xc01;
export const CSR_INSTRET = 0xc02;

export const EXIT_SYSCALL = 93n;   // riscv64 Linux exit
export const WRITE_SYSCALL = 64n;  // riscv64 Linux write

/** CSRs implemented by this Phase 0 CPU (reads default to 0, writes stick). */
export const IMPLEMENTED_CSRS: ReadonlySet<number> = new Set([
  CSR_SSTATUS, CSR_SIE, CSR_STVEC, CSR_SSCRATCH, CSR_SEPC, CSR_SCAUSE,
  CSR_STVAL, CSR_SIP, CSR_SATP,
  CSR_MSTATUS, CSR_MISA, CSR_MEDELEG, CSR_MIDELEG, CSR_MIE, CSR_MTVEC,
  CSR_MSCRATCH, CSR_MEPC, CSR_MCAUSE, CSR_MTVAL, CSR_MIP,
  CSR_MCYCLE, CSR_MINSTRET, CSR_MHARTID,
  CSR_CYCLE, CSR_TIME, CSR_INSTRET,
]);

export type CpuExit = { kind: "exit"; code: number } | { kind: "trap"; cause: bigint; pc: bigint };

export interface CpuOptions {
  memory: GuestMemory;
  /** Entry PC (default: base of RAM). */
  pc?: bigint;
  /** Linux-style syscall hook for ecall; return true if handled. */
  onSyscall?: (cpu: Cpu, syscall: bigint, args: bigint[]) => boolean;
  /** Called on machine traps after vectoring (observability hook). */
  onTrap?: (cpu: Cpu, cause: bigint, tval: bigint) => void;
  /** Capture writes to fd 1/2 instead of stdout (used by benches/tests). */
  captureOutput?: boolean;
}

const SIGN32 = (v: bigint): bigint => BigInt.asIntN(32, v);

export class Cpu {
  readonly mem: GuestMemory;
  readonly mmu: Mmu;
  pc: bigint;
  halted = false;
  exitCode = 0;
  /** Output captured from write() syscalls when captureOutput is set. */
  output = "";

  cycles = 0n;
  instret = 0n;

  private csrs = new Map<number, bigint>();
  // LR/SC reservation
  resValid = false;
  resAddr = 0n;

  private readonly onSyscall?: CpuOptions["onSyscall"];
  private readonly onTrap?: CpuOptions["onTrap"];
  private readonly captureOutput: boolean;

  constructor(opts: CpuOptions) {
    this.mem = opts.memory;
    this.mmu = new Mmu();
    this.pc = opts.pc ?? BigInt(opts.memory.base);
    this.onSyscall = opts.onSyscall;
    this.onTrap = opts.onTrap;
    this.captureOutput = opts.captureOutput ?? false;

    // misa: RV64IM A + S + U
    this.csrs.set(CSR_MISA, (2n << 62n) | (1n << 8n) | (1n << 12n) | (1n << 0n) | (1n << 18n) | (1n << 20n));
    this.csrs.set(CSR_MHARTID, 0n);
    this.csrs.set(CSR_MSTATUS, 0xa00000000n); // UXL/SXL = 64-bit
  }

  // ---- register file (shared footer, zero register enforced on write) ----
  getReg(i: number): bigint {
    if (i === 0) return 0n;
    return this.mem.regs[i]!;
  }

  setReg(i: number, v: bigint): void {
    if (i === 0) return;
    this.mem.regs[i] = BigInt.asUintN(64, v);
  }

  resetRegs(): void {
    this.mem.regs.fill(0n);
  }

  // ---- CSRs ----
  readCsr(addr: number, insnPc: bigint): bigint | null {
    switch (addr) {
      case CSR_CYCLE: case CSR_MCYCLE: return this.cycles;
      case CSR_INSTRET: case CSR_MINSTRET: return this.instret;
      case CSR_TIME: return this.cycles; // timebase ≈ cycles in Phase 0
      case CSR_SATP: return this.mmu.satp;
      default: {
        if (this.csrs.has(addr)) return this.csrs.get(addr)!;
        if (IMPLEMENTED_CSRS.has(addr)) return 0n; // implemented, never written
        void insnPc;
        return null; // genuinely unimplemented → illegal instruction
      }
    }
  }

  writeCsr(addr: number, value: bigint): boolean {
    switch (addr) {
      case CSR_CYCLE: case CSR_MCYCLE:
      case CSR_INSTRET: case CSR_MINSTRET:
      case CSR_TIME:
      case CSR_MHARTID: case CSR_MISA:
        return false; // read-only
      case CSR_SATP:
        this.mmu.satp = value;
        this.mmu.invalidateAll();
        return true;
      default:
        this.csrs.set(addr, BigInt.asUintN(64, value));
        return true;
    }
  }

  // ---- memory access with MMU + faults ----
  private translate(va: bigint, kind: AccessKind): MmuResult {
    return this.mmu.translate(va, kind, (pa) => {
      const off = this.mem.physToOffset(pa);
      if (off < 0) return 0n; // non-RAM PTE reads fault as V=0
      return this.mem.readU64(off);
    });
  }

  /** Returns null and raises the trap on the CPU when the access faults. */
  private loadU(addr: bigint, size: 1 | 2 | 4 | 8, kind: AccessKind = "read"): bigint | null {
    const tr = this.translate(addr, kind);
    if (!tr.ok) {
      this.raise(tr.cause, addr);
      return null;
    }
    const off = this.mem.physToOffset(tr.pa);
    if (off < 0) {
      this.raise(kind === "read" ? 13n : 15n, addr);
      return null;
    }
    switch (size) {
      case 1: return BigInt(this.mem.readU8(off));
      case 2: return BigInt(this.mem.readU16(off));
      case 4: return BigInt(this.mem.readU32(off));
      case 8: return this.mem.readU64(off);
    }
  }

  private store(addr: bigint, size: 1 | 2 | 4 | 8, value: bigint): boolean {
    const tr = this.translate(addr, "write");
    if (!tr.ok) {
      this.raise(tr.cause, addr);
      return false;
    }
    const off = this.mem.physToOffset(tr.pa);
    if (off < 0) {
      this.raise(15n, addr);
      return false;
    }
    const v = BigInt.asUintN(64, value);
    switch (size) {
      case 1: this.mem.writeU8(off, Number(v & 0xffn)); break;
      case 2: this.mem.writeU16(off, Number(v & 0xffffn)); break;
      case 4: this.mem.writeU32(off, Number(v & 0xffffffffn)); break;
      case 8: this.mem.writeU64(off, v); break;
    }
    // Any store clears the local LR/SC reservation (conservative Phase 0
    // choice; exact address-set semantics deferred to Phase 1 — see ADR-0002).
    if (this.resValid) this.resValid = false;
    return true;
  }

  raise(cause: bigint | number, tval: bigint): void {
    const c = typeof cause === "number" ? BigInt(cause) : cause;
    // Phase 0: machine traps only; write mepc/mcause/mtval and vector.
    this.writeCsr(CSR_MEPC, this.pc);
    this.writeCsr(CSR_MCAUSE, c);
    this.writeCsr(CSR_MTVAL, tval);
    const mtvec = this.readCsr(CSR_MTVEC, this.pc) ?? 0n;
    const base = mtvec & ~3n;
    const mode = mtvec & 3n;
    if (mode === 1n && (c & 0x8000_0000_0000_0000n) !== 0n) {
      this.pc = base + 4n * (c & 0xfffn); // vectored interrupts
    } else {
      this.pc = base;
    }
    this.onTrap?.(this, c, tval);
  }

  // ---- core step ----
  /** Execute one instruction. Returns false when the CPU has halted. */
  step(): boolean {
    if (this.halted) return false;
    const pc = this.pc;
    const pcNum = this.mem.physToOffset(pc);
    if (pcNum < 0 || pcNum + 4 > this.mem.ramBytes) {
      this.raise(1n, pc); // instruction access fault
      return !this.halted;
    }
    const insn = decodeAt(this.mem.bytes, pcNum);
    this.instret += 1n;
    this.cycles += 1n;
    return this.execute(insn, pc);
  }

  /** Execute an already-decoded instruction at `pc` (shared with the JIT slow path). */
  execute(insn: Insn, pc: bigint): boolean {
    const next = pc + 4n;
    this.pc = next;

    if (insn.op === "illegal") {
      this.raise(2n, BigInt(insn.raw >>> 0));
      return !this.halted;
    }

    switch (insn.op) {
      case "lui": this.setReg(insn.rd, insn.imm); break;
      case "auipc": this.setReg(insn.rd, pc + insn.imm); break;
      case "jal": this.setReg(insn.rd, next); this.pc = pc + insn.imm; break;
      case "jalr": {
        const target = (this.getReg(insn.rs1) + insn.imm) & ~1n;
        this.setReg(insn.rd, next);
        this.pc = BigInt.asUintN(64, target);
        break;
      }

      case "beq": case "bne": case "blt": case "bge": case "bltu": case "bgeu": {
        const a = this.getReg(insn.rs1);
        const b = this.getReg(insn.rs2);
        if (evalBranch(insn.op, a, b)) this.pc = BigInt.asUintN(64, pc + insn.imm);
        break;
      }

      case "lb": case "lh": case "lw": case "ld":
      case "lbu": case "lhu": case "lwu": {
        const addr = BigInt.asUintN(64, this.getReg(insn.rs1) + insn.imm);
        const v = this.loadU(addr, loadSize(insn.op), "read");
        if (v === null) break;
        this.setReg(insn.rd, extendLoad(insn.op, v));
        break;
      }

      case "sb": case "sh": case "sw": case "sd": {
        const addr = BigInt.asUintN(64, this.getReg(insn.rs1) + insn.imm);
        this.store(addr, storeSize(insn.op), this.getReg(insn.rs2));
        break;
      }

      case "addi": this.setReg(insn.rd, this.getReg(insn.rs1) + insn.imm); break;
      case "slti": this.setReg(insn.rd, BigInt.asIntN(64, this.getReg(insn.rs1)) < insn.imm ? 1n : 0n); break;
      case "sltiu": this.setReg(insn.rd, BigInt.asUintN(64, this.getReg(insn.rs1)) < BigInt.asUintN(64, insn.imm) ? 1n : 0n); break;
      case "xori": this.setReg(insn.rd, this.getReg(insn.rs1) ^ insn.imm); break;
      case "ori": this.setReg(insn.rd, this.getReg(insn.rs1) | insn.imm); break;
      case "andi": this.setReg(insn.rd, this.getReg(insn.rs1) & insn.imm); break;
      case "slli": this.setReg(insn.rd, this.getReg(insn.rs1) << (insn.imm & 0x3fn)); break;
      case "srli": this.setReg(insn.rd, BigInt.asUintN(64, this.getReg(insn.rs1)) >> (insn.imm & 0x3fn)); break;
      case "srai": this.setReg(insn.rd, BigInt.asIntN(64, this.getReg(insn.rs1)) >> (insn.imm & 0x3fn)); break;

      case "add": this.setReg(insn.rd, this.getReg(insn.rs1) + this.getReg(insn.rs2)); break;
      case "sub": this.setReg(insn.rd, this.getReg(insn.rs1) - this.getReg(insn.rs2)); break;
      case "sll": this.setReg(insn.rd, this.getReg(insn.rs1) << (this.getReg(insn.rs2) & 0x3fn)); break;
      case "slt": this.setReg(insn.rd, BigInt.asIntN(64, this.getReg(insn.rs1)) < BigInt.asIntN(64, this.getReg(insn.rs2)) ? 1n : 0n); break;
      case "sltu": this.setReg(insn.rd, BigInt.asUintN(64, this.getReg(insn.rs1)) < BigInt.asUintN(64, this.getReg(insn.rs2)) ? 1n : 0n); break;
      case "xor": this.setReg(insn.rd, this.getReg(insn.rs1) ^ this.getReg(insn.rs2)); break;
      case "srl": this.setReg(insn.rd, BigInt.asUintN(64, this.getReg(insn.rs1)) >> (this.getReg(insn.rs2) & 0x3fn)); break;
      case "sra": this.setReg(insn.rd, BigInt.asIntN(64, this.getReg(insn.rs1)) >> (this.getReg(insn.rs2) & 0x3fn)); break;
      case "or": this.setReg(insn.rd, this.getReg(insn.rs1) | this.getReg(insn.rs2)); break;
      case "and": this.setReg(insn.rd, this.getReg(insn.rs1) & this.getReg(insn.rs2)); break;

      case "mul": this.setReg(insn.rd, this.getReg(insn.rs1) * this.getReg(insn.rs2)); break;
      case "mulh": {
        const p = BigInt.asIntN(128, BigInt.asIntN(64, this.getReg(insn.rs1)) * BigInt.asIntN(64, this.getReg(insn.rs2)));
        this.setReg(insn.rd, p >> 64n);
        break;
      }
      case "mulhu": {
        const p = BigInt.asUintN(128, BigInt.asUintN(64, this.getReg(insn.rs1)) * BigInt.asUintN(64, this.getReg(insn.rs2)));
        this.setReg(insn.rd, p >> 64n);
        break;
      }
      case "mulhsu": {
        const p = BigInt.asIntN(128, BigInt.asIntN(64, this.getReg(insn.rs1)) * BigInt.asUintN(64, this.getReg(insn.rs2)));
        this.setReg(insn.rd, p >> 64n);
        break;
      }
      case "div": case "divu": case "rem": case "remu": {
        this.execDivRem(insn.op, insn.rd, insn.rs1, insn.rs2);
        break;
      }

      case "csrrw": case "csrrs": case "csrrc":
      case "csrrwi": case "csrrsi": case "csrrci": {
        this.execCsr(insn);
        break;
      }

      case "amoadd_w": case "amoadd_d":
      case "amoswap_w": case "amoswap_d":
      case "amoxor_w": case "amoxor_d":
      case "amoand_w": case "amoand_d":
      case "amoor_w": case "amoor_d":
      case "amomin_w": case "amomin_d":
      case "amomax_w": case "amomax_d":
      case "amominu_w": case "amominu_d":
      case "amomaxu_w": case "amomaxu_d": {
        this.execAmo(insn, pc);
        break;
      }
      case "lr_w": case "lr_d": {
        const addr = this.getReg(insn.rs1);
        const size = insn.op.endsWith("_w") ? 4 : 8;
        const v = this.loadU(addr, size as 4 | 8, "read");
        if (v === null) break;
        this.resValid = true;
        this.resAddr = addr;
        this.setReg(insn.rd, size === 4 ? BigInt.asIntN(32, v) : v);
        break;
      }
      case "sc_w": case "sc_d": {
        const addr = this.getReg(insn.rs1);
        const size = insn.op.endsWith("_w") ? 4 : 8;
        if (this.resValid && this.resAddr === addr) {
          const ok = this.store(addr, size as 4 | 8, this.getReg(insn.rs2));
          this.resValid = false;
          if (ok) this.setReg(insn.rd, 0n);
          else this.setReg(insn.rd, 1n);
        } else {
          this.setReg(insn.rd, 1n);
        }
        break;
      }

      case "fence": case "fence_i": case "wfi": break; // no-ops in Phase 0
      case "sfence_vma": this.mmu.invalidateAll(); break;

      case "ecall": this.execEcall(); break;
      case "ebreak": this.raise(3n, pc); break;

      case "mret": {
        const mstatus = this.readCsr(CSR_MSTATUS, pc) ?? 0n;
        const mpie = (mstatus >> 7n) & 1n;
        let ns = (mstatus & ~(1n << 3n)) | (mpie << 3n);
        ns |= 1n << 7n; // MPIE = 1
        ns &= ~(0x3n << 11n); // MPP = U (Phase 0 runs back to U? keep M)
        ns |= 3n << 11n;
        this.writeCsr(CSR_MSTATUS, ns);
        this.pc = this.readCsr(CSR_MEPC, pc) ?? 0n;
        break;
      }
      case "sret": {
        this.pc = this.readCsr(CSR_SEPC, pc) ?? 0n;
        break;
      }
      default: {
        this.raise(2n, BigInt(insn.raw >>> 0));
        break;
      }
    }
    return !this.halted;
  }

  private execDivRem(op: Op, rd: number, rs1: number, rs2: number): void {
    const rawA = this.getReg(rs1);
    const rawB = this.getReg(rs2);
    const ua = BigInt.asUintN(64, rawA);
    const ub = BigInt.asUintN(64, rawB);
    const signed = op === "div" || op === "rem";
    const a = signed ? BigInt.asIntN(64, rawA) : rawA;
    const b = signed ? BigInt.asIntN(64, rawB) : rawB;
    if (ub === 0n) {
      // RISC-V: div by zero → -1 / all-ones; rem by zero → dividend
      this.setReg(rd, op === "div" || op === "divu" ? -1n : rawA);
      return;
    }
    if (signed && a === -0x8000_0000_0000_0000n && b === -1n) {
      this.setReg(rd, op === "div" ? a : 0n); // overflow: q = a, r = 0
      return;
    }
    switch (op) {
      case "div": this.setReg(rd, a / b); break;
      case "divu": this.setReg(rd, ua / ub); break;
      case "rem": this.setReg(rd, a % b); break;
      case "remu": this.setReg(rd, ua % ub); break;
      default: break;
    }
  }

  private execCsr(insn: Insn): void {
    const addr = Number(insn.imm & 0xfffn);
    const isImm = insn.op.endsWith("i");
    const old = this.readCsr(addr, this.pc);
    if (old === null) {
      this.raise(2n, BigInt(insn.raw >>> 0));
      return;
    }
    const src = isImm
      ? BigInt(insn.rs1) // uimm in rs1 field
      : this.getReg(insn.rs1);
    const writeVal =
      insn.op.startsWith("csrrw") ? src
      : insn.op.startsWith("csrrs") ? (old | src)
      : (old & ~src);
    const doWrite = insn.op.startsWith("csrrw") || insn.rs1 !== 0;
    if (doWrite && !this.writeCsr(addr, writeVal)) {
      this.raise(2n, BigInt(insn.raw >>> 0));
      return;
    }
    this.setReg(insn.rd, old);
  }

  private execAmo(insn: Insn, pc: bigint): void {
    const addr = this.getReg(insn.rs1);
    const isW = insn.op.endsWith("_w");
    const size = isW ? 4 : 8;
    const old = this.loadU(addr, size as 4 | 8, "write"); // AMOs need write permission
    if (old === null) return;
    const b = this.getReg(insn.rs2);
    const base = insn.op.replace(/_(w|d)$/, "");
    let next: bigint;
    switch (base) {
      case "amoadd": next = (isW ? BigInt.asIntN(32, old) : old) + (isW ? BigInt.asIntN(32, b) : b); break;
      case "amoswap": next = b; break;
      case "amoxor": next = old ^ b; break;
      case "amoand": next = old & b; break;
      case "amoor": next = old | b; break;
      case "amomin": next = (isW ? BigInt.asIntN(32, old) : BigInt.asIntN(64, old)) < (isW ? BigInt.asIntN(32, b) : BigInt.asIntN(64, b)) ? old : b; break;
      case "amomax": next = (isW ? BigInt.asIntN(32, old) : BigInt.asIntN(64, old)) > (isW ? BigInt.asIntN(32, b) : BigInt.asIntN(64, b)) ? old : b; break;
      case "amominu": next = BigInt.asUintN(64, old) < BigInt.asUintN(64, b) ? old : b; break;
      case "amomaxu": next = BigInt.asUintN(64, old) > BigInt.asUintN(64, b) ? old : b; break;
      default: this.raise(2n, BigInt(insn.raw >>> 0)); return;
    }
    if (isW) next = BigInt.asIntN(32, next);
    if (!this.store(addr, size as 4 | 8, next)) return;
    this.setReg(insn.rd, isW ? BigInt.asIntN(32, old) : old);
    void pc;
  }

  private execEcall(): void {
    const syscall = this.getReg(17); // a7
    const args = [10, 11, 12, 13, 14, 15].map((r) => this.getReg(r));
    if (this.onSyscall?.(this, syscall, args)) return;
    if (syscall === EXIT_SYSCALL) {
      this.halted = true;
      this.exitCode = Number(BigInt.asIntN(32, args[0] ?? 0n));
      return;
    }
    if (syscall === WRITE_SYSCALL) {
      const [, buf, len] = args;
      const off = this.mem.physToOffset(buf ?? 0n);
      if (off >= 0 && len && len > 0n) {
        const slice = this.mem.bytes.subarray(off, off + Number(len));
        const text = new TextDecoder().decode(slice);
        if (this.captureOutput) this.output += text;
        else if (typeof process !== "undefined") process.stdout.write(text);
      }
      this.setReg(10, len ?? 0n); // return count
      return;
    }
    // Unknown syscall: Linux semantics — ENOSYS (-38)
    this.setReg(10, -38n);
  }

  /** Run up to `maxSteps` instructions; stops on halt. */
  run(maxSteps: number): CpuExit {
    for (let i = 0; i < maxSteps; i++) {
      if (!this.step()) break;
    }
    if (this.halted) return { kind: "exit", code: this.exitCode };
    const mcause = this.readCsr(CSR_MCAUSE, this.pc) ?? 0n;
    return { kind: "trap", cause: mcause, pc: this.pc };
  }
}

function evalBranch(op: Op, a: bigint, b: bigint): boolean {
  const ua = BigInt.asUintN(64, a);
  const ub = BigInt.asUintN(64, b);
  const sa = BigInt.asIntN(64, a);
  const sb = BigInt.asIntN(64, b);
  switch (op) {
    case "beq": return ua === ub;
    case "bne": return ua !== ub;
    case "blt": return sa < sb;
    case "bge": return sa >= sb;
    case "bltu": return ua < ub;
    case "bgeu": return ua >= ub;
    default: return false;
  }
}

function loadSize(op: Op): 1 | 2 | 4 | 8 {
  if (op === "lb" || op === "lbu") return 1;
  if (op === "lh" || op === "lhu") return 2;
  if (op === "lw" || op === "lwu") return 4;
  return 8;
}

function storeSize(op: Op): 1 | 2 | 4 | 8 {
  if (op === "sb") return 1;
  if (op === "sh") return 2;
  if (op === "sw") return 4;
  return 8;
}

function extendLoad(op: Op, v: bigint): bigint {
  switch (op) {
    case "lb": return BigInt.asIntN(8, v);
    case "lh": return BigInt.asIntN(16, v);
    case "lw": return BigInt.asIntN(32, v);
    default: return v;
  }
}

export { SIGN32 };
