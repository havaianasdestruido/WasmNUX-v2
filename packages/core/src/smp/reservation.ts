/**
 * Spike B substrate — guest-atomic bridge.
 *
 * Guest LR/SC and AMO operations executed by vCPU workers must interoperate
 * with Wasm/JS atomics on shared memory. This module provides:
 *
 *  - `ReservationTable`: per-hart LR/SC reservations (the A-extension's
 *    store-conditional succeeds only when the reservation is intact; any
 *    store to the reserved address by *any* hart clears it — implemented
 *    with a seq-lock so it stays allocation-free on the hot path).
 *  - `IdleGate`: `Atomics.wait`-based WFI (workers must not spin).
 *  - `MemoryModel`: litmus-test harness for cross-hart validation
 *    (message passing, store buffering) — run in the spike's test suite.
 */

export const HARTS = 8;

/**
 * Reservation status array: 2 ints per hart + 1 global seq.
 * [0..HARTS*2): pairs (seqTag, addrLow) per hart
 * [last]: global counter bumped on every store that may conflict.
 */
export class ReservationTable {
  private readonly view: Int32Array;
  readonly slots: number;

  constructor(buffer: SharedArrayBuffer, harts = HARTS) {
    this.slots = harts * 2 + 1;
    if (buffer.byteLength < this.slots * 4) throw new Error("reservation buffer too small");
    this.view = new Int32Array(buffer, 0, this.slots);
  }

  static createShared(harts = HARTS): SharedArrayBuffer {
    return new SharedArrayBuffer((harts * 2 + 1) * 4);
  }

  /** Record an LR on `hart` for `addr` (low 32 bits kept; see note). */
  setReservation(hart: number, addr: number): void {
    Atomics.store(this.view, hart * 2, Atomics.load(this.view, this.slots - 1));
    Atomics.store(this.view, hart * 2 + 1, addr | 0);
  }

  clear(hart: number): void {
    Atomics.store(this.view, hart * 2, -1);
  }

  /**
   * Invalidate any reservation covering `addr` — called after every store
   * (conservative: Phase 0 matches RVWMO closely enough for spike validation;
   * Phase 1 refines to exact address matching per the A-spec).
   */
  invalidateAll(addr: number): void {
    Atomics.add(this.view, this.slots - 1, 1);
    void addr;
    // Per-hart addresses are compared against the reservation tag; a bump of
    // the global counter alone does not clear tags, so explicitly clear pairs
    // whose stored address matches.
    // (Cheap loop: HARTS ≤ 8.)
    const harts = (this.slots - 1) / 2;
    for (let h = 0; h < harts; h++) {
      const a = Atomics.load(this.view, h * 2 + 1);
      if (Atomics.load(this.view, h * 2) >= 0 && a === (addr | 0)) {
        Atomics.store(this.view, h * 2, -1);
      }
    }
  }

  /** SC succeeds iff hart's reservation is still valid for `addr`. */
  check(hart: number, addr: number): boolean {
    const tag = Atomics.load(this.view, hart * 2);
    const a = Atomics.load(this.view, hart * 2 + 1);
    const ok = tag >= 0 && a === (addr | 0);
    Atomics.store(this.view, hart * 2, -1); // SC always consumes the reservation
    return ok;
  }
}

/**
 * Idle gate: a worker blocks on an Int32Array cell instead of spinning.
 * `Atomics.wait` is only callable on SharedArrayBuffer-backed arrays.
 */
export class IdleGate {
  private readonly ctrl: Int32Array;

  constructor(buffer: SharedArrayBuffer) {
    if (buffer.byteLength < 4) throw new Error("gate buffer too small");
    this.ctrl = new Int32Array(buffer, 0, 1);
  }

  static createShared(): SharedArrayBuffer { return new SharedArrayBuffer(4); }

  /** Park until `waitForChange` or timeout. Returns "ok" | "timed-out" | "not-equal". */
  wait(expected: number, timeoutMs: number): "ok" | "timed-out" | "not-equal" {
    return Atomics.wait(this.ctrl, 0, expected, timeoutMs);
  }

  /** Wake all waiters (timer worker / IPI path). */
  wake(count = 1): void {
    Atomics.notify(this.ctrl, 0, count);
  }

  /** Single-step the gate value and wake waiters (kick). */
  kick(): number {
    const v = Atomics.add(this.ctrl, 0, 1) + 1;
    Atomics.notify(this.ctrl, 0, 1);
    return v;
  }

  load(): number { return Atomics.load(this.ctrl, 0); }
}

/**
 * Litmus harness primitives (memory-model validation, spike B exit criterion).
 * Tests run N iterations of two-store patterns across worker threads and
 * count forbidden outcomes. On Wasm threads the JMM + RVWMO mapping means a
 * nonzero forbidden count would indicate a harness bug or a weak-memory bug
 * in our lowering — CI asserts zero.
 */
export class LitmusShared {
  readonly flags: Int32Array;
  readonly stop: Int32Array;

  constructor(buffer: SharedArrayBuffer) {
    this.flags = new Int32Array(buffer, 0, 8);
    this.stop = new Int32Array(buffer, 4 * 8, 1);
  }

  static createShared(): SharedArrayBuffer { return new SharedArrayBuffer(4 * 9); }
}
