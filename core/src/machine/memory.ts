/**
 * Guest physical memory backed by a single `WebAssembly.Memory`.
 *
 * ADR-0004 asks how guest RAM should be modelled. The spike answers the parts
 * that can be answered with measurements:
 *
 *  - one linear Wasm memory holds all guest RAM, so generated code can use
 *    native `i32.load`/`i32.store` with no address translation;
 *  - the memory is optionally *shared*, which is what lets N vCPU workers see
 *    the same RAM (Spike B) and what makes guest atomics map onto Wasm atomics;
 *  - Wasm has no `mprotect` and no guard pages, so out-of-range guest accesses
 *    are caught either by an explicit inline check (`boundsCheck: true`) or by
 *    the Wasm out-of-bounds trap (`boundsCheck: false`). Both modes are
 *    implemented and benchmarked - see `docs/spikes/spike-a-jit.md`.
 *
 * The memory is sized to exactly the RAM size when trapping is used, so any
 * address outside guest RAM faults instead of silently hitting emulator state.
 */

export interface GuestMemoryOptions {
  /** Size of guest RAM in bytes. Rounded up to a multiple of 64 KiB. */
  ramBytes: number;
  /** Guest physical address RAM starts at. `0x8000_0000` matches QEMU `virt`. */
  ramBase?: number;
  /** Use a SharedArrayBuffer-backed memory (required for SMP). */
  shared?: boolean;
  /** Append a guard/control page after RAM instead of trapping on OOB. */
  controlPage?: boolean;
  /** An existing memory to attach to (used by vCPU workers). */
  memory?: WebAssembly.Memory;
}

export const WASM_PAGE = 65536;
export const DEFAULT_RAM_BASE = 0x80000000;
/** QEMU-`virt`-compatible MMIO addresses used by the spike machine. */
export const MMIO = {
  clintBase: 0x02000000,
  clintMtime: 0x0200bff8,
  testFinisher: 0x00100000,
  uart: 0x10000000,
  virtio: 0x10001000,
} as const;

export class GuestMemory {
  readonly memory: WebAssembly.Memory;
  readonly ramBase: number;
  readonly ramSize: number;
  readonly shared: boolean;
  readonly hasControlPage: boolean;
  /** Offset of the control page inside the Wasm memory (or -1 when absent). */
  readonly controlOffset: number;

  u8: Uint8Array;
  u16: Uint16Array;
  u32: Uint32Array;
  i32: Int32Array;
  view: DataView;

  constructor(opts: GuestMemoryOptions) {
    this.ramBase = (opts.ramBase ?? DEFAULT_RAM_BASE) >>> 0;
    this.ramSize = Math.ceil(opts.ramBytes / WASM_PAGE) * WASM_PAGE;
    this.shared = opts.shared ?? false;
    this.hasControlPage = opts.controlPage ?? false;
    this.controlOffset = this.hasControlPage ? this.ramSize : -1;
    const pages = this.ramSize / WASM_PAGE + (this.hasControlPage ? 1 : 0);

    if (opts.memory) {
      this.memory = opts.memory;
      if (this.memory.buffer.byteLength < pages * WASM_PAGE) {
        throw new Error('attached memory is smaller than the requested RAM');
      }
    } else {
      this.memory = new WebAssembly.Memory({
        initial: pages,
        maximum: pages,
        shared: this.shared,
      });
    }
    const buf = this.memory.buffer;
    this.u8 = new Uint8Array(buf);
    this.u16 = new Uint16Array(buf);
    this.u32 = new Uint32Array(buf);
    this.i32 = new Int32Array(buf);
    this.view = new DataView(buf);
  }

  /** SharedArrayBuffer when shared, else ArrayBuffer. */
  get buffer(): ArrayBufferLike {
    return this.memory.buffer;
  }

  /** Re-create typed views after the memory grew. */
  refreshViews(): void {
    const buf = this.memory.buffer;
    this.u8 = new Uint8Array(buf);
    this.u16 = new Uint16Array(buf);
    this.u32 = new Uint32Array(buf);
    this.i32 = new Int32Array(buf);
    this.view = new DataView(buf);
  }

  /**
   * Guest physical address -> offset into the Wasm memory, or -1 when the
   * address is not RAM (MMIO, unmapped). Cheap enough to call per instruction
   * in the interpreter; generated code inlines the equivalent.
   */
  ramOffset(addr: number): number {
    const off = (addr - this.ramBase) >>> 0;
    return off < this.ramSize ? off : -1;
  }

  inRam(addr: number): boolean {
    return this.ramOffset(addr) >= 0;
  }

  loadProgram(bytes: Uint8Array, addr: number): void {
    const off = this.ramOffset(addr);
    if (off < 0) throw new Error(`load address 0x${addr.toString(16)} is not RAM`);
    if (off + bytes.length > this.ramSize) throw new Error('program does not fit in RAM');
    this.u8.set(bytes, off);
  }

  readBytes(addr: number, len: number): Uint8Array {
    const off = this.ramOffset(addr);
    if (off < 0) throw new Error(`read of non-RAM address 0x${addr.toString(16)}`);
    return this.u8.slice(off, off + len);
  }

  writeBytes(addr: number, data: Uint8Array): void {
    const off = this.ramOffset(addr);
    if (off < 0) throw new Error(`write to non-RAM address 0x${addr.toString(16)}`);
    this.u8.set(data, off);
  }

  readU8(addr: number): number {
    const off = this.ramOffset(addr);
    return off < 0 ? 0 : this.u8[off]!;
  }

  readU16(addr: number): number {
    const off = this.ramOffset(addr);
    return off < 0 ? 0 : this.view.getUint16(off, true);
  }

  readU32(addr: number): number {
    const off = this.ramOffset(addr);
    return off < 0 ? 0 : this.view.getUint32(off, true);
  }

  writeU8(addr: number, v: number): void {
    const off = this.ramOffset(addr);
    if (off >= 0) this.u8[off] = v & 0xff;
  }

  writeU16(addr: number, v: number): void {
    const off = this.ramOffset(addr);
    if (off >= 0) this.view.setUint16(off, v & 0xffff, true);
  }

  writeU32(addr: number, v: number): void {
    const off = this.ramOffset(addr);
    if (off >= 0) this.view.setUint32(off, v >>> 0, true);
  }

  /** Fetch an instruction word. Returns 0 for non-RAM addresses (caller traps). */
  fetch(addr: number): number {
    const off = this.ramOffset(addr);
    return off < 0 ? 0 : this.view.getUint32(off, true);
  }

  /** Control page accessors (used when `controlPage` is enabled). */
  ctrlRead(index: number): number {
    if (!this.hasControlPage) throw new Error('no control page');
    return this.i32[(this.controlOffset >> 2) + index]!;
  }

  ctrlWrite(index: number, value: number): void {
    if (!this.hasControlPage) throw new Error('no control page');
    this.i32[(this.controlOffset >> 2) + index] = value | 0;
  }
}
