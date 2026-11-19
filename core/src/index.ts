/**
 * `@wasmnux/core` - the emulator core.
 *
 * Layered so a host (browser or Node) can pick how much of it to instantiate:
 * the ISA and interpreter stand alone, the JIT adds the Wasm encoder and the
 * region translator, and the machine ties both to devices and a syscall ABI.
 */

// ISA: encoding, decoding, disassembly and the assembler used to build tests.
export * from './cpu/encoding.ts';
export * from './cpu/state.ts';
export * from './cpu/asm.ts';
export { Interpreter, mulh, signExtend, type MachinePort } from './cpu/interp.ts';

// Memory model.
export { GuestMemory, DEFAULT_RAM_BASE, MMIO, WASM_PAGE, type GuestMemoryOptions } from './machine/memory.ts';
export { isElf, parseElf32, ElfError, ELF_MAGIC, PT_LOAD, type ElfImage } from './machine/elf.ts';

// MMU (Sv32/Sv39) and page-table helpers.
export {
  Mmu,
  PAGE_FAULT,
  PTE_V,
  PTE_R,
  PTE_W,
  PTE_X,
  PTE_U,
  PTE_A,
  PTE_D,
  type MmuMode,
  type AccessKind,
  type TranslateResult,
} from './mmu/mmu.ts';
export {
  PTE_FLAGS,
  sv32Leaf,
  sv32Pointer,
  sv39Leaf,
  sv39Pointer,
  writePte,
} from './mmu/tables.ts';

// JIT (Spike A).
export {
  buildCfg,
  formRegion,
  successorsOf,
  DEFAULT_MAX_BLOCK_INSNS,
  type BasicBlock,
  type BlockExit,
  type CfgOptions,
  type Region,
  type RegionOptions,
} from './jit/cfg.ts';
export {
  DEFAULT_JIT_CONFIG,
  RegionCodegen,
  translateRegion,
  validateConfig,
  type Ctx,
  type JitConfig,
  type LinkTarget,
} from './jit/codegen.ts';
export {
  Engine,
  JitCodeCache,
  MAX_TRAPS_PER_PC,
  MAX_WASM_PAGES_RV32,
  configHash,
  emptyStats,
  type CacheRecord,
  type EngineOptions,
  type EngineStats,
} from './jit/engine.ts';
export { G, GLOBAL_NAMES, RegFile, type RegAlloc } from './jit/regfile.ts';
export {
  WasmModuleBuilder,
  FuncEmitter,
  compileModule,
  compileModuleSync,
  createFuncTable,
} from './jit/wasm/encoder.ts';
export * as WasmFeatures from './jit/wasm/features.ts';
export type { AtomicsMicroResult, WasmFeatureReport } from './jit/wasm/features.ts';

// Devices.
export { DeviceBus, truncate, type Device } from './devices/bus.ts';
export {
  CallbackUartSink,
  StringUartSink,
  Uart,
  UART_BASE,
  UART_SIZE,
  type UartSink,
} from './devices/uart.ts';
export {
  Clint,
  Plic,
  TestFinisher,
  CLINT_BASE,
  PLIC_BASE,
  TEST_BASE,
  TEST_FAIL,
  TEST_PASS,
  type ClintOptions,
  type TestFinisherOptions,
} from './devices/clint.ts';

// Machine.
export {
  Machine,
  SYS,
  WNX_SYS,
  headlessMachine,
  type BenchmarkReport,
  type MachineOptions,
  type MachineStats,
} from './machine/machine.ts';
