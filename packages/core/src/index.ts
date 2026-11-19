/**
 * @wasmnux/core — Phase 0 substrate shared by the spikes.
 *
 * Sub-areas map to the eventual Phase 1 layout (ROADMAP §7):
 *   core/cpu, core/mmu, core/jit, core/devices, core/snapshot
 */

export * from "./isa/decoder.js";
export * from "./isa/assembler.js";
export * from "./memory.js";
export * from "./mmu.js";
export * from "./cpu.js";
export * from "./jit/wasm-emit.js";
export * from "./jit/block.js";
export * from "./jit/engine.js";
export * from "./smp/ring.js";
export * from "./smp/reservation.js";
