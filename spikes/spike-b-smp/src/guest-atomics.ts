/**
 * Guest atomic-memory model for the SMP spike.
 *
 * Maps RV64A semantics onto JS SharedArrayBuffer + Atomics:
 *   - AMO ops (amoadd.d, amoor.d, ...)  -> Atomics.add / or / ... on BigInt64Array
 *   - LR.D / SC.D                       -> per-granule reservation tracking with a
 *                                          per-granule epoch counter (a companion
 *                                          SharedArrayBuffer of u64s, one per 8-byte
 *                                          granule). Every write claims the granule
 *                                          epoch (odd) and releases it (even), so an
 *                                          SC can distinguish "value round-tripped
 *                                          through identical bytes" (ABA) from an
 *                                          untouched reservation: ANY write, even a
 *                                          same-value write, invalidates the
 *                                          reservation.
 *   - aq/rl bits                        -> JS Atomics operations are sequentially
 *                                          consistent, a subset of what RV64A needs
 *                                          (no weaker ordering is observable).
 *
 * Protocol (seqlock-style): even epoch = free, odd = claimed by an in-flight
 * write. Writers spin while a claim is held (cycles are tiny); LR reads
 * (value, epoch) until both are stable and the epoch is even; SC claims the
 * epoch, revalidates the ticket, then stores — no interleaving write can slip
 * between the claim and the store.
 *
 * Companion epoch memory: granuleCount * 8 bytes. Callers sharing RAM across
 * workers MUST also share the companion buffer (see GuestMemory.wrap and the
 * job payloads in vcpu-worker.ts). When omitted, a private companion is
 * allocated (single-agent use only).
 *
 * All addresses are BYTE addresses into the guest RAM, 8-byte aligned for .D forms.
 */
export const WORD_BYTES = 8;
export const LR_SC_SUCCESS = 0;
export const LR_SC_FAILURE = 1;

export class GuestMemory {
  readonly buffer: SharedArrayBuffer;
  readonly bytes: Uint8Array;
  readonly epochsBuffer: SharedArrayBuffer;
  private readonly cells: BigInt64Array;
  private readonly epochs: BigUint64Array;

  constructor(sizeBytes: number) {
    this.buffer = new SharedArrayBuffer(sizeBytes);
    this.bytes = new Uint8Array(this.buffer);
    this.cells = new BigInt64Array(this.buffer);
    const granules = Math.ceil(sizeBytes / WORD_BYTES);
    this.epochsBuffer = new SharedArrayBuffer(granules * 8);
    this.epochs = new BigUint64Array(this.epochsBuffer);
  }

  /** Wrap an existing SharedArrayBuffer (and its companion epochs buffer). */
  static wrap(buffer: SharedArrayBuffer, epochsBuffer?: SharedArrayBuffer): GuestMemory {
    const m = Object.create(GuestMemory.prototype) as GuestMemory;
    (m as { buffer: SharedArrayBuffer }).buffer = buffer;
    (m as { bytes: Uint8Array }).bytes = new Uint8Array(buffer);
    (m as unknown as { cells: BigInt64Array }).cells = new BigInt64Array(buffer);
    let epochsBuf = epochsBuffer;
    if (!epochsBuf) {
      const granules = Math.ceil(buffer.byteLength / WORD_BYTES);
      epochsBuf = new SharedArrayBuffer(granules * 8);
    }
    (m as { epochsBuffer: SharedArrayBuffer }).epochsBuffer = epochsBuf;
    (m as unknown as { epochs: BigUint64Array }).epochs = new BigUint64Array(epochsBuf);
    return m;
  }

  private cellIndex(addr: number): number {
    if (addr % WORD_BYTES !== 0) throw new RangeError(`misaligned guest atomic access: ${addr}`);
    return addr / WORD_BYTES;
  }

  /** Run `fn` inside an exclusive claim on the granule's epoch (seqlock write side). */
  private withCellClaim<T>(cell: number, fn: () => T): T {
    for (;;) {
      const e = Atomics.load(this.epochs, cell);
      if (e & 1n) continue; // in-flight write; spin
      if (Atomics.compareExchange(this.epochs, cell, e, e + 1n) === e) break;
    }
    try {
      return fn();
    } finally {
      Atomics.add(this.epochs, cell, 1n); // release: even again, +2 total per write
    }
  }

  /** Seqlock read: returns a consistent (value, epoch) pair. */
  readWithEpoch(addr: number): { value: bigint; epoch: bigint } {
    const cell = this.cellIndex(addr);
    for (;;) {
      const e1 = Atomics.load(this.epochs, cell);
      if (e1 & 1n) continue;
      const value = Atomics.load(this.cells, cell);
      const e2 = Atomics.load(this.epochs, cell);
      if (e1 === e2 && (e2 & 1n) === 0n) return { value, epoch: e2 };
    }
  }

  loadReserved(addr: number): bigint {
    return this.readWithEpoch(addr).value;
  }
  store(addr: number, value: bigint): void {
    const cell = this.cellIndex(addr);
    this.withCellClaim(cell, () => {
      Atomics.store(this.cells, cell, BigInt.asIntN(64, value));
    });
  }
  amoAdd(addr: number, value: bigint): bigint {
    const cell = this.cellIndex(addr);
    return this.withCellClaim(cell, () =>
      Atomics.add(this.cells, cell, BigInt.asIntN(64, value)));
  }
  amoOr(addr: number, value: bigint): bigint {
    const cell = this.cellIndex(addr);
    return this.withCellClaim(cell, () =>
      Atomics.or(this.cells, cell, BigInt.asIntN(64, value)));
  }
  amoXor(addr: number, value: bigint): bigint {
    const cell = this.cellIndex(addr);
    return this.withCellClaim(cell, () =>
      Atomics.xor(this.cells, cell, BigInt.asIntN(64, value)));
  }
  /**
   * Strong SC-step: claim the granule, revalidate the epoch ticket, then CAS.
   * Returns { stored, epochIntact } — callers decide success.
   */
  compareAndStoreWithTicket(addr: number, expected: bigint, value: bigint, ticket: bigint): { stored: boolean; epochIntact: boolean } {
    const cell = this.cellIndex(addr);
    for (;;) {
      const e = Atomics.load(this.epochs, cell);
      if (e & 1n) continue; // in-flight write; spin
      if (e !== ticket) return { stored: false, epochIntact: false }; // invalidated since LR
      if (Atomics.compareExchange(this.epochs, cell, e, e + 1n) !== e) continue; // lost race; re-read
      try {
        // While we hold the claim no other write can touch this granule, so a
        // successful value-CAS cannot observe a same-value round-trip.
        const prev = Atomics.compareExchange(this.cells, cell, BigInt.asIntN(64, expected), BigInt.asIntN(64, value));
        return { stored: prev === BigInt.asIntN(64, expected), epochIntact: true };
      } finally {
        Atomics.add(this.epochs, cell, 1n); // release
      }
    }
  }
  /** Strong CAS used to implement SC. Returns true if stored. */
  compareAndStore(addr: number, expected: bigint, value: bigint): boolean {
    const i = this.cellIndex(addr);
    const prev = Atomics.compareExchange(this.cells, i, BigInt.asIntN(64, expected), BigInt.asIntN(64, value));
    return prev === BigInt.asIntN(64, expected);
  }
}

/**
 * Per-vCPU reservation tracker (the "reservation set" of a real LR/SC implementation,
 * kept deliberately simple: at most one reservation per hart, matching classic LL/SC).
 */
export class Reservation {
  private addr: number | null = null;
  private value: bigint = 0n;
  private ticket: bigint = 0n;

  loadAndReserve(mem: GuestMemory, addr: number): bigint {
    const { value, epoch } = mem.readWithEpoch(addr);
    this.addr = addr;
    this.value = value;
    this.ticket = epoch;
    return value;
  }

  /**
   * SC: succeed iff a reservation exists for `addr`, no write (even a
   * same-value write) has touched the granule since LR, and the cell still
   * holds the LR value.
   */
  storeConditional(mem: GuestMemory, addr: number, value: bigint): number {
    if (this.addr !== addr) return LR_SC_FAILURE; // no reservation
    const { stored, epochIntact } = mem.compareAndStoreWithTicket(addr, this.value, value, this.ticket);
    this.addr = null; // reservation cleared by SC regardless of outcome
    return epochIntact && stored ? LR_SC_SUCCESS : LR_SC_FAILURE;
  }

  clear(): void { this.addr = null; }
}

/** Classic guest spinlock built on LR/SC: lock word 0 = unlocked, 1 = locked. */
export function guestSpinLock(mem: GuestMemory, res: Reservation, lockAddr: number): void {
  for (;;) {
    const v = res.loadAndReserve(mem, lockAddr);
    if (v === 0n && res.storeConditional(mem, lockAddr, 1n) === LR_SC_SUCCESS) return;
    // Guest would WFI here in an idle path; in the spike we spin with a pause
    // hint equivalent (Atomics.pause not exposed in JS; yield to the scheduler).
  }
}

export function guestSpinUnlock(mem: GuestMemory, lockAddr: number): void {
  mem.store(lockAddr, 0n);
}
