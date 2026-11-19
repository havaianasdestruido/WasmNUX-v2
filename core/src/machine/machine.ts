/**
 * The spike machine: guest RAM, MMIO devices, a syscall ABI and the tiered CPU.
 *
 * It is deliberately the *smallest* machine that can run a benchmark kernel and
 * report numbers: physical addressing only (no MMU - that keeps the JIT's
 * address arithmetic a single subtraction, and Phase 0 never runs a kernel that
 * needs paging), QEMU-`virt` device addresses, and a Linux syscall subset plus
 * a few WasmNUX calls for instrumentation.
 *
 * Everything here is measured: `stats()` returns the counters the benchmark
 * harness records per commit (ROADMAP §4 KPI table).
 */

import { CAUSE, CSR, CpuState, type StopReason } from '../cpu/state.ts';
import { Interpreter, type MachinePort } from '../cpu/interp.ts';
import { Engine, type EngineOptions, type EngineStats } from '../jit/engine.ts';
import { DeviceBus, type Device } from '../devices/bus.ts';
import { StringUartSink, Uart, UART_BASE, type UartSink } from '../devices/uart.ts';
import { Clint, Plic, TestFinisher, TEST_FAIL, TEST_PASS } from '../devices/clint.ts';
import { DEFAULT_RAM_BASE, GuestMemory, MMIO } from './memory.ts';
import { isElf, parseElf32 } from './elf.ts';

export { TEST_PASS, TEST_FAIL };

/** Linux riscv32 syscall numbers used by the spike ABI. */
export const SYS = {
  read: 63,
  write: 64,
  exit: 93,
  exit_group: 94,
  brk: 214,
} as const;

/**
 * WasmNUX-specific calls, above the Linux range so a stock libc never collides.
 * `report` is how a benchmark kernel publishes a KPI without a filesystem.
 */
export const WNX_SYS = {
  /** report(a0 = NUL-terminated name, a1 = value) */
  report: 1000,
  /** mark(a0 = name): timestamp a phase boundary */
  mark: 1001,
  /** poweroff(a0 = exit code) */
  poweroff: 1002,
} as const;

const EBADF = -9;
const EINVAL = -22;

export interface MachineOptions {
  ramBytes?: number;
  ramBase?: number;
  /** SharedArrayBuffer-backed RAM: required for SMP and for Wasm atomics. */
  shared?: boolean;
  /** Control page after RAM (the `regalloc: 'memory'` register file). */
  controlPage?: boolean;
  harts?: number;
  uartSink?: UartSink;
  /** `false` for the interpreter-only baseline, or engine options for the JIT. */
  jit?: boolean | EngineOptions;
  now?: () => bigint;
  onFinish?: (code: number, failed: boolean) => void;
  /** Instructions between device ticks and interrupt delivery. */
  tickInterval?: number;
  /** Attach an existing memory (vCPU workers share one). */
  memory?: WebAssembly.Memory;
}

export interface BenchmarkReport {
  name: string;
  value: number;
  /** Instructions retired when the report was made. */
  atInstruction: number;
}

export interface MachineStats {
  instructions: number;
  jitInstructions: number;
  interpInstructions: number;
  regionsCompiled: number;
  blocksCompiled: number;
  wasmBytes: number;
  compileMs: number;
  instantiateMs: number;
  cacheHits: number;
  hostExits: number;
  syscalls: number;
  mmioReads: number;
  mmioWrites: number;
  traps: number;
  /** Regions retired because they exited to the host too often to pay for themselves. */
  tierDowns: number;
  wallMs: number;
  /** Retired instructions per second over the last `run()` call. */
  ips: number;
}

export class Machine implements MachinePort {
  readonly mem: GuestMemory;
  readonly bus: DeviceBus;
  readonly cpu: CpuState;
  readonly uart: Uart;
  readonly clint: Clint;
  readonly plic: Plic;
  readonly finisher: TestFinisher;
  readonly engine: Engine;
  readonly interp: Interpreter;
  readonly reports: BenchmarkReport[] = [];
  readonly marks: Array<{ name: string; atInstruction: number }> = [];

  private heapBase = 0;
  private heapEnd = 0;
  private startedAt = 0;
  private lastRunMs = 0;
  private lastRunInstructions = 0;
  private mmioReads = 0;
  private mmioWrites = 0;
  private entry = 0;
  /** Instructions between device/interrupt slices. */
  readonly tickInterval: number;

  constructor(private readonly opts: MachineOptions = {}) {
    this.mem = new GuestMemory({
      ramBytes: opts.ramBytes ?? 16 << 20,
      ramBase: opts.ramBase ?? DEFAULT_RAM_BASE,
      shared: opts.shared ?? false,
      controlPage: opts.controlPage ?? false,
      memory: opts.memory,
    });
    this.cpu = new CpuState({ pc: this.mem.ramBase });
    const sink = opts.uartSink ?? new StringUartSink();
    this.uart = new Uart(sink, MMIO.uart);
    this.clint = new Clint({ harts: opts.harts ?? 1, now: opts.now });
    this.plic = new Plic(opts.harts ?? 1);
    this.finisher = new TestFinisher({
      onFinish: (code, failed) => {
        this.cpu.stop = failed ? 'error' : 'exit';
        this.cpu.exitCode = failed ? 1 : 0;
        opts.onFinish?.(code, failed);
      },
    });
    // 64 Ki instructions per slice: at ~1 GIPS that is ~65 us, far finer than the
    // 10 MHz mtime needs, and small enough that register-file sync (the dominant
    // per-slice cost, measured in spike A) stays under a percent of runtime.
    this.tickInterval = opts.tickInterval ?? 65536;
    this.bus = new DeviceBus().add(this.uart).add(this.clint).add(this.plic).add(this.finisher);
    this.interp = new Interpreter(this);
    const engineOpts: EngineOptions =
      typeof opts.jit === 'object' && opts.jit !== null ? opts.jit : { jit: opts.jit !== false };
    this.engine = new Engine(this, this.mem, engineOpts);
  }

  get uartSinkText(): string {
    return this.opts.uartSink instanceof StringUartSink ? this.opts.uartSink.text : '';
  }

  // -- loading --------------------------------------------------------------

  /**
   * Load a flat image or an ELF32 file. Returns the entry point.
   *
   * Flat images are placed at `base` (default: RAM base). ELF segments are
   * placed at their own virtual addresses, which must already lie inside RAM -
   * the linker script in `benchmarks/suites` does that.
   */
  load(image: Uint8Array, base = this.mem.ramBase): number {
    if (isElf(image)) return this.loadElf(image);
    const off = this.mem.ramOffset(base >>> 0);
    if (off < 0) throw new Error(`load base 0x${(base >>> 0).toString(16)} is not guest RAM`);
    if (off + image.length > this.mem.ramSize) throw new Error('image does not fit in guest RAM');
    this.mem.u8.set(image, off);
    this.entry = base >>> 0;
    this.heapBase = (this.mem.ramBase + this.mem.ramSize - (4 << 20)) >>> 0; // top 4 MiB is heap
    this.heapEnd = this.heapBase;
    return this.entry;
  }

  private loadElf(image: Uint8Array): number {
    const elf = parseElf32(image);
    for (const seg of elf.segments) {
      const off = this.mem.ramOffset(seg.vaddr);
      if (off < 0) throw new Error(`ELF segment at 0x${seg.vaddr.toString(16)} is outside guest RAM`);
      if (off + seg.memSize > this.mem.ramSize) throw new Error('ELF segment does not fit in guest RAM');
      this.mem.u8.fill(0, off, off + seg.memSize); // .bss
      this.mem.u8.set(seg.bytes, off);
    }
    this.entry = elf.entry;
    const hi = (elf.hi + 0xfff) & ~0xfff;
    this.heapBase = Math.max(hi, this.mem.ramBase) >>> 0;
    this.heapEnd = this.heapBase;
    return this.entry;
  }

  /** Reset the CPU, keeping RAM. `sp` starts at the top of RAM minus the heap. */
  reset(entry = this.entry, stackTop?: number): void {
    this.cpu.regs.fill(0);
    this.cpu.pc = entry >>> 0;
    this.cpu.stop = 'running';
    this.cpu.exitCode = 0;
    this.cpu.instret = 0;
    this.cpu.cycles = 0;
    this.cpu.lrValid = false;
    this.cpu.setReg(2, (stackTop ?? this.heapBase) >>> 0); // sp
    this.cpu.setReg(4, 0); // tp (thread pointer; unused by the spike)
    this.engine.reset();
    this.reports.length = 0;
    this.marks.length = 0;
  }

  // -- execution ------------------------------------------------------------

  /**
   * Run up to `budget` instructions. Returns why execution stopped.
   *
   * Execution is sliced: after every `tickInterval` instructions the machine
   * advances mtime, refreshes mip from the CLINT and delivers a pending
   * interrupt. Without slicing, a benchmark that runs for 1e8 instructions would
   * see a frozen clock and no timer interrupts at all.
   */
  run(budget: number): StopReason {
    const t0 = performance.now();
    const before = this.cpu.instret;
    let left = budget;
    let retired = 0;
    while (left > 0 && this.cpu.stop === 'running') {
      const chunk = Math.min(left, this.tickInterval);
      const at = this.cpu.instret;
      this.engine.run(this.cpu, chunk);
      const n = this.cpu.instret - at;
      retired += n;
      left -= Math.max(n, 1); // a chunk that retired nothing must still make progress
      this.clint.tick(this.nowNs());
      this.refreshInterruptState();
      this.deliverInterrupts(); // trap entry redirects pc; the run continues
    }
    this.lastRunMs = performance.now() - t0;
    this.lastRunInstructions = retired;
    return this.cpu.stop;
  }

  /** Single-step, JIT or interpreter depending on what covers the pc. */
  step(): void {
    this.engine.run(this.cpu, 1);
  }

  private nowNs(): bigint {
    return BigInt(Math.round(performance.now() * 1e6));
  }

  /**
   * Deliver a pending machine timer/software interrupt.
   *
   * The interpreter takes synchronous traps itself; asynchronous ones are the
   * machine's job because they can only be observed between instruction chunks.
   * Delegation (medeleg/mideleg) and S-mode delivery land with the MMU work in
   * Phase 1 - M-mode is enough for the SMP spike, where an IPI wakes a worker.
   */
  deliverInterrupts(): boolean {
    const mip = this.cpu.readCsr(CSR.mip) | 0;
    if (!mip) return false;
    const mie = this.cpu.readCsr(CSR.mie) | 0;
    const mstatus = this.cpu.readCsr(CSR.mstatus) | 0;
    if (!(mstatus & (1 << 3))) return false; // MIE
    const enabled = mip & mie;
    if (!enabled) return false;
    // RISC-V interrupt priority: MEI > MSI > MTI.
    let cause = -1;
    if (enabled & (1 << 11)) cause = 11;
    else if (enabled & (1 << 3)) cause = 3;
    else if (enabled & (1 << 7)) cause = 7;
    if (cause < 0) return false;

    this.cpu.writeCsr(CSR.mepc, this.cpu.pc);
    this.cpu.writeCsr(CSR.mcause, (0x80000000 | cause) | 0);
    this.cpu.writeCsr(CSR.mtval, 0);
    this.cpu.writeCsr(CSR.mip, mip & ~(1 << cause));
    // Trap entry clears MIE and remembers it in MPIE.
    this.cpu.writeCsr(CSR.mstatus, ((mstatus & ~(1 << 3)) | ((mstatus & (1 << 3)) << 4)) | 0);
    const mtvec = this.cpu.readCsr(CSR.mtvec) >>> 0;
    this.cpu.pc = (mtvec & ~3) >>> 0; // direct mode; vectored mode is Phase 1
    this.engine.invalidateAll('interrupt');
    return true;
  }

  /** Update mip from the CLINT. Called by `run()` and by tests. */
  refreshInterruptState(): void {
    let mip = this.cpu.readCsr(CSR.mip) | 0;
    const timer = this.clint.timerInterruptPending(this.cpu.hartId);
    const soft = this.clint.softwareInterruptPending(this.cpu.hartId);
    mip = timer ? mip | (1 << 7) : mip & ~(1 << 7);
    mip = soft ? mip | (1 << 3) : mip & ~(1 << 3);
    this.cpu.writeCsr(CSR.mip, mip);
  }

  // -- MachinePort ----------------------------------------------------------

  onSyscall(cpu: CpuState): void {
    const nr = cpu.reg(17) >>> 0; // a7
    const a0 = cpu.reg(10);
    const a1 = cpu.reg(11);
    const a2 = cpu.reg(12);
    switch (nr) {
      case SYS.write: {
        const fd = a0;
        if (fd !== 1 && fd !== 2) {
          cpu.setReg(10, EBADF);
          return;
        }
        const buf = a1 >>> 0;
        const count = a2 >>> 0;
        let written = 0;
        for (let i = 0; i < count; i++) {
          const off = this.mem.ramOffset((buf + i) >>> 0);
          if (off < 0) break;
          this.uart.write(0, 1, this.mem.u8[off]!);
          written++;
        }
        cpu.setReg(10, written);
        return;
      }
      case SYS.read: {
        if (a0 !== 0) {
          cpu.setReg(10, EBADF);
          return;
        }
        const buf = a1 >>> 0;
        const count = a2 >>> 0;
        let n = 0;
        while (n < count && this.uart.pendingInput > 0) {
          const off = this.mem.ramOffset((buf + n) >>> 0);
          if (off < 0) break;
          this.mem.u8[off] = this.uart.read(0, 1) & 0xff;
          n++;
        }
        cpu.setReg(10, n);
        return;
      }
      case SYS.exit:
      case SYS.exit_group:
        cpu.stop = 'exit';
        cpu.exitCode = a0 | 0;
        return;
      case SYS.brk: {
        const want = a0 >>> 0;
        if (want === 0) {
          cpu.setReg(10, this.heapEnd);
          return;
        }
        const limit = (this.mem.ramBase + this.mem.ramSize) >>> 0;
        if (want < this.heapBase || want > limit) {
          cpu.setReg(10, this.heapEnd);
          return;
        }
        this.heapEnd = want;
        cpu.setReg(10, this.heapEnd);
        return;
      }
      case WNX_SYS.report: {
        const name = this.readString(a0 >>> 0);
        this.reports.push({ name, value: a1 | 0, atInstruction: cpu.instret });
        cpu.setReg(10, 0);
        return;
      }
      case WNX_SYS.mark:
        this.marks.push({ name: this.readString(a0 >>> 0), atInstruction: cpu.instret });
        cpu.setReg(10, 0);
        return;
      case WNX_SYS.poweroff:
        cpu.stop = 'exit';
        cpu.exitCode = a0 | 0;
        return;
      default:
        // Unimplemented: report -ENOSYS rather than trapping, so a benchmark
        // that probes for a feature keeps running.
        cpu.setReg(10, -38);
        return;
    }
  }

  onMMIORead(cpu: CpuState, addr: number, size: number): number {
    this.mmioReads++;
    const value = this.bus.read(addr >>> 0, size);
    if (value === null) {
      this.trap(cpu, CAUSE.LOAD_ACCESS_FAULT, addr >>> 0);
      return 0;
    }
    return value;
  }

  onMMIOWrite(cpu: CpuState, addr: number, size: number, value: number): void {
    this.mmioWrites++;
    if (!this.bus.write(addr >>> 0, size, value)) {
      this.trap(cpu, CAUSE.STORE_ACCESS_FAULT, addr >>> 0);
    }
  }

  onIdle(cpu: CpuState): boolean {
    // WFI: with a CLINT timer armed, advance to the deadline instead of burning
    // host time. That is the "no spin" property the SMP spike measures.
    this.refreshInterruptState();
    if (cpu.readCsr(CSR.mip) & cpu.readCsr(CSR.mie)) return true;
    return false;
  }

  private trap(cpu: CpuState, cause: number, tval: number): void {
    cpu.cause = cause;
    cpu.tval = tval;
    cpu.writeCsr(CSR.mepc, cpu.pc);
    cpu.writeCsr(CSR.mcause, cause);
    cpu.writeCsr(CSR.mtval, tval);
    const mtvec = cpu.readCsr(CSR.mtvec) >>> 0;
    if (mtvec === 0) {
      // No handler installed: this is a fatal fault for the spike.
      cpu.stop = 'trap';
      return;
    }
    cpu.pc = (mtvec & ~3) >>> 0;
    this.engine.invalidateAll('trap');
  }

  private readString(addr: number, max = 256): string {
    const off = this.mem.ramOffset(addr >>> 0);
    if (off < 0) return '';
    let out = '';
    for (let i = 0; i < max; i++) {
      const b = this.mem.u8[off + i];
      if (!b) break;
      out += String.fromCharCode(b);
    }
    return out;
  }

  // -- metrics --------------------------------------------------------------

  stats(): MachineStats {
    const jit: EngineStats = this.engine.stats;
    return {
      instructions: this.cpu.instret,
      jitInstructions: jit.jitInstructions,
      interpInstructions: jit.interpInstructions,
      regionsCompiled: jit.regionsCompiled,
      blocksCompiled: jit.blocksCompiled,
      wasmBytes: jit.wasmBytes,
      compileMs: jit.compileMs,
      instantiateMs: jit.instantiateMs,
      cacheHits: jit.cacheHits,
      hostExits: jit.hostExits,
      syscalls: jit.syscalls,
      mmioReads: this.mmioReads,
      mmioWrites: this.mmioWrites,
      traps: jit.wasmTraps,
      tierDowns: jit.tierDowns,
      wallMs: this.lastRunMs,
      ips: this.lastRunMs > 0 ? (this.lastRunInstructions / this.lastRunMs) * 1000 : 0,
    };
  }

  /** Devices, for tests and for the host's device bridge. */
  devices(): readonly Device[] {
    return this.bus.all;
  }
}

/** Convenience: a machine whose console is captured as a string. */
export function headlessMachine(opts: MachineOptions = {}): { machine: Machine; sink: StringUartSink } {
  const sink = new StringUartSink();
  return { machine: new Machine({ ...opts, uartSink: sink }), sink };
}

export { UART_BASE };
