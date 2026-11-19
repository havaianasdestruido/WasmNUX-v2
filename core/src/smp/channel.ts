/** Shared reservation table and write lock for interpreter harts using the same RAM. */
export const CHANNEL_HEADER_INTS = 8;

export class SmpChannel {
  readonly i32: Int32Array;
  constructor(
    buffer: SharedArrayBuffer,
    readonly harts: number,
  ) {
    if (!Number.isInteger(harts) || harts < 1 || buffer.byteLength < (CHANNEL_HEADER_INTS + harts * 3) * 4)
      throw new Error('invalid SMP channel size or hart count');
    this.i32 = new Int32Array(buffer, 0, CHANNEL_HEADER_INTS + harts * 3);
  }
  static createShared(harts: number): SharedArrayBuffer {
    if (!Number.isInteger(harts) || harts < 1) throw new Error('invalid hart count');
    return new SharedArrayBuffer((CHANNEL_HEADER_INTS + harts * 3) * 4);
  }
  private reservation(hart: number): number {
    if (!Number.isInteger(hart) || hart < 0 || hart >= this.harts) throw new RangeError('invalid hart');
    return CHANNEL_HEADER_INTS + hart * 2;
  }
  private gate(hart: number): number {
    this.reservation(hart);
    return CHANNEL_HEADER_INTS + this.harts * 2 + hart;
  }
  beginWrite(): void {
    while (Atomics.compareExchange(this.i32, 0, 0, 1) !== 0) Atomics.wait(this.i32, 0, 1, 1);
  }
  private unlock(): void {
    Atomics.store(this.i32, 0, 0);
    Atomics.notify(this.i32, 0, 1);
  }
  private invalidate(addr: number, size: number): void {
    const start = addr >>> 0;
    for (let h = 0; h < this.harts; h++) {
      const i = this.reservation(h);
      const reserved = Atomics.load(this.i32, i) >>> 0;
      if (Atomics.load(this.i32, i + 1) && start < reserved + 4 && reserved < start + size)
        Atomics.store(this.i32, i + 1, 0);
    }
  }
  /** Release a held lock, invalidating reservations overlapping the written bytes. */
  endWrite(addr: number, size = 4): void {
    try {
      this.invalidate(addr, size);
    } finally {
      this.unlock();
    }
  }
  /** Load and reserve under the same lock used by all guest writes. */
  lr(hart: number, addr: number, data: Int32Array, index: number): number {
    const slot = this.reservation(hart);
    this.beginWrite();
    try {
      const value = Atomics.load(data, index);
      Atomics.store(this.i32, slot, addr | 0);
      Atomics.store(this.i32, slot + 1, 1);
      return value;
    } finally {
      this.unlock();
    }
  }
  /** Reset or hart teardown consumes any outstanding reservation. */
  clearReservation(hart: number): void {
    const slot = this.reservation(hart);
    this.beginWrite();
    try {
      Atomics.store(this.i32, slot + 1, 0);
    } finally {
      this.unlock();
    }
  }
  /** SC consumes its reservation even on failure. Address is physical. */
  sc(hart: number, addr: number, value: number, data: Int32Array, index: number): boolean {
    const slot = this.reservation(hart);
    this.beginWrite();
    try {
      const ok = Atomics.load(this.i32, slot + 1) !== 0 && Atomics.load(this.i32, slot) === (addr | 0);
      Atomics.store(this.i32, slot + 1, 0);
      if (ok) {
        Atomics.store(data, index, value);
        this.invalidate(addr, 4);
      }
      return ok;
    } finally {
      this.unlock();
    }
  }
  wait(hart: number, expected: number, timeoutMs: number): 'ok' | 'timed-out' | 'not-equal' {
    return Atomics.wait(this.i32, this.gate(hart), expected, timeoutMs);
  }
  notify(hart: number, count = 1): number {
    return Atomics.notify(this.i32, this.gate(hart), count);
  }
  gateValue(hart: number): number {
    return Atomics.load(this.i32, this.gate(hart));
  }
  setGate(hart: number, value: number): void {
    Atomics.store(this.i32, this.gate(hart), value);
  }
}
