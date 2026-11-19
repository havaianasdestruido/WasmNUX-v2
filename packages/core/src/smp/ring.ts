/**
 * Spike B substrate — lock-free single-producer/single-consumer ring over
 * SharedArrayBuffer (ROADMAP: "zero-copy where possible; no postMessage on
 * hot paths").
 *
 * Layout (Int32Array view):
 *   [0] head (producer only writes; monotonically increasing, wraps at 2^31)
 *   [1] tail (consumer only writes)
 *   [2] capacity (bytes, power of two)
 *   [3] flags: bit0 = closed
 *   [4..7] reserved
 *   data region: bytes immediately after RING_META_INTS
 *
 * Atomics on head/tail provide the release/acquire ordering that brackets
 * each data transfer; the data bytes themselves are plain reads/writes.
 */

export const RING_META_INTS = 8;

export class SpscRing {
  readonly ctrl: Int32Array;
  readonly data: Uint8Array;
  readonly capacity: number;
  readonly mask: number;

  constructor(buffer: SharedArrayBuffer, capacityBytes: number) {
    if ((capacityBytes & (capacityBytes - 1)) !== 0) {
      throw new Error("ring capacity must be a power of two");
    }
    const needed = RING_META_INTS * 4 + capacityBytes;
    if (buffer.byteLength < needed) throw new Error("buffer too small for ring");
    this.ctrl = new Int32Array(buffer, 0, RING_META_INTS);
    this.capacity = capacityBytes;
    this.mask = capacityBytes - 1;
    this.data = new Uint8Array(buffer, RING_META_INTS * 4, capacityBytes);
    if (Atomics.load(this.ctrl, 2) === 0) {
      Atomics.store(this.ctrl, 2, capacityBytes);
    } else if (Atomics.load(this.ctrl, 2) !== capacityBytes) {
      throw new Error("ring capacity mismatch with existing buffer");
    }
  }

  static createShared(capacityBytes: number): SharedArrayBuffer {
    return new SharedArrayBuffer(RING_META_INTS * 4 + capacityBytes);
  }

  /** Bytes not yet consumed (head/tail are monotonic; wraps are handled). */
  get used(): number {
    const h = Atomics.load(this.ctrl, 0);
    const t = Atomics.load(this.ctrl, 1);
    return (h - t) >>> 0;
  }

  get free(): number { return this.capacity - this.used; }

  close(): void {
    Atomics.or(this.ctrl, 3, 1);
    // Wake a consumer parked in waitForData() — it sleeps on head, so notify
    // that word or shutdown hangs until its timeout.
    Atomics.notify(this.ctrl, 0, 1);
    Atomics.notify(this.ctrl, 1, 1);
  }
  get closed(): boolean { return (Atomics.load(this.ctrl, 3) & 1) !== 0; }

  /**
   * Producer: copy `bytes` in; returns bytes written (0 if full).
   * Never blocks — device queues stay non-blocking on hot paths.
   */
  write(bytes: Uint8Array): number {
    const head = Atomics.load(this.ctrl, 0);
    const tail = Atomics.load(this.ctrl, 1);
    const used = (head - tail) >>> 0;
    if (used >= this.capacity) return 0;
    const n = Math.min(this.capacity - used, bytes.length);
    if (n <= 0) return 0;
    const offset = head & this.mask;
    const first = Math.min(n, this.capacity - offset);
    this.data.set(bytes.subarray(0, first), offset);
    if (first < n) this.data.set(bytes.subarray(first, n), 0);
    Atomics.store(this.ctrl, 0, head + n);
    return n;
  }

  /** Consumer: copy up to `out.length` bytes out; returns bytes read. */
  read(out: Uint8Array): number {
    const head = Atomics.load(this.ctrl, 0);
    const tail = Atomics.load(this.ctrl, 1);
    const used = (head - tail) >>> 0;
    if (used === 0) return 0;
    const n = Math.min(used, out.length);
    const offset = tail & this.mask;
    const first = Math.min(n, this.capacity - offset);
    out.set(this.data.subarray(offset, offset + first), 0);
    if (first < n) out.set(this.data.subarray(0, n - first), first);
    Atomics.store(this.ctrl, 1, tail + n);
    return n;
  }

  /**
   * Consumer: block until data is available or `timeoutMs` elapses.
   * `Atomics.wait` — the "no spin, wait for idle" rule from the roadmap.
   */
  waitForData(timeoutMs: number): boolean {
    for (;;) {
      if (this.used > 0) return true;
      if (this.closed) return false;
      const head = Atomics.load(this.ctrl, 0);
      if (this.used > 0) return true;
      const r = Atomics.wait(this.ctrl, 0, head, timeoutMs);
      if (r === "not-equal") continue; // head changed — re-check
      if (r === "timed-out") return this.used > 0;
      if (this.closed && this.used === 0) return false;
    }
  }

  /** Producer: wake a consumer blocked in waitForData. */
  notify(): void {
    Atomics.notify(this.ctrl, 0, 1);
  }
}
