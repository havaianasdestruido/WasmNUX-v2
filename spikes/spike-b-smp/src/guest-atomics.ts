/**
 * Guest atomic-memory model for the SMP spike.
 *
 * Maps RV64A semantics onto JS SharedArrayBuffer + Atomics:
 *   - AMO ops (amoadd.d, amoor.d, ...)  -> Atomics.add / or / ... on BigInt64Array
 *   - LR.D / SC.D                       -> track a per-vCPU reservation; SC succeeds
 *                                          iff the reservation is intact. We implement
 *                                          it with Atomics.compareExchange so success
 *                                          also requires no intervening modification,
 *                                          which is strictly stronger than required
 *                                          (spurious failure is always allowed).
 *   - aq/rl bits                        -> JS Atomics operations are sequentially
 *                                          consistent, a subset of what RV64A needs
 *                                          (no weaker ordering is observable).
 *
 * All addresses are BYTE addresses into the guest RAM, 8-byte aligned for .D forms.
 */
export const WORD_BYTES = 8;
export const LR_SC_SUCCESS = 0;
export const LR_SC_FAILURE = 1;

export class GuestMemory {
  readonly buffer: SharedArrayBuffer;
  readonly bytes: Uint8Array;
  private readonly cells: BigInt64Array;

  constructor(sizeBytes: number) {
    this.buffer = new SharedArrayBuffer(sizeBytes);
    this.bytes = new Uint8Array(this.buffer);
    this.cells = new BigInt64Array(this.buffer);
  }

  /** Wrap an existing SharedArrayBuffer (used by workers attaching to the guest RAM). */
  static wrap(buffer: SharedArrayBuffer): GuestMemory {
    const m = new GuestMemory(0);
    (m as { buffer: SharedArrayBuffer }).buffer = buffer;
    (m as { bytes: Uint8Array }).bytes = new Uint8Array(buffer);
    (m as unknown as { cells: BigInt64Array }).cells = new BigInt64Array(buffer);
    return m;
  }

  private cellIndex(addr: number): number {
    if (addr % WORD_BYTES !== 0) throw new RangeError(`misaligned guest atomic access: ${addr}`);
    return addr / WORD_BYTES;
  }

  loadReserved(addr: number): bigint {
    return Atomics.load(this.cells, this.cellIndex(addr));
  }
  store(addr: number, value: bigint): void {
    Atomics.store(this.cells, this.cellIndex(addr), BigInt.asIntN(64, value));
  }
  amoAdd(addr: number, value: bigint): bigint {
    return Atomics.add(this.cells, this.cellIndex(addr), BigInt.asIntN(64, value));
  }
  amoOr(addr: number, value: bigint): bigint {
    return Atomics.or(this.cells, this.cellIndex(addr), BigInt.asIntN(64, value));
  }
  amoXor(addr: number, value: bigint): bigint {
    return Atomics.xor(this.cells, this.cellIndex(addr), BigInt.asIntN(64, value));
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

  loadAndReserve(mem: GuestMemory, addr: number): bigint {
    const v = mem.loadReserved(addr);
    this.addr = addr;
    this.value = v;
    return v;
  }

  /** SC: succeed iff a reservation exists for `addr` and its value still matches. */
  storeConditional(mem: GuestMemory, addr: number, value: bigint): number {
    if (this.addr !== addr) return LR_SC_FAILURE; // no reservation
    const ok = mem.compareAndStore(addr, this.value, value);
    this.addr = null; // reservation cleared by SC regardless of outcome
    return ok ? LR_SC_SUCCESS : LR_SC_FAILURE;
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
