/**
 * Spike A — JIT engine: block cache (region-per-module, ADR-0003) driving the
 * hot loop, with the interpreter as universal slow path.
 *
 * Host protocol: a block returns `next_pc ≥ 0` (jump/fallthrough) or a negative
 * sentinel `-(pc + 1)` meaning "interpret exactly one instruction at pc on the
 * interpreter, then continue" (traps, MMU, ecall, CSRs, atomics, div/rem,
 * mulh...). Cache is flushed when translation mode changes (satp/privilege),
 * so generated code never has to re-walk page tables in Phase 0.
 */

import { Cpu, CSR_MCAUSE, type CpuExit } from "../cpu.js";
import { GuestMemory } from "../memory.js";
import { compileBlock, type CompiledBlock } from "./block.js";

export interface EngineStats {
  compiles: number;
  cacheHits: number;
  cacheMisses: number;
  evictions: number;
  compilesNs: number;
  instantiateNs: number;
  bytesEmitted: number;
  fastSteps: number;
  slowSteps: number;
  flushes: number;
}

export interface JitEngineOptions {
  /** Max cached blocks before LRU eviction (ADR-0003 amortization window). */
  cacheSize?: number;
}

export class JitEngine {
  private readonly cache = new Map<number, CompiledBlock>();
  private readonly cacheSize: number;
  private lastSatp = 0n;
  private lastPrivilege = 3;

  readonly stats: EngineStats = {
    compiles: 0, cacheHits: 0, cacheMisses: 0, evictions: 0,
    compilesNs: 0, instantiateNs: 0, bytesEmitted: 0,
    fastSteps: 0, slowSteps: 0, flushes: 0,
  };

  constructor(readonly mem: GuestMemory, opts: JitEngineOptions = {}) {
    this.cacheSize = opts.cacheSize ?? 1024;
  }

  get size(): number { return this.cache.size; }

  reset(): void {
    this.cache.clear();
    this.stats.compiles = 0;
    this.stats.cacheHits = 0;
    this.stats.cacheMisses = 0;
    this.stats.evictions = 0;
    this.stats.compilesNs = 0;
    this.stats.instantiateNs = 0;
    this.stats.bytesEmitted = 0;
    this.stats.fastSteps = 0;
    this.stats.slowSteps = 0;
    this.stats.flushes = 0;
  }

  invalidate(): void {
    if (this.cache.size > 0) this.stats.flushes++;
    this.cache.clear();
  }

  private getBlock(offset: number): CompiledBlock | null {
    const hit = this.cache.get(offset);
    if (hit) {
      // LRU touch: move to the most-recent end
      this.cache.delete(offset);
      this.cache.set(offset, hit);
      this.stats.cacheHits++;
      return hit;
    }
    this.stats.cacheMisses++;
    let blk: CompiledBlock;
    try {
      blk = compileBlock({ memory: this.mem, offset });
    } catch {
      return null; // fall back to interpreter for this region
    }
    this.stats.compiles++;
    this.stats.compilesNs += blk.compileNs;
    this.stats.instantiateNs += blk.instantiateNs;
    this.stats.bytesEmitted += blk.bytes.byteLength;
    this.cache.set(offset, blk);
    while (this.cache.size > this.cacheSize) {
      const oldest = this.cache.keys().next();
      if (oldest.done) break;
      this.cache.delete(oldest.value);
      this.stats.evictions++;
    }
    return blk;
  }

  /**
   * Run the CPU for up to `maxSteps` guest instructions using JIT where
   * possible. Returns when the CPU halts (exit) or the budget is exhausted.
   */
  run(cpu: Cpu, maxSteps: number): CpuExit {
    let steps = 0;
    // Translation is only valid in bare mode / M-mode for Phase 0 blocks.
    if (cpu.mmu.satp !== this.lastSatp || cpu.mmu.privilege !== this.lastPrivilege) {
      this.invalidate();
      this.lastSatp = cpu.mmu.satp;
      this.lastPrivilege = cpu.mmu.privilege;
    }

    while (steps < maxSteps && !cpu.halted) {
      if (cpu.mmu.mode !== 0n || cpu.mmu.privilege !== 3) {
        // Translated mode: interpreter-only (slow path covers page walks).
        if (!cpu.step()) break;
        steps++;
        this.stats.slowSteps++;
        this.refreshMode(cpu);
        continue;
      }

      const offset = cpu.mem.physToOffset(cpu.pc);
      if (offset < 0 || offset + 4 > cpu.mem.ramBytes) {
        if (!cpu.step()) break; // will raise an access fault
        steps++;
        this.stats.slowSteps++;
        this.refreshMode(cpu);
        continue;
      }

      const block = this.getBlock(offset);
      if (!block) {
        if (!cpu.step()) break;
        steps++;
        this.stats.slowSteps++;
        this.refreshMode(cpu);
        continue;
      }

      const ret = block.fn();
      this.stats.fastSteps += block.insns;
      cpu.instret += BigInt(block.insns);
      cpu.cycles += BigInt(block.insns);
      steps += block.insns;

      if (ret >= 0) {
        cpu.pc = BigInt.asUintN(64, BigInt(ret));
      } else {
        const slowPc = BigInt(-1 - ret);
        cpu.pc = slowPc;
        if (!cpu.step()) break;
        steps += 1;
        this.stats.slowSteps += 1;
        this.refreshMode(cpu);
      }
    }

    if (cpu.halted) return { kind: "exit", code: cpu.exitCode };
    const mcause = cpu.readCsr(CSR_MCAUSE, cpu.pc) ?? 0n;
    return { kind: "trap", cause: mcause, pc: cpu.pc };
  }

  private refreshMode(cpu: Cpu): void {
    if (cpu.mmu.satp !== this.lastSatp || cpu.mmu.privilege !== this.lastPrivilege) {
      this.invalidate();
      this.lastSatp = cpu.mmu.satp;
      this.lastPrivilege = cpu.mmu.privilege;
    }
  }

  /** Instrumentation for equivalence checks: run purely on the interpreter. */
  static runInterpreter(cpu: Cpu, maxSteps: number): CpuExit {
    return cpu.run(maxSteps);
  }
}
