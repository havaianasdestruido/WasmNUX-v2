/**
 * Guest RAM model (ADR-0004).
 *
 * - Backed by a single `WebAssembly.Memory` so the interpreter, JIT and vCPU
 *   workers all observe the same bytes (shared memory when created with
 *   `shared: true`).
 * - No guard pages exist in Wasm, so every access is bounds-checked here or
 *   (in generated code) via an explicit range/TLB probe — see `mmu.ts`.
 * - The register file and JIT scratch live in reserved footer pages of the
 *   same memory so tier transitions never copy register state.
 */

export interface GuestMemoryOptions {
  /** Total guest RAM in bytes (rounded up to 64 KiB pages). */
  sizeBytes: number;
  /** Create as SharedArrayBuffer-backed (required for SMP). */
  shared?: boolean;
  /** Physical base address of RAM (QEMU `virt` = 0x8000_0000; spikes use 0). */
  base?: number;
  /** Number of harts sharing this memory (each gets a private footer page pair). */
  hartCount?: number;
  /** Which hart this view belongs to (selects its register-file page). */
  hart?: number;
  /**
   * Attach to an existing (shared) WebAssembly.Memory instead of creating one
   * — how vCPU workers join the same guest RAM (structured-clone a shared
   * Memory between threads and it keeps the same underlying storage).
   */
  attach?: WebAssembly.Memory;
}

export const WASM_PAGE_SIZE = 64 * 1024;

/** Footer layout inside the memory: [guest RAM pages][regfile][scratch]. */
export const REGFILE_BYTES = 32 * 8;
export const SCRATCH_BYTES = 4096;

export class GuestMemory {
  readonly memory: WebAssembly.Memory;
  readonly base: number;
  readonly ramBytes: number;
  readonly totalBytes: number;
  readonly shared: boolean;
  /** Byte offset of the 32×i64 register file inside the memory. */
  readonly regFileOffset: number;
  /** Byte offset of scratch (TLB mirror, block metadata, ...). */
  readonly scratchOffset: number;

  private _bytes: Uint8Array;
  private _regs: BigUint64Array;

  constructor(opts: GuestMemoryOptions) {
    const hartCount = Math.max(1, opts.hartCount ?? 1);
    const hartRaw = Math.max(0, opts.hart ?? 0);
    if (hartRaw >= hartCount) {
      throw new Error(`hart ${hartRaw} out of range (hartCount=${hartCount}) — pass matching hartCount when attaching`);
    }
    const hart = hartRaw;
    // Per-hart footer: [regfile page | scratch page] × hartCount
    const footerPages = hartCount * 2;
    let ramPages: number;
    if (opts.attach) {
      ramPages = opts.attach.buffer.byteLength / WASM_PAGE_SIZE - footerPages;
      if (ramPages < 1) throw new Error("attached memory smaller than footer");
      this.memory = opts.attach;
      this.shared = true;
    } else {
      ramPages = Math.ceil(opts.sizeBytes / WASM_PAGE_SIZE);
      const initial = ramPages + footerPages;
      const shared = opts.shared ?? false;
      this.memory = new WebAssembly.Memory(
        shared
          ? { initial, maximum: initial, shared: true }
          : { initial },
      );
      this.shared = shared;
    }
    const initial = this.memory.buffer.byteLength / WASM_PAGE_SIZE;
    this.base = opts.base ?? 0;
    this.ramBytes = ramPages * WASM_PAGE_SIZE;
    this.totalBytes = initial * WASM_PAGE_SIZE;
    this.regFileOffset = ramPages * WASM_PAGE_SIZE + hart * 2 * WASM_PAGE_SIZE;
    this.scratchOffset = this.regFileOffset + WASM_PAGE_SIZE;
    this._bytes = new Uint8Array(this.memory.buffer, 0, this.totalBytes);
    this._regs = new BigUint64Array(this.memory.buffer, this.regFileOffset, 32);
  }

  get bytes(): Uint8Array {
    return this._bytes;
  }

  get regs(): BigUint64Array {
    return this._regs;
  }

  /** Rebind typed views after a grow (Memory.grow detaches buffers). */
  refreshViews(): void {
    this._bytes = new Uint8Array(this.memory.buffer, 0, this.totalBytes);
    this._regs = new BigUint64Array(this.memory.buffer, this.regFileOffset, 32);
  }

  /** Translate a physical address to a host offset, or -1 if out of RAM. */
  physToOffset(pa: bigint | number): number {
    const addr = typeof pa === "number" ? BigInt(pa) : pa;
    const rel = addr - BigInt(this.base);
    if (rel < 0n || rel >= BigInt(this.ramBytes)) return -1;
    return Number(rel);
  }

  readU8(pa: number): number { return this._bytes[pa - this.base]!; }
  readU16(pa: number): number {
    const o = pa - this.base;
    return this._bytes[o]! | (this._bytes[o + 1]! << 8);
  }
  readU32(pa: number): number {
    const o = pa - this.base;
    return (
      (this._bytes[o]! |
        (this._bytes[o + 1]! << 8) |
        (this._bytes[o + 2]! << 16) |
        (this._bytes[o + 3]! << 24)) >>> 0
    );
  }
  readU64(pa: number): bigint {
    const lo = BigInt(this.readU32(pa));
    const hi = BigInt(this.readU32(pa + 4));
    return lo | (hi << 32n);
  }

  writeU8(pa: number, v: number): void { this._bytes[pa - this.base] = v & 0xff; }
  writeU16(pa: number, v: number): void {
    const o = pa - this.base;
    this._bytes[o] = v & 0xff;
    this._bytes[o + 1] = (v >>> 8) & 0xff;
  }
  writeU32(pa: number, v: number): void {
    const o = pa - this.base;
    this._bytes[o] = v & 0xff;
    this._bytes[o + 1] = (v >>> 8) & 0xff;
    this._bytes[o + 2] = (v >>> 16) & 0xff;
    this._bytes[o + 3] = (v >>> 24) & 0xff;
  }
  writeU64(pa: number, v: bigint): void {
    this.writeU32(pa, Number(v & 0xffffffffn));
    this.writeU32(pa + 4, Number((v >> 32n) & 0xffffffffn));
  }

  /** Load a program image at a physical address (little-endian bytes). */
  loadImage(pa: number, image: Uint8Array): void {
    const o = pa - this.base;
    this._bytes.set(image, o);
  }

  snapshot(): Uint8Array {
    return this._bytes.slice(0, this.ramBytes);
  }

  restore(snap: Uint8Array): void {
    if (snap.byteLength > this.ramBytes) throw new Error("snapshot larger than RAM");
    this._bytes.set(snap, 0);
  }
}
