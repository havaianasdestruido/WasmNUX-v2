/**
 * The vCPU register file as seen from generated code.
 *
 * ADR-0004's open question is where guest state lives so that compiled code can
 * reach it cheaply. Two placements are implemented and benchmarked:
 *
 *  - `globals`: 32 imported mutable Wasm globals. Zero prologue/epilogue per
 *    region invocation, shared by every module of a vCPU, readable from JS for
 *    slow paths and snapshots.
 *  - `memory`: the register file sits in a control page at the end of guest RAM.
 *    Costs a load per read and a store per write, but needs no imports and works
 *    on engines where many mutable globals are slow.
 *
 * Both are exposed through the same `RegFile` object so the rest of the code
 * does not care which one a run used.
 */

/** Global indices (also used as control-page i32 slots). */
export const G = {
  REG_BASE: 0,
  PC: 32,
  /** Faulting / MMIO address for the host slow path. */
  INFO: 33,
  LR_ADDR: 34,
  LR_VALUE: 35,
  LR_VALID: 36,
  COUNT: 37,
} as const;

export const GLOBAL_NAMES: string[] = [
  ...Array.from({ length: 32 }, (_, i) => `r${i}`),
  'pc',
  'info',
  'lrAddr',
  'lrValue',
  'lrValid',
];

export type RegAlloc = 'globals' | 'memory';

export class RegFile {
  readonly globals: WebAssembly.Global[] = [];
  readonly alloc: RegAlloc;
  /** Control-page byte offset, only used when `alloc === 'memory'`. */
  readonly controlOffset: number;
  private i32view: Int32Array | null = null;

  constructor(alloc: RegAlloc = 'globals', controlOffset = 0) {
    this.alloc = alloc;
    this.controlOffset = controlOffset;
    for (let i = 0; i < G.COUNT; i++) {
      this.globals.push(new WebAssembly.Global({ value: 'i32', mutable: true }, 0));
    }
  }

  /** Bind a memory-backed register file (used when `alloc === 'memory'`). */
  attachMemory(buffer: ArrayBufferLike): void {
    this.i32view = new Int32Array(buffer);
  }

  private slot(i: number): number {
    return (this.controlOffset >> 2) + i;
  }

  private useMemory(): boolean {
    return this.alloc === 'memory' && this.i32view !== null;
  }

  getReg(i: number): number {
    if (i === 0) return 0;
    return this.useMemory() ? this.i32view![this.slot(i)]! : (this.globals[i]!.value as number);
  }

  setReg(i: number, v: number): void {
    if (i === 0) return;
    if (this.useMemory()) this.i32view![this.slot(i)] = v | 0;
    else this.globals[i]!.value = v | 0;
  }

  get pc(): number {
    return (this.useMemory() ? this.i32view![this.slot(G.PC)]! : (this.globals[G.PC]!.value as number)) >>> 0;
  }

  set pc(v: number) {
    if (this.useMemory()) this.i32view![this.slot(G.PC)] = v | 0;
    else this.globals[G.PC]!.value = v | 0;
  }

  get info(): number {
    return (
      (this.useMemory() ? this.i32view![this.slot(G.INFO)]! : (this.globals[G.INFO]!.value as number)) >>> 0
    );
  }

  set info(v: number) {
    if (this.useMemory()) this.i32view![this.slot(G.INFO)] = v | 0;
    else this.globals[G.INFO]!.value = v | 0;
  }

  /** Raw state-slot read (registers, pc, info and the LR/SC reservation). */
  getSlot(i: number): number {
    return this.useMemory() ? this.i32view![this.slot(i)]! : (this.globals[i]!.value as number);
  }

  get lrAddr(): number {
    return this.getSlot(G.LR_ADDR) | 0;
  }

  get lrValue(): number {
    return this.getSlot(G.LR_VALUE) | 0;
  }

  get lrValid(): boolean {
    return this.getSlot(G.LR_VALID) !== 0;
  }

  setLr(addr: number, value: number, valid: boolean): void {
    const put = (idx: number, v: number) => {
      if (this.useMemory()) this.i32view![this.slot(idx)] = v | 0;
      else this.globals[idx]!.value = v | 0;
    };
    put(G.LR_ADDR, addr | 0);
    put(G.LR_VALUE, value | 0);
    put(G.LR_VALID, valid ? 1 : 0);
  }

  /** Copy architectural state in (before entering compiled code). */
  syncFrom(regs: Int32Array, pc: number): void {
    for (let i = 0; i < 32; i++) this.setReg(i, regs[i]!);
    this.pc = pc;
  }

  /** Copy architectural state out (after compiled code exits). Returns pc. */
  syncTo(regs: Int32Array): number {
    for (let i = 1; i < 32; i++) regs[i] = this.getReg(i);
    return this.pc;
  }

  /** Import object for a compiled region module. */
  imports(moduleName = 'wnx'): WebAssembly.Imports {
    const env: Record<string, WebAssembly.Global> = {};
    for (let i = 0; i < G.COUNT; i++) env[GLOBAL_NAMES[i]!] = this.globals[i]!;
    return { [moduleName]: env };
  }
}
