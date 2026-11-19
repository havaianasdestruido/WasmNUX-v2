/**
 * The tiered execution engine (ADR-0002) and the region/module bookkeeping that
 * goes with it (ADR-0003).
 *
 * Tiers:
 *   0. interpreter, counting control-transfer targets to find hot code;
 *   1. baseline region JIT (straight translation, no folding);
 *   2. optimizing region JIT (`optimize: true` - constant propagation, folded
 *      addresses with elided bounds checks, single-branch arm elision).
 *
 * A region is compiled into one Wasm function inside one module; every block of
 * the region is registered as an entry point so other regions can tail-call it
 * through the shared dispatch table. Compiled module bytes are kept so the
 * "warm JIT cache" startup path (a Phase 3 feature that Phase 0 has to prove)
 * can skip compilation and pay instantiation only.
 */

import { EXIT } from '../cpu/state.ts';
import { decode, opcode, OP_MISC_MEM } from '../cpu/encoding.ts';
import type { CpuState, StopReason } from '../cpu/state.ts';
import { Interpreter, type MachinePort } from '../cpu/interp.ts';
import type { GuestMemory } from '../machine/memory.ts';
import { GLOBAL_NAMES } from './regfile.ts';
import { buildCfg, formRegion, type BasicBlock, type Region } from './cfg.ts';
import { DEFAULT_JIT_CONFIG, translateRegion, validateConfig, type JitConfig, type LinkTarget } from './codegen.ts';
import { G, RegFile } from './regfile.ts';
import { WasmModuleBuilder, compileModuleSync, createFuncTable } from './wasm/encoder.ts';

/** Wasm pages needed to cover the RV32 physical address space (4 GiB). */
export const MAX_WASM_PAGES_RV32 = 65536;

/** Traps at one pc before its region is retired in favour of the interpreter. */
export const MAX_TRAPS_PER_PC = 3;

/**
 * Tier-down thresholds (ADR-0002's "the interpreter is a tier, not a fallback").
 *
 * Every return to the host costs a register-file sync, and a sync is ~64
 * property accesses on `WebAssembly.Global` objects - measured at roughly a
 * microsecond, which is dozens of interpreted instructions. A region that leaves
 * compiled code every few instructions is therefore *slower* than not compiling
 * it at all: an MMIO polling loop measured 13x slower than the interpreter
 * before this heuristic existed. Once a region has exited enough times to be
 * statistically clear about its own shape, and it retires fewer than
 * `TIER_DOWN_INSNS_PER_EXIT` instructions per exit, it is retired and its blocks
 * are declined so the interpreter owns that code for good.
 */
export const TIER_DOWN_EXITS = 32;
/**
 * Instructions a region must retire per host exit to be worth compiling.
 *
 * Derived from measurement, not taste: one exit costs a register-file sync
 * (~64 `WebAssembly.Global` property accesses) plus the dispatcher round trip,
 * about 1 us here, and the interpreter retires ~40 instructions in that time. A
 * device-polling loop retires 4 instructions per exit and measured 14x *slower*
 * compiled than interpreted; a real loop retires millions per exit. 32 sits
 * between the two by an order of magnitude on either side. The honest fix is to
 * calibrate this from a measured sync cost at startup (Phase 1), since the cost
 * depends on the register-file placement: with `regalloc: 'memory'` there is no
 * sync at all and the break-even is much lower.
 */
export const TIER_DOWN_INSNS_PER_EXIT = 32;

export interface EngineOptions {
  /** Set false to run interpreter-only (the Spike A baseline). */
  jit?: boolean;
  /** Tier-2 optimisations on by default once a region is recompiled. */
  optimize?: boolean;
  config?: Partial<Omit<JitConfig, 'ramBase' | 'ramSize' | 'controlOffset'>>;
  /** Control-transfer executions before a target is considered hot. */
  hotThreshold?: number;
  /** Recompilation threshold for tier 1 -> tier 2 promotion. */
  optimizeThreshold?: number;
  maxRegionBlocks?: number;
  maxRegionInsns?: number;
  /** Interpret this many instructions between JIT checks. */
  interpChunk?: number;
  /** Maximum number of compiled regions (bounds memory and compile time). */
  maxRegions?: number;
  codeCache?: JitCodeCache;
}

export interface EngineStats {
  interpInstructions: number;
  jitInstructions: number;
  interpSteps: number;
  regionsCompiled: number;
  blocksCompiled: number;
  wasmBytes: number;
  compileMs: number;
  instantiateMs: number;
  cacheHits: number;
  /** Returns to the JS dispatcher (the cost `chaining: 'tail'` removes). */
  hostExits: number;
  /** Region entries resolved through the dispatch table without the host. */
  tailChains: number;
  slowPathFaults: number;
  /** Wasm out-of-bounds traps caught and re-executed precisely. */
  wasmTraps: number;
  syscalls: number;
  declinedPcs: number;
  /** Regions retired because they exited to the host too often to pay for themselves. */
  tierDowns: number;
}

export const emptyStats = (): EngineStats => ({
  interpInstructions: 0,
  jitInstructions: 0,
  interpSteps: 0,
  regionsCompiled: 0,
  blocksCompiled: 0,
  wasmBytes: 0,
  compileMs: 0,
  instantiateMs: 0,
  cacheHits: 0,
  hostExits: 0,
  tailChains: 0,
  slowPathFaults: 0,
  wasmTraps: 0,
  syscalls: 0,
  declinedPcs: 0,
  tierDowns: 0,
});

interface CompiledRegion {
  /** Returns `[reason, budgetLeft]` for `(entryBlock, budget)`. */
  call: (entryBlock: number, budget: number) => { reason: number; budget: number };
  /** Slot in the shared dispatch table, or -1 without tail chaining. */
  slot: number;
  /** Block start address -> entry index. */
  blocks: Map<number, number>;
  /** Block starts, ascending: used to work out how much of a block retired. */
  blockStarts: number[];
  /** Instructions charged to the budget per block, indexed by entry index. */
  blockLengths: number[];
  moduleBytes: Uint8Array;
  optimized: boolean;
  heat: number;
  /** Host exits and instructions retired, for the tier-down heuristic. */
  hostExits: number;
  retired: number;
}

/** Where a compiled region lives, looked up by guest pc. */
interface EntryPoint {
  region: CompiledRegion;
  entryBlock: number;
}

export interface CacheRecord {
  /** Guest pc this module was compiled for. */
  pc: number;
  /** Block start addresses, in entry-index order. */
  blocks: number[];
  /** Instructions per block, parallel to `blocks` (for exact retire counts). */
  blockLengths?: number[];
  /** Compiled module bytes. */
  bytes: number[];
  optimized: boolean;
}

/**
 * Persisted JIT code cache. Phase 0 only needs to prove that a warm cache turns
 * compile time into instantiate time; Phase 3 stores this in IndexedDB/OPFS.
 */
export class JitCodeCache {
  constructor(
    readonly imageHash: string,
    readonly configHash: string,
    readonly records: CacheRecord[] = [],
  ) {}

  private index = new Map<number, CacheRecord>();

  private buildIndex(): void {
    this.index.clear();
    for (const r of this.records) this.index.set(r.pc, r);
  }

  lookup(pc: number, optimized: boolean): CacheRecord | undefined {
    if (this.index.size === 0 && this.records.length) this.buildIndex();
    const r = this.index.get(pc >>> 0);
    return r && r.optimized === optimized ? r : undefined;
  }

  add(record: CacheRecord): void {
    this.records.push(record);
    this.index.set(record.pc, record);
  }

  /**
   * Drop the module compiled for `pc`. Needed when the runtime learns something
   * that changes how a region must be translated (a pc marked slow), because the
   * cached bytes were produced without that knowledge.
   */
  remove(pc: number): void {
    const key = pc >>> 0;
    this.index.delete(key);
    const i = this.records.findIndex((r) => (r.pc >>> 0) === key);
    if (i >= 0) this.records.splice(i, 1);
  }

  toJSON(): string {
    return JSON.stringify({ imageHash: this.imageHash, configHash: this.configHash, records: this.records });
  }

  static fromJSON(text: string): JitCodeCache {
    const o = JSON.parse(text) as { imageHash: string; configHash: string; records: CacheRecord[] };
    return new JitCodeCache(o.imageHash, o.configHash, o.records);
  }
}

export function configHash(cfg: JitConfig): string {
  return [
    cfg.regalloc,
    cfg.bounds,
    cfg.pcTracking,
    cfg.budgetCheck,
    cfg.chaining,
    cfg.optimize ? 'opt' : 'base',
    cfg.sharedAtomics ? 'atomic' : 'plain',
    cfg.ramBase.toString(16),
    cfg.ramSize.toString(),
  ].join('|');
}

export class Engine {
  readonly stats: EngineStats = emptyStats();
  readonly config: JitConfig;
  private readonly interp: Interpreter;
  private readonly rf: RegFile;
  private readonly table: WebAssembly.Table | null;
  private readonly compiled = new Map<number, EntryPoint>();
  private readonly heat = new Map<number, number>();
  private readonly declined = new Set<number>();
  /** Fault/trap counts per pc, used to learn which pcs compiled code cannot own. */
  private readonly trapCounts = new Map<number, number>();
  /** Pcs learned to fault: blocks are split before them (see CfgOptions.slowPcs). */
  private readonly slowPcs = new Set<number>();
  /** Hot pc -> compiled successor, when the hot pc itself is slow. */
  private readonly redirects = new Map<number, number>();
  private nextSlot = 0;
  private readonly opts: Required<Omit<EngineOptions, 'config' | 'codeCache'>> & { codeCache?: JitCodeCache };
  private regionsCompiled = 0;

  constructor(
    private readonly port: MachinePort,
    private readonly mem: GuestMemory,
    options: EngineOptions = {},
  ) {
    this.opts = {
      jit: options.jit ?? true,
      optimize: options.optimize ?? true,
      hotThreshold: options.hotThreshold ?? 32,
      optimizeThreshold: options.optimizeThreshold ?? 4096,
      maxRegionBlocks: options.maxRegionBlocks ?? 24,
      maxRegionInsns: options.maxRegionInsns ?? 512,
      interpChunk: options.interpChunk ?? 64,
      maxRegions: options.maxRegions ?? 512,
      codeCache: options.codeCache,
    };
    this.interp = new Interpreter(port);
    const base: JitConfig = {
      ...DEFAULT_JIT_CONFIG,
      ...options.config,
      optimize: false,
      ramBase: mem.ramBase,
      ramSize: mem.ramSize,
      controlOffset: mem.hasControlPage ? mem.controlOffset : 0,
      sharedAtomics: mem.shared,
    };
    validateConfig(base);
    if (base.bounds === 'trap' && mem.hasControlPage) {
      // A trailing control page would silently absorb out-of-range accesses
      // instead of trapping, so trap-based bounds need guest RAM to be the whole
      // memory. Use `regalloc: 'memory'` (with `bounds: 'inline'`) for that layout.
      throw new Error("bounds:'trap' cannot be used with a control page in guest RAM");
    }
    this.config = base;
    this.rf = new RegFile(base.regalloc, base.controlOffset);
    if (base.regalloc === 'memory') this.rf.attachMemory(mem.buffer);
    this.table = base.chaining === 'tail' ? createFuncTable(64, 4096) : null;
  }

  get regFile(): RegFile {
    return this.rf;
  }

  get interpreter(): Interpreter {
    return this.interp;
  }

  reset(): void {
    this.compiled.clear();
    this.heat.clear();
    this.declined.clear();
    this.trapCounts.clear();
    this.slowPcs.clear();
    this.redirects.clear();
    this.regionsCompiled = 0;
    Object.assign(this.stats, emptyStats());
  }

  /** Copy architectural state into the JIT's own storage (entering compiled code). */
  private pullState(cpu: CpuState): void {
    this.rf.syncFrom(cpu.regs, cpu.pc);
    // The LR/SC reservation lives in JIT state while compiled code runs; the
    // interpreter keeps its copy in `cpu`, so both directions must carry it or a
    // fault between LR.W and SC.W would silently break the reservation.
    this.rf.setLr(cpu.lrAddr, cpu.lrValue, cpu.lrValid);
  }

  /** Copy JIT state back out (leaving compiled code, for any reason). */
  private pushState(cpu: CpuState): void {
    cpu.pc = this.rf.syncTo(cpu.regs);
    cpu.lrAddr = this.rf.lrAddr;
    cpu.lrValue = this.rf.lrValue;
    cpu.lrValid = this.rf.lrValid;
  }

  /** Compiled module bytes, for the code cache and for size metrics. */
  compiledModules(): Array<{ pc: number; bytes: Uint8Array; blocks: number[]; optimized: boolean }> {
    const seen = new Set<CompiledRegion>();
    const out: Array<{ pc: number; bytes: Uint8Array; blocks: number[]; optimized: boolean }> = [];
    for (const [pc, ep] of this.compiled) {
      if (seen.has(ep.region)) continue;
      if (ep.entryBlock !== 0) continue;
      seen.add(ep.region);
      out.push({ pc, bytes: ep.region.moduleBytes, blocks: [...ep.region.blocks.keys()].sort((a, b) => a - b), optimized: ep.region.optimized });
    }
    return out;
  }

  /** Run at most `budget` instructions, returning why we stopped. */
  run(cpu: CpuState, budget: number): StopReason {
    if (!this.opts.jit) {
      const before = cpu.instret;
      const reason = this.interp.run(cpu, budget);
      this.stats.interpInstructions += cpu.instret - before;
      this.stats.interpSteps += cpu.instret - before;
      return reason;
    }
    let remaining = budget;
    let inJit = false;

    while (remaining > 0 && cpu.stop === 'running') {
      const pc = cpu.pc >>> 0;
      const ep = this.compiled.get(pc);

      if (!ep) {
        if (inJit) {
          this.pushState(cpu);
          inJit = false;
        }
        const consumed = this.interpretChunk(cpu, remaining);
        remaining -= consumed;
        this.stats.interpInstructions += consumed;
        if (cpu.stop !== 'running') break;
        this.maybeCompile(cpu);
        continue;
      }

      if (!inJit) {
        this.pullState(cpu);
        inJit = true;
      }
      const outcome = this.runCompiled(cpu, ep, remaining);
      remaining = outcome.remaining;
      // Every `leftJit` return has already synced the register file into `cpu`
      // and then let the host own one instruction, so `cpu` is authoritative now.
      // Syncing back the other way here would undo that step: an MMIO read would
      // be performed twice, a faulting instruction re-executed, an ecall's pc
      // rewound. Re-entering compiled code pulls `cpu` into the register file.
      if (outcome.leftJit) inJit = false;
      if (outcome.stop) break;
    }

    if (inJit) {
      this.pushState(cpu);
    }
    if (cpu.stop === 'running' && remaining <= 0) cpu.stop = 'running';
    return cpu.stop;
  }

  /** Tier 0: interpret a chunk, recording heat on control-transfer targets. */
  private interpretChunk(cpu: CpuState, remaining: number): number {
    const limit = Math.min(remaining, this.opts.interpChunk);
    const start = cpu.instret;
    for (let i = 0; i < limit && cpu.stop === 'running'; i++) {
      const before = cpu.pc;
      this.interp.step(cpu);
      this.stats.interpSteps++;
      if (cpu.stop !== 'running') break;
      const after = cpu.pc >>> 0;
      // Any non-sequential transfer marks its target hot (loops heat fastest).
      if (after !== ((before + 4) >>> 0)) {
        const h = (this.heat.get(after) ?? 0) + 1;
        this.heat.set(after, h);
        // Join compiled code at the earliest safe point. Checking only on control
        // transfers keeps the interpreter baseline honest (a map lookup per
        // instruction would cost a third of its speed) while still entering a
        // compiled region on the first backward edge of a hot loop. Without this
        // the chunk boundary phase-locks inside a block and the JIT never runs.
        if (this.compiled.has(after)) break;
      } else if (this.slowPcs.size !== 0 && this.compiled.has(after)) {
        // A known-slow instruction (an MMIO access the interpreter just emulated)
        // is usually followed by a compiled block: the rest of the polling loop.
        // Joining here keeps such loops at JIT speed instead of drifting to the
        // next chunk boundary. The `size` test keeps the common case - no slow
        // pcs at all - down to one property read per instruction.
        break;
      }
    }
    return cpu.instret - start;
  }

  private maybeCompile(cpu: CpuState): void {
    if (this.regionsCompiled >= this.opts.maxRegions) return;
    // Pick the hottest known target, not necessarily the current pc: the current
    // pc may be a one-off, while the loop header it keeps jumping to is hot.
    let best: number | null = null;
    let bestHeat = 0;
    for (const [pc, h] of this.heat) {
      if (h < this.opts.hotThreshold) continue;
      if (this.compiled.has(pc) || this.declined.has(pc)) continue;
      if (h > bestHeat) {
        bestHeat = h;
        best = pc;
      }
    }
    if (best === null) {
      // Still compile the current pc once it is hot, so straight-line hot code
      // (e.g. memcpy) gets picked up too.
      const h = this.heat.get(cpu.pc >>> 0) ?? 0;
      if (h < this.opts.hotThreshold) return;
      best = cpu.pc >>> 0;
    }
    this.heat.delete(best);
    this.compileAt(best, false);
  }

  /** Follow compiled regions until the host is needed. */
  private runCompiled(cpu: CpuState, entry: EntryPoint, budget: number): { remaining: number; leftJit: boolean; stop: boolean } {
    let current = entry;
    let b = budget;
    let hops = 0;

    for (;;) {
      const before = b;
      let res: { reason: number; budget: number };
      try {
        res = current.region.call(current.entryBlock, b);
      } catch (err) {
        // `bounds: 'trap'` turns an out-of-range guest address into a Wasm
        // RuntimeError. G.PC was written before the access, so the host knows
        // exactly where to resume: single-step it and let the interpreter do the
        // MMIO emulation or raise the RISC-V fault.
        if (!(err instanceof WebAssembly.RuntimeError)) throw err;
        this.stats.wasmTraps++;
        this.pushState(cpu);
        // The region threw, so it never reported a budget and nothing was
        // charged. The instructions before the faulting one did retire, and the
        // pc was published ahead of the access, so they can be counted exactly.
        const trapped = cpu.pc >>> 0;
        const executed = this.retirePartial(current.region, trapped);
        cpu.instret += executed;
        cpu.cycles += executed;
        this.stats.jitInstructions += executed;
        this.learnSlowPc(trapped, current.region);
        this.noteHostExit(current.region, executed);
        this.interp.step(cpu);
        this.stats.interpSteps++;
        return { remaining: before - executed - 1, leftJit: true, stop: cpu.stop !== 'running' };
      }
      b = res.budget;
      const consumed = Math.max(0, before - b);
      this.stats.jitInstructions += consumed;
      // The region charged its budget but cannot touch guest counters, so the
      // retire count and the 1 IPC cycle model are applied here.
      cpu.instret += consumed;
      cpu.cycles += consumed;
      const reason = res.reason;
      current.region.heat += consumed;

      switch (reason) {
        case EXIT.BUDGET: {
          // Nothing in this block ran; give the instructions back.
          const fix = this.retireCorrection(current.region, this.rf.pc);
          cpu.instret += fix;
          cpu.cycles += fix;
          this.stats.jitInstructions += fix;
          return { remaining: 0, leftJit: false, stop: false };
        }
        case EXIT.CHAIN: {
          this.stats.hostExits++;
          const pc = this.rf.pc;
          const next = this.compiled.get(pc);
          if (next && b > 0 && hops < 100000) {
            hops++;
            current = next;
            continue;
          }
          // No compiled successor: hand the precise target pc to the host.
          this.noteHostExit(current.region, consumed);
          this.pushState(cpu);
          return { remaining: b, leftJit: true, stop: false };
        }
        case EXIT.SYSCALL: {
          // Compiled code charged the ecall as part of its block and already
          // advanced pc past it, so the host only has to run the port.
          this.noteHostExit(current.region, consumed);
          this.pushState(cpu);
          this.stats.syscalls++;
          this.port.onSyscall(cpu);
          return { remaining: b, leftJit: true, stop: cpu.stop !== 'running' };
        }
        case EXIT.FAULT: {
          // The faulting access did not retire; the block's earlier ones did.
          const faultPc = this.rf.pc >>> 0;
          const fix = this.retireCorrection(current.region, faultPc);
          cpu.instret += fix;
          cpu.cycles += fix;
          this.stats.jitInstructions += fix;
          this.learnSlowPc(faultPc, current.region);
          this.noteHostExit(current.region, consumed + fix);
          this.pushState(cpu);
          this.stats.slowPathFaults++;
          this.interp.step(cpu);
          this.stats.interpSteps++;
          return { remaining: b - 1, leftJit: true, stop: cpu.stop !== 'running' };
        }
        case EXIT.RETIRE: {
          // Precise single-step: `$pc` points at the instruction that faulted or
          // that the JIT declined, and nothing after it has executed.
          this.noteHostExit(current.region, consumed);
          this.pushState(cpu);
          this.stats.slowPathFaults++;
          if (this.isFenceI(cpu.pc)) {
            // Self-modifying code: every compiled region may be stale. Flushing
            // on FENCE.I is what makes the region cache safe for kernels and
            // bootloaders that patch their own text.
            this.invalidateAll('fence.i');
          }
          this.interp.step(cpu);
          this.stats.interpSteps++;
          return { remaining: b - 1, leftJit: true, stop: cpu.stop !== 'running' };
        }
        case EXIT.IDLE: {
          // wfi was charged with its block; pc is already past it.
          this.noteHostExit(current.region, consumed);
          this.pushState(cpu);
          if (this.port.onIdle(cpu)) return { remaining: b, leftJit: true, stop: cpu.stop !== 'running' };
          cpu.stop = 'idle';
          return { remaining: b, leftJit: true, stop: true };
        }
        case EXIT.BREAK: {
          this.noteHostExit(current.region, consumed);
          this.pushState(cpu);
          cpu.stop = 'breakpoint';
          return { remaining: b, leftJit: true, stop: true };
        }
        case EXIT.INVALID:
        default: {
          this.noteHostExit(current.region, consumed);
          this.declined.add(this.rf.pc);
          this.stats.declinedPcs++;
          this.pushState(cpu);
          this.interp.step(cpu);
          this.stats.interpSteps++;
          return { remaining: b - 1, leftJit: true, stop: cpu.stop !== 'running' };
        }
      }
    }
  }

  /**
   * Compile (or re-instantiate from cache) the region starting at `pc`.
   * Returns the entry point, or null when the pc cannot be translated.
   */
  compileAt(pc: number, optimize: boolean): EntryPoint | null {
    const target = pc >>> 0;
    if (this.declined.has(target)) return null;
    const existing = this.compiled.get(target);
    if (existing && existing.region.optimized === optimize) return existing;

    const redirect = this.redirects.get(target);
    if (redirect !== undefined) {
      const ep = this.compiled.get(redirect);
      if (ep) return ep;
      this.redirects.delete(target); // region was retired; fall through and rebuild
    }

    const cache = this.opts.codeCache;
    const cached = cache?.lookup(target, optimize);
    if (cached) {
      const region = this.instantiate(
        target,
        Uint8Array.from(cached.bytes),
        cached.blocks,
        cached.blockLengths ?? [],
        optimize,
        0,
      );
      if (region) {
        this.stats.cacheHits++;
        return this.compiled.get(target) ?? null;
      }
    }

    const scan = this.cfgScanOptions();
    const limits = { maxRegionBlocks: this.opts.maxRegionBlocks, maxRegionInsns: this.opts.maxRegionInsns };
    let entry = target;
    let region = formRegion(buildCfg(this.mem, entry, scan), entry, limits);
    if ((!region || region.blocks.length === 0) && this.slowPcs.has(entry)) {
      // The hot pc is itself an instruction the host has to own (the MMIO access
      // of a polling loop, typically). Compile from the next instruction and
      // record the redirect: the interpreter single-steps the slow instruction
      // and lands exactly on the compiled successor, so the rest of the loop
      // still runs at JIT speed.
      entry = (entry + 4) >>> 0;
      if (this.declined.has(entry)) {
        this.declined.add(target);
        this.stats.declinedPcs++;
        return null;
      }
      region = formRegion(buildCfg(this.mem, entry, scan), entry, limits);
      if (region && region.blocks.length > 0) this.redirects.set(target, entry);
    }
    if (!region || region.blocks.length === 0) {
      this.declined.add(target);
      this.stats.declinedPcs++;
      return null;
    }

    const links = new Map<number, LinkTarget>();
    if (this.config.chaining === 'tail' && this.table) {
      for (const t of region.externalTargets) {
        const ep = this.compiled.get(t);
        if (ep) links.set(t, { slot: ep.region.slot, entryBlock: ep.entryBlock });
      }
    }

    const cfg: JitConfig = { ...this.config, optimize };
    const builder = new WasmModuleBuilder();
    const pages = this.mem.memory.buffer.byteLength / 65536;
    // Shared memories require a declared maximum, and an import descriptor only
    // has to be *at least* as permissive as the memory it binds to, so the cap
    // is RV32's whole 4 GiB address space: correct for a memory we created and
    // for one attached by a vCPU worker.
    builder.importMemory('wnx', 'mem', { min: pages, max: MAX_WASM_PAGES_RV32, shared: this.mem.shared });
    if (cfg.regalloc === 'globals') {
      for (let i = 0; i < G.COUNT; i++) builder.importGlobal('wnx', GLOBAL_NAMES[i]!, 'i32', true);
    }
    if (cfg.chaining === 'tail') builder.importTable('wnx', 'table', this.table!.length, 4096);
    const dispatchType = builder.addType(['i32', 'i32'], ['i32', 'i32']);

    const t0 = performance.now();
    let funcIndex: number;
    try {
      funcIndex = translateRegion({ b: builder, region, cfg, links, dispatchType }, 'r0');
    } catch (err) {
      this.declined.add(target);
      this.stats.declinedPcs++;
      throw new Error(`translation failed at 0x${entry.toString(16)}: ${(err as Error).message}`);
    }
    builder.exportFunc('r0', funcIndex);
    const bytes = builder.build();
    const t1 = performance.now();
    this.stats.compileMs += t1 - t0;

    const ep = this.instantiate(
      entry,
      bytes,
      region.blocks.map((b) => b.start),
      region.blocks.map((b) => b.words.length),
      optimize,
      t1,
    );
    if (!ep) return null;
    this.stats.wasmBytes += bytes.length;
    this.stats.blocksCompiled += region.blocks.length;
    this.stats.regionsCompiled++;
    this.regionsCompiled++;
    cache?.add({
      pc: entry,
      blocks: region.blocks.map((b) => b.start),
      blockLengths: region.blocks.map((b) => b.words.length),
      bytes: Array.from(bytes),
      optimized: optimize,
    });
    return ep;
  }

  private instantiate(
    pc: number,
    bytes: Uint8Array,
    blockStarts: number[],
    blockLengths: number[],
    optimize: boolean,
    startedAt: number,
  ): EntryPoint | null {
    const imports = this.config.regalloc === 'globals' ? this.rf.imports('wnx') : { wnx: {} };
    const env = imports['wnx'] as Record<string, unknown>;
    env['mem'] = this.mem.memory;
    if (this.config.chaining === 'tail') env['table'] = this.table;

    try {
      const instance = compileModuleSync(bytes as Uint8Array<ArrayBuffer>, imports);
      this.stats.instantiateMs += performance.now() - startedAt;
      const raw = instance.exports['r0'] as WebAssembly.ExportValue as (entryBlock: number, budget: number) => unknown;
      const slot = this.allocateSlot(raw as unknown as WebAssembly.ExportValue);
      const region: CompiledRegion = {
        call: makeCaller(raw),
        slot,
        blocks: new Map(blockStarts.map((start, i) => [start >>> 0, i])),
        blockStarts: [...blockStarts].map((x) => x >>> 0).sort((a, b) => a - b),
        blockLengths: blockLengths,
        moduleBytes: bytes,
        optimized: optimize,
        heat: 0,
        hostExits: 0,
        retired: 0,
      };
      for (const [start, index] of region.blocks) {
        this.compiled.set(start, { region, entryBlock: index });
      }
      return this.compiled.get(pc) ?? null;
    } catch (err) {
      this.declined.add(pc);
      this.stats.declinedPcs++;
      throw new Error(`instantiation failed for region at 0x${pc.toString(16)}: ${(err as Error).message}`);
    }
  }

  private allocateSlot(fn: WebAssembly.ExportValue): number {
    if (!this.table) return -1;
    const slot = this.nextSlot++;
    if (slot >= this.table.length) this.table.grow(slot - this.table.length + 16);
    this.table.set(slot, fn as unknown as (...args: number[]) => number);
    return slot;
  }

  /**
   * Promote hot tier-1 regions to tier 2. Called by the machine between runs so
   * the policy can be measured (ADR-0002 tiering benefit).
   */
  promoteHotRegions(): number {
    if (!this.opts.optimize) return 0;
    let promoted = 0;
    for (const [pc, ep] of [...this.compiled]) {
      if (ep.entryBlock !== 0) continue;
      if (ep.region.optimized) continue;
      if (ep.region.heat < this.opts.optimizeThreshold) continue;
      for (const start of ep.region.blocks.keys()) this.compiled.delete(start);
      if (this.compileAt(pc, true)) promoted++;
    }
    return promoted;
  }

  private cfgScanOptions(): { maxBlocks: number; maxBlockInsns: number; slowPcs: ReadonlySet<number> } {
    return { maxBlocks: this.opts.maxRegionBlocks * 4, maxBlockInsns: 64, slowPcs: this.slowPcs };
  }

  /** Index of the block whose range contains `pc`, or -1. */
  private blockIndexAt(region: CompiledRegion, pc: number): number {
    const starts = region.blockStarts;
    let lo = 0;
    let hi = starts.length - 1;
    let found = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (starts[mid]! <= pc) {
        found = mid;
        lo = mid + 1;
      } else hi = mid - 1;
    }
    if (found < 0) return -1;
    const index = region.blocks.get(starts[found]!);
    return index === undefined ? -1 : index;
  }

  /** Instructions of the block containing `pc` that completed before `pc`. */
  private retirePartial(region: CompiledRegion, pc: number): number {
    const index = this.blockIndexAt(region, pc);
    if (index < 0) return 0;
    const executed = (pc - region.blockStarts[index]!) >>> 2;
    const charged = region.blockLengths[index] ?? 0;
    return executed > charged ? charged : executed;
  }

  /**
   * Count a fault or trap at `pc`. A pc that keeps faulting is an access compiled
   * code cannot own - MMIO polling, an unmapped probe - so it is marked slow and
   * its region is retired *without* being declined: the next translation splits
   * the block before it and everything else in the loop stays compiled. Retiring
   * alone would loop forever, because the region would be recompiled identically
   * and fault again on the same instruction.
   */
  private learnSlowPc(pc: number, region: CompiledRegion): void {
    const hits = (this.trapCounts.get(pc) ?? 0) + 1;
    this.trapCounts.set(pc, hits);
    if (hits < MAX_TRAPS_PER_PC) return;
    this.trapCounts.delete(pc);
    this.slowPcs.add(pc);
    const cache = this.opts.codeCache;
    if (cache) for (const start of region.blocks.keys()) cache.remove(start);
    this.retireRegionAt(pc, false);
  }

  /**
   * Account a host exit and tier the region down if it cannot pay for itself.
   * Returns true when the region was retired, so callers stop using it.
   */
  private noteHostExit(region: CompiledRegion, retired: number): boolean {
    region.hostExits++;
    region.retired += Math.max(0, retired);
    if (region.hostExits < TIER_DOWN_EXITS) return false;
    if (region.retired / region.hostExits >= TIER_DOWN_INSNS_PER_EXIT) return false;
    for (const start of region.blocks.keys()) {
      this.compiled.delete(start);
      this.declined.add(start);
    }
    // A redirect into a retired region would rebuild the same shape and tier
    // down again forever, so retire the redirect and decline its source too.
    for (const [from, to] of this.redirects) {
      if (region.blocks.has(to)) {
        this.redirects.delete(from);
        this.declined.add(from);
      }
    }
    this.stats.declinedPcs += region.blocks.size;
    this.stats.tierDowns++;
    return true;
  }

  /**
   * The region charges its budget a whole block at a time, so when the host takes
   * over mid-block (budget exhausted, a bounds fault, a Wasm trap) the retire
   * count has to be corrected down to the instructions that really executed.
   * `pc` is precise in every one of those cases, which is what makes this exact.
   */
  private retireCorrection(region: CompiledRegion, pc: number): number {
    const index = this.blockIndexAt(region, pc);
    if (index < 0) return 0;
    const executed = (pc - region.blockStarts[index]!) >>> 2;
    const charged = region.blockLengths[index] ?? 0;
    if (executed >= charged) return 0;
    return executed - charged; // negative
  }

  private isFenceI(pc: number): boolean {
    const off = this.mem.ramOffset(pc >>> 0);
    if (off < 0) return false;
    const word = this.mem.view.getUint32(off, true);
    if (opcode(word) !== OP_MISC_MEM) return false;
    return decode(word, pc >>> 0).mnemonic === 'fence.i';
  }

  /** Drop every compiled region (code-cache flush, image swap, snapshot restore). */
  invalidateAll(_reason = 'explicit'): number {
    const n = this.compiled.size;
    this.compiled.clear();
    this.heat.clear();
    this.trapCounts.clear();
    this.regionsCompiled = 0;
    this.nextSlot = 0;
    return n;
  }

  /** Retire the region containing a pc, and refuse to recompile those blocks. */
  private retireRegionAt(pc: number, decline = true): void {
    const target = pc >>> 0;
    const ep = this.compiled.get(target) ?? this.compiled.get(this.redirects.get(target) ?? -1);
    if (!ep) {
      if (decline) {
        this.declined.add(target);
        this.stats.declinedPcs++;
      }
      return;
    }
    for (const start of ep.region.blocks.keys()) {
      this.compiled.delete(start);
      if (decline) this.declined.add(start);
    }
    if (decline) {
      this.stats.declinedPcs++;
      return;
    }
    // Retired so it can be recompiled with the new slow-pc split; any redirect
    // into it is stale and must be recomputed.
    for (const [from, to] of this.redirects) {
      if (!this.compiled.has(to)) this.redirects.delete(from);
    }
  }

  /** Blocks visible for tests and metrics. */
  blockCount(): number {
    let n = 0;
    const seen = new Set<CompiledRegion>();
    for (const ep of this.compiled.values()) {
      if (seen.has(ep.region)) continue;
      seen.add(ep.region);
      n += ep.region.blocks.size;
    }
    return n;
  }

  /** Exposed for tests: the CFG-derived region that would be compiled at `pc`. */
  planRegion(pc: number): Region | null {
    const blocks = buildCfg(this.mem, pc, this.cfgScanOptions());
    return formRegion(blocks, pc, {
      maxRegionBlocks: this.opts.maxRegionBlocks,
      maxRegionInsns: this.opts.maxRegionInsns,
    });
  }

  /** Exposed for tests that want to inspect block discovery without compiling. */
  planBlocks(pc: number): Map<number, BasicBlock> {
    return buildCfg(this.mem, pc, { maxBlocks: 4096, maxBlockInsns: 64 });
  }
}

/**
 * Wasm multi-value returns arrive as an array in JS; older engines (and the
 * `memory` regalloc variant used in some probes) may return a single value.
 * Normalising here keeps the hot loop branch-free in spirit and correct in fact.
 */
function makeCaller(raw: (...args: number[]) => unknown): (entryBlock: number, budget: number) => { reason: number; budget: number } {
  return (entryBlock: number, budget: number) => {
    const out = raw(entryBlock, budget) as unknown;
    if (Array.isArray(out)) return { reason: out[0] as number, budget: out[1] as number };
    // Single-value fallback: the region wrote the remaining budget nowhere, so
    // assume the whole budget was consumed and let the host re-check.
    return { reason: out as number, budget: 0 };
  };
}
