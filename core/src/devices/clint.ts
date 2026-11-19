/**
 * CLINT (core-local interruptor) at the QEMU `virt` address, plus the
 * sifive_test finisher and a minimal PLIC.
 *
 * The CLINT is what makes the SMP spike possible: `mtime` is shared by every
 * hart and each hart owns an `msip` word, so a vCPU worker can be woken with a
 * single `Atomics.store` + `Atomics.notify` on guest RAM instead of spinning
 * (see docs/spikes/spike-b-smp.md).
 *
 * The PLIC here implements the register layout and priority/threshold semantics
 * but keeps claim/complete simple; full level-triggered wiring lands with the
 * device work in Phase 1.
 */

import { truncate, type Device } from './bus.ts';

export const CLINT_BASE = 0x02000000;
export const CLINT_SIZE = 0x10000;
export const TEST_BASE = 0x00100000;
export const TEST_SIZE = 0x1000;
export const PLIC_BASE = 0x0c000000;
export const PLIC_SIZE = 0x4000000;

/** CLINT register offsets. */
const MSIP = 0x0000; // 4 bytes per hart
const MTIMECMP = 0x4000; // 8 bytes per hart
const MTIME = 0xbff8; // 8 bytes, shared

export interface ClintOptions {
  harts?: number;
  /** Time source in nanoseconds; defaults to the host monotonic clock. */
  now?: () => bigint;
  /** Called when a hart's timer interrupt becomes pending. */
  onTimerPending?: (hart: number, pending: boolean) => void;
  /** Called when a hart's software interrupt is raised by another hart. */
  onSoftwareInterrupt?: (hart: number) => void;
}

export class Clint implements Device {
  readonly name = 'clint';
  readonly base = CLINT_BASE;
  readonly size = CLINT_SIZE;
  readonly harts: number;

  private readonly msip: Int32Array;
  private readonly mtimecmp: BigInt64Array;
  private mtime = 0n;
  private readonly now: () => bigint;
  /** CLINT timebase: QEMU virt runs mtime at 10 MHz. */
  static readonly FREQ_HZ = 10_000_000;

  constructor(opts: ClintOptions = {}) {
    this.harts = opts.harts ?? 1;
    this.msip = new Int32Array(this.harts);
    this.mtimecmp = new BigInt64Array(this.harts).fill(0xffffffffffffffffn);
    this.now = opts.now ?? (() => BigInt(Math.round(performance.now() * 1e6)));
    this.onTimerPending = opts.onTimerPending ?? (() => {});
    this.onSoftwareInterrupt = opts.onSoftwareInterrupt ?? (() => {});
    this.mtime = this.nowNsToMtime(this.now());
  }

  private readonly onTimerPending: (hart: number, pending: boolean) => void;
  private readonly onSoftwareInterrupt: (hart: number) => void;
  private epochNs = 0n;

  private nowNsToMtime(ns: bigint): bigint {
    return ns / (1_000_000_000n / BigInt(Clint.FREQ_HZ));
  }

  /** Refresh mtime from the clock and re-evaluate timer interrupts. */
  tick(nowNs: bigint): void {
    if (this.epochNs === 0n) this.epochNs = nowNs;
    this.mtime = this.nowNsToMtime(nowNs - this.epochNs);
    for (let h = 0; h < this.harts; h++) {
      this.onTimerPending(h, this.mtime >= this.mtimecmp[h]!);
    }
  }

  get time(): bigint {
    return this.mtime;
  }

  /** Set a hart's timer comparator (used by tests to force an interrupt). */
  setCompare(hart: number, value: bigint): void {
    this.mtimecmp[hart] = value;
    this.onTimerPending(hart, this.mtime >= value);
  }

  softwareInterruptPending(hart: number): boolean {
    return (this.msip[hart] ?? 0) !== 0;
  }

  timerInterruptPending(hart: number): boolean {
    return this.mtime >= (this.mtimecmp[hart] ?? 0xffffffffffffffffn);
  }

  read(offset: number, size: number): number {
    if (size === 8) {
      const v = this.read64(offset);
      // The interpreter's MMIO path is 32-bit wide; the machine splits 64-bit
      // accesses into two reads, so this branch is only for direct callers.
      return Number(v & 0xffffffffn) | 0;
    }
    return this.read32(offset);
  }

  read32(offset: number): number {
    if (offset >= MTIME && offset < MTIME + 8) {
      return offset === MTIME ? Number(this.mtime & 0xffffffffn) | 0 : Number((this.mtime >> 32n) & 0xffffffffn) | 0;
    }
    if (offset >= MTIMECMP && offset < MTIMECMP + this.harts * 8) {
      const hart = (offset - MTIMECMP) >> 3;
      const v = this.mtimecmp[hart] ?? 0n;
      return (offset - MTIMECMP) % 8 === 0 ? Number(v & 0xffffffffn) | 0 : Number((v >> 32n) & 0xffffffffn) | 0;
    }
    if (offset >= MSIP && offset < MSIP + this.harts * 4) {
      return this.msip[offset >> 2] ?? 0;
    }
    return 0;
  }

  private read64(offset: number): bigint {
    if (offset >= MTIME && offset < MTIME + 8) return this.mtime;
    if (offset >= MTIMECMP && offset < MTIMECMP + this.harts * 8) {
      return this.mtimecmp[(offset - MTIMECMP) >> 3] ?? 0n;
    }
    return BigInt(this.read32(offset));
  }

  write(offset: number, size: number, value: number): void {
    const v = truncate(value, size);
    if (offset >= MTIME && offset < MTIME + 8) {
      // mtime is writable in the spec; guests normally only read it.
      if (offset === MTIME) this.mtime = (this.mtime & ~0xffffffffn) | BigInt(v >>> 0);
      else this.mtime = (this.mtime & 0xffffffffn) | (BigInt(v >>> 0) << 32n);
      return;
    }
    if (offset >= MTIMECMP && offset < MTIMECMP + this.harts * 8) {
      const hart = (offset - MTIMECMP) >> 3;
      const cur = this.mtimecmp[hart] ?? 0n;
      this.mtimecmp[hart] = (offset - MTIMECMP) % 8 === 0
        ? (cur & ~0xffffffffn) | BigInt(v >>> 0)
        : (cur & 0xffffffffn) | (BigInt(v >>> 0) << 32n);
      this.onTimerPending(hart, this.mtime >= this.mtimecmp[hart]!);
      return;
    }
    if (offset >= MSIP && offset < MSIP + this.harts * 4) {
      const hart = offset >> 2;
      this.msip[hart] = v & 1;
      if ((v & 1) !== 0) this.onSoftwareInterrupt(hart);
      return;
    }
  }

  /** Raise a hart's software interrupt from the host (cross-vCPU IPI). */
  raiseSoftwareInterrupt(hart: number): void {
    this.msip[hart] = 1;
    this.onSoftwareInterrupt(hart);
  }

  clearSoftwareInterrupt(hart: number): void {
    this.msip[hart] = 0;
  }
}

/** sifive_test: writing a code ends the simulation. */
export const TEST_PASS = 0x5555;
export const TEST_FAIL = 0x3333;

export interface TestFinisherOptions {
  onFinish(code: number, failed: boolean): void;
}

export class TestFinisher implements Device {
  readonly name = 'sifive_test';
  readonly base = TEST_BASE;
  readonly size = TEST_SIZE;
  /** Last code written, for tests that inspect instead of exiting. */
  lastCode = 0;
  finished = false;

  constructor(private readonly opts: TestFinisherOptions) {}

  read(): number {
    return 0;
  }

  write(_offset: number, _size: number, value: number): void {
    const code = value & 0xffff;
    if (code !== TEST_PASS && code !== TEST_FAIL) return;
    this.lastCode = code;
    this.finished = true;
    this.opts.onFinish(code, code === TEST_FAIL);
  }
}

/**
 * Minimal PLIC: priorities, enable bits, threshold, claim/complete.
 *
 * Only the parts a driver actually pokes during boot are modelled; the wiring
 * from a device's interrupt line to a context is `raise(irq, level)`.
 */
export class Plic implements Device {
  readonly name = 'plic';
  readonly base = PLIC_BASE;
  readonly size = PLIC_SIZE;

  private readonly priority: Int32Array;
  private readonly pending: Set<number> = new Set();
  private readonly claimed: Set<number> = new Set();
  /** context -> { threshold, enables } */
  private readonly contexts: Array<{ threshold: number; enables: Set<number> }>;

  constructor(private readonly harts = 1, private readonly maxIrqs = 1024) {
    this.priority = new Int32Array(maxIrqs + 1);
    // Two contexts per hart (S-mode then M-mode), as on QEMU virt.
    this.contexts = Array.from({ length: harts * 2 }, () => ({ threshold: 0, enables: new Set<number>() }));
  }

  raise(irq: number, level: boolean): void {
    if (level) this.pending.add(irq);
    else this.pending.delete(irq);
  }

  /** Best pending-and-enabled irq for a context, or 0. */
  bestFor(context: number): number {
    const ctx = this.contexts[context];
    if (!ctx) return 0;
    let best = 0;
    let bestPri = ctx.threshold;
    for (const irq of this.pending) {
      if (!ctx.enables.has(irq)) continue;
      if (this.claimed.has(irq)) continue;
      const pri = this.priority[irq] ?? 0;
      if (pri > bestPri) {
        best = irq;
        bestPri = pri;
      }
    }
    return best;
  }

  read(offset: number, size: number): number {
    const v = truncate(size === 4 ? this.read32(offset) : 0, size);
    return v;
  }

  private read32(offset: number): number {
    if (offset < 0x1000) return this.priority[offset >> 2] ?? 0;
    if (offset >= 0x1000 && offset < 0x2000) {
      // Pending bits, one per 32 irqs.
      const word = (offset - 0x1000) >> 2;
      let v = 0;
      for (const irq of this.pending) {
        if ((irq >> 5) === word) v |= 1 << (irq & 31);
      }
      return v;
    }
    if (offset >= 0x2000 && offset < 0x2000 + this.contexts.length * 0x100) {
      const ctxIdx = (offset - 0x2000) / 0x100 | 0;
      const within = offset - 0x2000 - ctxIdx * 0x100;
      const ctx = this.contexts[ctxIdx]!;
      if (within < 0x80) {
        const word = within >> 2;
        let v = 0;
        for (const irq of ctx.enables) if ((irq >> 5) === word) v |= 1 << (irq & 31);
        return v;
      }
      if (within === 0x80) return ctx.threshold;
      return 0;
    }
    if (offset >= 0x200000) {
      // Claim register: context = (offset - 0x200000) / 0x1000
      const ctxIdx = ((offset - 0x200000) >> 12) | 0;
      const irq = this.bestFor(ctxIdx);
      if (irq) {
        this.claimed.add(irq);
        this.pending.delete(irq);
      }
      return irq;
    }
    return 0;
  }

  write(offset: number, size: number, value: number): void {
    if (size !== 4) return;
    const v = value | 0;
    if (offset < 0x1000) {
      const irq = offset >> 2;
      if (irq < this.priority.length) this.priority[irq] = v & 7;
      return;
    }
    if (offset >= 0x2000 && offset < 0x2000 + this.contexts.length * 0x100) {
      const ctxIdx = ((offset - 0x2000) / 0x100) | 0;
      const within = offset - 0x2000 - ctxIdx * 0x100;
      const ctx = this.contexts[ctxIdx]!;
      if (within < 0x80) {
        const word = within >> 2;
        for (let bit = 0; bit < 32; bit++) {
          const irq = (word << 5) | bit;
          if (irq > this.maxIrqs) continue;
          if ((v >>> bit) & 1) ctx.enables.add(irq);
          else ctx.enables.delete(irq);
        }
        return;
      }
      if (within === 0x80) ctx.threshold = v & 7;
      return;
    }
    if (offset >= 0x200000) {
      // Complete: the irq becomes claimable again.
      this.claimed.delete(v);
      return;
    }
  }
}
