/**
 * Architectural CPU state, stop reasons and the CSR file.
 *
 * One `CpuState` per vCPU. The interpreter mutates it directly; the JIT keeps
 * the same values in imported Wasm globals and syncs them back on every exit
 * (see `core/src/jit/regfile.ts`), so a snapshot taken while either tier is
 * running looks identical.
 */

export const RV32_REG_COUNT = 32;

/** Why a run stopped. `running` means "budget exhausted but not finished". */
export type StopReason = 'running' | 'exit' | 'idle' | 'syscall' | 'mmio' | 'trap' | 'breakpoint' | 'error';

/** Exit reasons returned by compiled regions (kept dense: they are compared in hot loops). */
export const EXIT = {
  /** Instruction budget ran out; control returns to the host dispatcher. */
  BUDGET: 1,
  /** ECALL - Linux-ABI syscall handled by the machine. */
  SYSCALL: 2,
  /** A load/store faulted out of RAM; the host decodes it as MMIO or a trap. */
  FAULT: 3,
  /** WFI - the vCPU is idle and may be parked on `Atomics.wait`. */
  IDLE: 4,
  /** EBREAK. */
  BREAK: 5,
  /** CSR access - rare, handled by the interpreter. */
  CSR: 6,
  /** The JIT declined this pc; the interpreter should execute it (illegal, CSR, ran off RAM). */
  RETIRE: 7,
  /** Control left the compiled region for a pc the host must resolve. */
  CHAIN: 8,
  /** Internal error: the entry block index was out of range. */
  INVALID: 9,
} as const;

export type ExitReasonCode = (typeof EXIT)[keyof typeof EXIT];

/** RISC-V exception codes we care about in Phase 0. */
export const CAUSE = {
  INSTRUCTION_ADDRESS_MISALIGNED: 0,
  INSTRUCTION_ACCESS_FAULT: 1,
  ILLEGAL_INSTRUCTION: 2,
  BREAKPOINT: 3,
  LOAD_ADDRESS_MISALIGNED: 4,
  LOAD_ACCESS_FAULT: 5,
  STORE_ADDRESS_MISALIGNED: 6,
  STORE_ACCESS_FAULT: 7,
  ECALL_FROM_U: 8,
  ECALL_FROM_S: 9,
  ECALL_FROM_M: 11,
} as const;

export const CSR = {
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
  cycle: 0xc00,
  time: 0xc01,
  instret: 0xc02,
} as const;

export interface CpuStateInit {
  pc?: number;
  hartId?: number;
  regs?: ArrayLike<number>;
}

export class CpuState {
  /** x0 is hardwired to zero; writes to it are discarded on store-back. */
  readonly regs = new Int32Array(RV32_REG_COUNT);
  pc = 0;
  hartId = 0;

  /** A-extension reservation (LR.W / SC.W). */
  lrAddr = 0;
  lrValue = 0;
  lrValid = false;

  /** Counters, mirrored into `mcycle` / `minstret`. */
  instret = 0;
  cycles = 0;

  stop: StopReason = 'running';
  exitCode = 0;
  /** Trap details: cause and faulting address. */
  cause = 0;
  tval = 0;

  /** Minimal CSR file. Counters are read through, the rest are plain storage. */
  readonly csrs = new Map<number, number>();

  constructor(init: CpuStateInit = {}) {
    this.pc = (init.pc ?? 0) >>> 0;
    this.hartId = init.hartId ?? 0;
    if (init.regs) for (let i = 1; i < RV32_REG_COUNT; i++) this.regs[i] = init.regs[i] ?? 0;
    this.csrs.set(CSR.misa, 0x40001105); // RV32, I M A + the "MXL=1" (32-bit) field
    this.csrs.set(CSR.mhartid, this.hartId);
  }

  /** Write a register, honouring the hardwired zero of x0. */
  setReg(i: number, v: number): void {
    if (i !== 0) this.regs[i] = v | 0;
  }

  reg(i: number): number {
    return i === 0 ? 0 : this.regs[i]!;
  }

  readCsr(addr: number): number {
    switch (addr) {
      case CSR.mcycle:
      case CSR.cycle:
        return this.cycles | 0;
      case CSR.minstret:
      case CSR.instret:
        return this.instret | 0;
      case CSR.mhartid:
        return this.hartId;
      case CSR.time:
        return this.csrs.get(CSR.time) ?? 0;
      default:
        return this.csrs.get(addr) ?? 0;
    }
  }

  writeCsr(addr: number, value: number): void {
    switch (addr) {
      case CSR.mcycle:
        this.cycles = value | 0;
        return;
      case CSR.minstret:
        this.instret = value | 0;
        return;
      case CSR.cycle:
      case CSR.instret:
      case CSR.time:
      case CSR.mhartid:
      case CSR.misa:
        return; // read-only in our implementation
      default:
        this.csrs.set(addr, value | 0);
    }
  }

  /** Serializable form used by snapshots. */
  toJSON(): Record<string, unknown> {
    return {
      pc: this.pc >>> 0,
      hartId: this.hartId,
      regs: Array.from(this.regs),
      lrAddr: this.lrAddr >>> 0,
      lrValue: this.lrValue | 0,
      lrValid: this.lrValid,
      instret: this.instret,
      cycles: this.cycles,
      stop: this.stop,
      exitCode: this.exitCode,
      cause: this.cause,
      tval: this.tval,
      csrs: Array.from(this.csrs.entries()),
    };
  }

  static fromJSON(json: Record<string, unknown>): CpuState {
    const cpu = new CpuState({ pc: json['pc'] as number, hartId: json['hartId'] as number });
    const regs = json['regs'] as number[];
    for (let i = 0; i < RV32_REG_COUNT; i++) cpu.regs[i] = regs[i] ?? 0;
    cpu.lrAddr = json['lrAddr'] as number;
    cpu.lrValue = json['lrValue'] as number;
    cpu.lrValid = json['lrValid'] as boolean;
    cpu.instret = json['instret'] as number;
    cpu.cycles = json['cycles'] as number;
    cpu.stop = json['stop'] as StopReason;
    cpu.exitCode = json['exitCode'] as number;
    cpu.cause = json['cause'] as number;
    cpu.tval = json['tval'] as number;
    for (const [k, v] of json['csrs'] as Array<[number, number]>) cpu.csrs.set(k, v);
    return cpu;
  }
}
