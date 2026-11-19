/**
 * Spike A: the region JIT, differentially tested against the interpreter.
 *
 * Every program in the corpus is run twice - once interpreted, once through the
 * tiered engine - across every JIT configuration variant that Phase 0 measures.
 * Registers, guest RAM and the stop reason must be identical; that is the
 * correctness bar the ADR-0002/0003/0004 decisions are allowed to rest on.
 */

import { describe, expect, it } from 'vitest';
import { assemble } from '../src/cpu/asm.ts';
import { CpuState, EXIT } from '../src/cpu/state.ts';
import { GuestMemory } from '../src/machine/memory.ts';
import { Machine } from '../src/machine/machine.ts';
import { StringUartSink } from '../src/devices/uart.ts';
import { Engine, JitCodeCache, MAX_TRAPS_PER_PC, configHash } from '../src/jit/engine.ts';
import type { JitConfig } from '../src/jit/codegen.ts';
import { DEFAULT_JIT_CONFIG, translateRegion, validateConfig } from '../src/jit/codegen.ts';
import { buildCfg, formRegion } from '../src/jit/cfg.ts';
import { G, RegFile } from '../src/jit/regfile.ts';
import { WasmModuleBuilder, compileModuleSync } from '../src/jit/wasm/encoder.ts';
import { Interpreter, type MachinePort } from '../src/cpu/interp.ts';
import { EXIT as EXIT_ASM, RAM_BASE, RAM_BYTES, SCRATCH, run, runInterpreted } from './helpers.ts';

/** Configuration variants the spike measures (see docs/spikes/spike-a-jit.md). */
const VARIANTS: Array<{ name: string; config: Partial<JitConfig>; controlPage?: boolean; shared?: boolean }> = [
  { name: 'globals/trap/host', config: { regalloc: 'globals', bounds: 'trap', chaining: 'host' } },
  { name: 'globals/trap/tail', config: { regalloc: 'globals', bounds: 'trap', chaining: 'tail' } },
  { name: 'globals/inline/host', config: { regalloc: 'globals', bounds: 'inline', chaining: 'host' } },
  { name: 'memory/inline/host', config: { regalloc: 'memory', bounds: 'inline', chaining: 'host' }, controlPage: true },
  { name: 'memory/inline/tail', config: { regalloc: 'memory', bounds: 'inline', chaining: 'tail' }, controlPage: true },
  { name: 'globals/trap/instr-pc', config: { regalloc: 'globals', bounds: 'trap', pcTracking: 'instruction' } },
  { name: 'globals/trap/block-budget', config: { regalloc: 'globals', bounds: 'trap', budgetCheck: 'block' } },
  { name: 'shared/atomics', config: { regalloc: 'globals', bounds: 'trap', chaining: 'host' }, shared: true },
];

/** Programs covering every instruction class the translator implements. */
const CORPUS: Array<[string, string]> = [
  [
    'arith loop',
    `_start:
  li   a0, 0
  li   t0, 0
  li   t1, 60
  li   t2, 1
loop:
  add  t0, t0, t2
  mul  t3, t2, t2
  xor  a0, a0, t3
  addi t2, t2, 1
  blt  t2, t1, loop
  sw   t0, 0(sp)
  lw   t4, 0(sp)
  div  t5, t0, t4
  ${EXIT_ASM}`,
  ],
  [
    'amo arithmetic',
    `_start:
  li   a0, ${SCRATCH}
  li   t0, 0x12345678
  li   t1, 0x0f0f0f0f
  sw   t0, 0(a0)
  amoadd.w  s1, t1, (a0)
  amoswap.w s2, t1, (a0)
  amoxor.w  s3, t1, (a0)
  amoor.w   s4, t1, (a0)
  amoand.w  s5, t1, (a0)
  lw   s6, 0(a0)
  ${EXIT_ASM}`,
  ],
  [
    'amo min/max signed and unsigned',
    `_start:
  li   a0, ${SCRATCH}
  li   t0, -4
  li   t1, 7
  sw   t1, 0(a0)
  amomin.w  s1, t0, (a0)
  amomax.w  s2, t0, (a0)
  amominu.w s3, t0, (a0)
  amomaxu.w s4, t0, (a0)
  lw   s5, 0(a0)
  ${EXIT_ASM}`,
  ],
  [
    'amoadd in a hot loop',
    `_start:
  li   a0, ${SCRATCH}
  li   t0, 0
  li   t1, 40
  sw   t0, 0(a0)
loop:
  li   t2, 1
  amoadd.w t3, t2, (a0)
  addi t0, t0, 1
  blt  t0, t1, loop
  lw   t4, 0(a0)
  ${EXIT_ASM}`,
  ],
  [
    'lr/sc success and failure',
    `_start:
  li   a0, ${SCRATCH}
  li   t0, 11
  li   t1, 22
  li   t5, 99
  sw   t0, 0(a0)
  lr.w s1, (a0)
  sc.w s2, t1, (a0)
  lw   s3, 0(a0)
  sc.w s4, t1, (a0)
  lr.w s5, (a0)
  sw   t5, 0(a0)
  sc.w s6, t1, (a0)
  lw   s7, 0(a0)
  ${EXIT_ASM}`,
  ],
  [
    'lr/sc retry loop',
    `_start:
  li   a0, ${SCRATCH}
  sw   x0, 0(a0)
  li   t0, 30
retry:
  lr.w t1, (a0)
  addi t1, t1, 1
  sc.w t2, t1, (a0)
  bnez t2, retry
  addi t0, t0, -1
  bnez t0, retry
  lw   t3, 0(a0)
  ${EXIT_ASM}`,
  ],
  [
    'division and remainder corners',
    `_start:
  li   t0, 7
  li   t1, 0
  div  s1, t0, t1
  divu s2, t0, t1
  rem  s3, t0, t1
  remu s4, t0, t1
  lui  t2, 0x80000
  li   t3, -1
  div  s5, t2, t3
  rem  s6, t2, t3
  divu s7, t2, t3
  li   s8, -20
  div  s9, s8, t3
  rem  s10, s8, t3
  ${EXIT_ASM}`,
  ],
  [
    'calls, returns and indirect jumps',
    `_start:
  li   a0, 0
  jal  ra, f1
  addi a0, a0, 100
  la   t0, f2
  jalr ra, 0(t0)
  addi a0, a0, 1000
  j    fin
f1:
  addi a0, a0, 1
  ret
f2:
  addi a0, a0, 2
  ret
fin:
  ${EXIT_ASM}`,
  ],
  [
    'all load/store widths',
    `_start:
  li   a0, ${SCRATCH}
  li   t0, 0xdeadbeef
  sw   t0, 0(a0)
  lw   t1, 0(a0)
  lh   t2, 0(a0)
  lhu  t3, 0(a0)
  lb   t4, 0(a0)
  lbu  t5, 0(a0)
  sh   t0, 8(a0)
  lhu  t6, 8(a0)
  sb   t0, 12(a0)
  lbu  s1, 12(a0)
  ${EXIT_ASM}`,
  ],
  [
    'shifts, compares and logical immediates',
    `_start:
  li   t0, -16
  li   t1, 3
  sll  s1, t0, t1
  srl  s2, t0, t1
  sra  s3, t0, t1
  slt  s4, t0, t1
  sltu s5, t0, t1
  slli s6, t0, 5
  srli s7, t0, 5
  srai s8, t0, 5
  slti s9, t0, 4
  sltiu s10, t0, 4
  xori s11, t0, 6
  ori  a1, t0, 6
  andi a2, t0, 6
  ${EXIT_ASM}`,
  ],
  [
    'mmio through the device model',
    `_start:
  li   a0, 0x10000000
  li   t0, 5
loop:
  sw   t0, 0(a0)
  lw   t1, 0(a0)
  addi t0, t0, 1
  li   t2, 9
  blt  t0, t2, loop
  ${EXIT_ASM}`,
  ],
  [
    'csr access forces the slow path',
    `_start:
  li   t0, 4
loop:
  csrr t1, minstret
  addi t0, t0, -1
  bnez t0, loop
  csrw mscratch, t1
  csrr t2, mscratch
  ${EXIT_ASM}`,
  ],
  [
    'nested loops with a function call inside',
    `_start:
  li   a0, 0
  li   t0, 8
outer:
  li   t1, 8
  mv   a1, t0
inner:
  add  a0, a0, a1
  addi t1, t1, -1
  bnez t1, inner
  addi t0, t0, -1
  bnez t0, outer
  ${EXIT_ASM}`,
  ],
];

interface RunPair {
  ref: { regs: number[]; mem: Uint8Array; stop: string; instret: number };
  jit: { regs: number[]; mem: Uint8Array; stop: string; instret: number };
  engine: Engine;
}

/** Run one program interpreted and compiled, with identical starting state. */
function differential(src: string, variant: (typeof VARIANTS)[number], budget = 200_000): RunPair {
  const a = assemble(src, { base: RAM_BASE });
  const mk = (): { mem: GuestMemory; port: MachinePort; cpu: CpuState } => {
    const mem = new GuestMemory({
      ramBytes: RAM_BYTES,
      ramBase: RAM_BASE,
      controlPage: variant.controlPage ?? false,
      shared: variant.shared ?? false,
    });
    mem.u8.set(a.bytes, 0);
    const port: MachinePort = {
      mem,
      onSyscall(cpu) {
        cpu.stop = 'exit';
        cpu.exitCode = cpu.reg(10);
      },
      onMMIORead(cpu, addr, size) {
        cpu.stop = 'mmio';
        return size === 4 ? 0 : 0;
      },
      onMMIOWrite(cpu) {
        cpu.stop = 'mmio';
      },
      onIdle() {
        return false;
      },
    };
    const cpu = new CpuState({ pc: a.entry });
    cpu.setReg(2, SCRATCH + 0x4000); // sp
    return { mem, port, cpu };
  };

  const ref = mk();
  new Interpreter(ref.port).run(ref.cpu, budget);

  const jit = mk();
  const engine = new Engine(jit.port, jit.mem, {
    hotThreshold: 2,
    interpChunk: 8,
    optimize: true,
    config: { pcTracking: 'faulting', budgetCheck: 'loop', ...variant.config },
  });
  engine.run(jit.cpu, budget);

  const snap = (m: GuestMemory) => m.u8.slice(0, 0x10000);
  return {
    ref: { regs: Array.from(ref.cpu.regs), mem: snap(ref.mem), stop: ref.cpu.stop, instret: ref.cpu.instret },
    jit: { regs: Array.from(jit.cpu.regs), mem: snap(jit.mem), stop: jit.cpu.stop, instret: jit.cpu.instret },
    engine,
  };
}

describe('JIT matches the interpreter', () => {
  for (const variant of VARIANTS) {
    describe(variant.name, () => {
      for (const [name, src] of CORPUS) {
        it(name, () => {
          const { ref, jit, engine } = differential(src, variant);
          const stats = JSON.stringify(engine.stats);
          expect(jit.stop, `stop reason (${stats})`).toBe(ref.stop);
          expect(jit.regs, `registers (${stats})`).toEqual(ref.regs);
          expect(Array.from(jit.mem), `guest RAM (${stats})`).toEqual(Array.from(ref.mem));
          // Retire accounting is part of the contract: a guest reads minstret and
          // the KPI harness reads it too, so the tiered engine has to retire
          // exactly what the interpreter would have - no more, no less. Both the
          // double-counted host exit and the negative correction a throwing
          // region used to produce are caught by these lines.
          expect(jit.instret, `instret (${stats})`).toBe(ref.instret);
          expect(engine.stats.jitInstructions, stats).toBeGreaterThanOrEqual(0);
          expect(engine.stats.jitInstructions + engine.stats.interpInstructions, stats).toBe(ref.instret);
          // Heat only accrues on control transfers, so a straight-line program
          // legitimately compiles nothing. What must never happen is a region
          // that is compiled and then never entered - that was a real bug (the
          // interpreter chunk boundary phase-locked inside a block). The loop
          // case is asserted directly by 'compiles a hot loop and enters it'.
          expect(engine.stats.jitInstructions > 0 || engine.stats.regionsCompiled === 0, stats).toBe(true);
        });
      }
    });
  }
});

describe('config validation', () => {
  it("rejects bounds:'trap' with a memory register file", () => {
    expect(() =>
      validateConfig({
        ...DEFAULT_JIT_CONFIG,
        regalloc: 'memory',
        bounds: 'trap',
        ramBase: RAM_BASE,
        ramSize: RAM_BYTES,
        controlOffset: RAM_BYTES,
      }),
    ).toThrow(/globals/);
  });

  it('rejects trap bounds when a control page sits after guest RAM', () => {
    const mem = new GuestMemory({ ramBytes: RAM_BYTES, ramBase: RAM_BASE, controlPage: true });
    expect(
      () =>
        new Engine(
          { mem, onSyscall() {}, onMMIORead: () => 0, onMMIOWrite() {}, onIdle: () => false },
          mem,
          { config: { regalloc: 'globals', bounds: 'trap' } },
        ),
    ).toThrow(/control page/);
  });

  it('hashes a config deterministically and distinguishes variants', () => {
    const base: JitConfig = { ...DEFAULT_JIT_CONFIG, ramBase: RAM_BASE, ramSize: RAM_BYTES, controlOffset: -1 };
    expect(configHash(base)).toBe(configHash({ ...base }));
    expect(configHash(base)).not.toBe(configHash({ ...base, optimize: true }));
    expect(configHash(base)).not.toBe(configHash({ ...base, bounds: 'inline' }));
  });
});

describe('region translation', () => {
  /** Compile a single region by hand and return a callable plus its register file. */
  function compile(src: string, cfgOverride: Partial<JitConfig> = {}, entry?: number) {
    const a = assemble(src, { base: RAM_BASE });
    const cfg: JitConfig = {
      ...DEFAULT_JIT_CONFIG,
      ...cfgOverride,
      ramBase: RAM_BASE,
      ramSize: RAM_BYTES,
      controlOffset: cfgOverride.regalloc === 'memory' ? RAM_BYTES : -1,
    };
    const mem = new GuestMemory({ ramBytes: RAM_BYTES, ramBase: RAM_BASE, controlPage: cfg.regalloc === 'memory' });
    mem.u8.set(a.bytes, 0);
    const blocks = buildCfg(mem, entry ?? a.entry, { maxBlocks: 64, maxBlockInsns: 64 });
    const region = formRegion(blocks, entry ?? a.entry, { maxRegionBlocks: 24, maxRegionInsns: 512 })!;
    const rf = new RegFile(cfg.regalloc, cfg.controlOffset < 0 ? 0 : cfg.controlOffset);
    if (cfg.regalloc === 'memory') rf.attachMemory(mem.buffer);
    const b = new WasmModuleBuilder();
    const pages = mem.memory.buffer.byteLength / 65536;
    b.importMemory('wnx', 'mem', { min: pages, max: 65536, shared: mem.shared });
    if (cfg.regalloc === 'globals') {
      for (let i = 0; i < G.COUNT; i++) b.importGlobal('wnx', `g${i}`, 'i32', true);
    }
    const dispatchType = b.addType(['i32', 'i32'], ['i32', 'i32']);
    const fi = translateRegion({ b, region, cfg, links: new Map(), dispatchType }, 'r0');
    b.exportFunc('r0', fi);
    const bytes = b.build();
    expect(WebAssembly.validate(bytes), 'generated module must validate').toBe(true);
    const env: Record<string, WebAssembly.ImportValue> = { mem: mem.memory };
    if (cfg.regalloc === 'globals') {
      for (let i = 0; i < G.COUNT; i++) env[`g${i}`] = rf.globals[i]!;
    }
    const instance = compileModuleSync(bytes, { wnx: env });
    return {
      bytes,
      region,
      mem,
      rf,
      entry: entry ?? a.entry,
      labels: a.labels,
      run: (entryBlock: number, budget: number) =>
        (instance.exports['r0'] as (e: number, b: number) => [number, number])(entryBlock, budget),
    };
  }

  it('produces a validating module whose size is measurable', () => {
    const c = compile(CORPUS[0]![1]);
    expect(c.bytes.length).toBeGreaterThan(100);
    expect(c.bytes.length).toBeLessThan(8192);
    expect(c.region.blocks.length).toBeGreaterThan(1);
  });

  it('returns the exit reason and the remaining budget', () => {
    const c = compile(`_start:\n  addi t0, t0, 1\n${EXIT_ASM}`);
    c.rf.syncFrom(new Int32Array(32), c.entry);
    const [reason, budget] = c.run(0, 100);
    expect(reason).toBe(EXIT.SYSCALL);
    expect(budget).toBe(97); // one block of three: addi, `li a7, 93`, ecall
    expect(c.rf.pc >>> 0).toBe(c.entry + 4 + 4 + 4);
  });

  it('stops with EXIT.BUDGET and a precise pc when the budget runs out', () => {
    const c = compile(`_start:\n  li t1, 1000\nloop:\n  addi t0, t0, 1\n  addi t1, t1, -1\n  bnez t1, loop\n${EXIT_ASM}`);
    c.rf.syncFrom(new Int32Array(32), c.entry);
    const [reason, budget] = c.run(0, 4);
    expect(reason).toBe(EXIT.BUDGET);
    expect(budget).toBeLessThanOrEqual(0);
    // pc must point at the loop header: the host resumes exactly there.
    expect(c.rf.pc >>> 0).toBe(c.labels.get('loop'));
  });

  it('leaves the region with EXIT.CHAIN when control exits to an uncompiled pc', () => {
    // An indirect jump is the one exit whose target the translator cannot know,
    // so it leaves the region and lets the host look the target up.
    const far = (RAM_BASE + 0x4000) >>> 0;
    const c = compile(`_start:\n  addi t0, t0, 1\n  li t1, ${far}\n  jr t1\n`);
    c.rf.syncFrom(new Int32Array(32), c.entry);
    const [reason] = c.run(0, 100);
    expect(reason).toBe(EXIT.CHAIN);
    expect(c.rf.pc >>> 0).toBe(far);
  });

  it('folds a constant address into the memarg offset when optimizing', () => {
    const src = `_start:\n  li a0, ${SCRATCH}\n  li t0, 7\n  sw t0, 0(a0)\n  lw t1, 0(a0)\n${EXIT_ASM}`;
    const plain = compile(src, { optimize: false });
    const opt = compile(src, { optimize: true });
    // Constant propagation removes the address arithmetic, so the optimised
    // region is strictly smaller. This is the "folded address" KPI.
    expect(opt.bytes.length).toBeLessThan(plain.bytes.length);
    for (const c of [plain, opt]) {
      c.rf.syncFrom(new Int32Array(32), c.entry);
      c.run(0, 100);
      expect(c.mem.view.getUint32(SCRATCH - RAM_BASE, true)).toBe(7);
      expect(c.rf.getReg(6)).toBe(7);
    }
  });

  it('emits Wasm atomics only for shared memory', () => {
    const src = `_start:\n  li a0, ${SCRATCH}\n  li t0, 1\nloop:\n  amoadd.w t1, t0, (a0)\n  addi t2, t2, 1\n  li t3, 10\n  blt t2, t3, loop\n${EXIT_ASM}`;
    const shared = compile(src, { sharedAtomics: true });
    const plain = compile(src, { sharedAtomics: false });
    expect(shared.bytes.length).not.toBe(plain.bytes.length);
    // The atomic module only validates against a shared memory.
    expect(shared.mem.shared).toBe(false); // compile() builds non-shared RAM; the
    // engine path is what pairs sharedAtomics with a shared memory (tested below).
    expect(plain.region.blocks.length).toBeGreaterThan(1);
  });

  it('declines a region that starts on an illegal instruction', () => {
    const mem = new GuestMemory({ ramBytes: RAM_BYTES, ramBase: RAM_BASE });
    const a = assemble(`_start:\n  .word 0\n`, { base: RAM_BASE });
    mem.u8.set(a.bytes, 0);
    expect(buildCfg(mem, RAM_BASE, {}).size).toBe(0);
  });
});

describe('engine behaviour', () => {
  const LOOP = `_start:
  li   t0, 0
  li   t1, 2000
loop:
  add  t2, t2, t0
  addi t0, t0, 1
  blt  t0, t1, loop
  ${EXIT_ASM}`;

  it('compiles hot code and reports region/block metrics', () => {
    const r = run(LOOP, { jit: { hotThreshold: 4, interpChunk: 16 } });
    const s = r.machine.engine.stats;
    expect(s.regionsCompiled).toBeGreaterThan(0);
    expect(s.blocksCompiled).toBeGreaterThan(0);
    expect(s.jitInstructions).toBeGreaterThan(1000);
    expect(s.wasmBytes).toBeGreaterThan(0);
    expect(r.machine.engine.blockCount()).toBeGreaterThan(0);
    expect(r.reg(7)).toBe(1999 * 1000); // sum 0..1999 in t2
  });

  it('runs interpreter-only when jit is disabled', () => {
    const r = run(LOOP, { jit: false });
    expect(r.machine.engine.stats.regionsCompiled).toBe(0);
    expect(r.machine.engine.stats.jitInstructions).toBe(0);
    expect(r.machine.engine.stats.interpInstructions).toBeGreaterThan(2000);
    expect(r.reg(7)).toBe(1999 * 1000);
  });

  it('promotes a hot tier-1 region to tier 2', () => {
    const r = run(LOOP, { jit: { hotThreshold: 2, interpChunk: 8, optimizeThreshold: 16 } });
    const engine = r.machine.engine;
    const before = engine.compiledModules().length;
    expect(before).toBeGreaterThan(0);
    expect(engine.compiledModules().some((m) => m.optimized)).toBe(false);
    const promoted = engine.promoteHotRegions();
    expect(promoted).toBeGreaterThan(0);
    expect(engine.compiledModules().some((m) => m.optimized)).toBe(true);
  });

  it('reuses a warm code cache instead of recompiling', () => {
    const cache = new JitCodeCache('image', 'cfg');
    const first = run(LOOP, { jit: { hotThreshold: 2, interpChunk: 8, codeCache: cache } });
    expect(cache.records.length).toBeGreaterThan(0);
    expect(first.machine.engine.stats.cacheHits).toBe(0);

    // A cold engine with the same cache instantiates instead of compiling.
    const second = run(LOOP, { jit: { hotThreshold: 2, interpChunk: 8, codeCache: cache } });
    expect(second.machine.engine.stats.cacheHits).toBeGreaterThan(0);
    expect(second.reg(7)).toBe(first.reg(7));
    expect(second.machine.engine.stats.compileMs).toBeLessThanOrEqual(first.machine.engine.stats.compileMs + 1);
  });

  it('serialises and restores a code cache', () => {
    const cache = new JitCodeCache('img', 'cfg');
    run(LOOP, { jit: { hotThreshold: 2, interpChunk: 8, codeCache: cache } });
    const restored = JitCodeCache.fromJSON(cache.toJSON());
    expect(restored.imageHash).toBe('img');
    expect(restored.records.length).toBe(cache.records.length);
    const r = run(LOOP, { jit: { hotThreshold: 2, interpChunk: 8, codeCache: restored } });
    expect(r.machine.engine.stats.cacheHits).toBeGreaterThan(0);
    expect(r.reg(7)).toBe(1999 * 1000);
  });

  it('learns a trapping MMIO pc instead of spinning on it forever', () => {
    // bounds:'trap' turns an MMIO access into a Wasm trap. Retiring the region is
    // not enough on its own: it would be recompiled identically and trap again,
    // forever. So the pc is marked slow, the next translation splits the block
    // before it, and the rest of the polling loop stays compiled.
    const POLL = `_start:
  li   a0, 0x10000000
  li   t0, 0
poll:
  lbu  t1, 5(a0)
  andi t1, t1, 1
  beqz t1, poll
  lbu  t2, 0(a0)
  ${EXIT_ASM}`;
    const r = run(POLL, {
      budget: 20_000,
      jit: { hotThreshold: 1, interpChunk: 8, config: { regalloc: 'globals', bounds: 'trap' } },
    });
    const s = r.machine.engine.stats;
    expect(s.wasmTraps).toBeLessThanOrEqual(MAX_TRAPS_PER_PC); // it learns, then stops trapping
    expect(s.declinedPcs).toBe(0); // retired so it can be recompiled, not declined
    expect(s.regionsCompiled).toBeGreaterThan(1); // the split region replaced the first one
    expect(s.jitInstructions).toBeGreaterThan(0); // the loop body still runs compiled
    expect(s.interpInstructions).toBeGreaterThan(100); // the MMIO access does not
    expect(r.cpu.stop).toBe('running'); // still polling: no input yet

    // Now deliver a byte; the loop must observe it exactly once. Reading a device
    // register twice is a visible side effect, so the interpreted run is the
    // oracle for how many MMIO accesses may happen.
    const ref = runInterpreted(POLL, { budget: 20_000 });
    expect(r.cpu.instret).toBe(ref.cpu.instret);
    expect(r.machine.stats().mmioReads).toBe(ref.machine.stats().mmioReads);

    r.machine.uart.pushInputText('A');
    ref.machine.uart.pushInputText('A');
    r.machine.run(20_000);
    ref.machine.run(20_000);
    expect(r.cpu.stop).toBe('exit');
    expect(r.reg(7)).toBe(0x41);
    expect(r.reg(7), 'the byte must be read exactly once').toBe(ref.reg(7));
    expect(r.machine.stats().mmioReads).toBe(ref.machine.stats().mmioReads);
  });

  it('handles MMIO through the inline bounds check without trapping', () => {
    const POLL = `_start:
  li   a0, 0x10000000
  li   t0, 0
poll:
  lbu  t1, 5(a0)
  andi t1, t1, 1
  beqz t1, poll
  lbu  t2, 0(a0)
  ${EXIT_ASM}`;
    const r = run(POLL, {
      budget: 5_000,
      jit: { hotThreshold: 1, interpChunk: 8, config: { regalloc: 'globals', bounds: 'inline' } },
    });
    const s = r.machine.engine.stats;
    expect(s.wasmTraps).toBe(0);
    expect(s.slowPathFaults).toBeGreaterThan(0);
    r.machine.uart.pushInputText('B');
    r.machine.run(20_000);
    expect(r.cpu.stop).toBe('exit');
    expect(r.reg(7)).toBe(0x42);
  });

  it('flushes the code cache on fence.i so self-modifying code works', () => {
    // Patch an addi's immediate in flight: 1 -> 10. Both words differ only in
    // the immediate field, so the guest writes the new encoding directly.
    const addi1 = 0x00128293; // addi t0, t0, 1
    const addi10 = 0x00a28293; // addi t0, t0, 10
    const SELF = `_start:
  li   t1, 3
  li   t2, ${SCRATCH}
  sw   t2, 4(t2)
loop:
  addi t0, t0, 1
  addi t1, t1, -1
  bnez t1, loop
  la   a0, target
  li   a1, ${addi10}
  sw   a1, 0(a0)
  fence.i
  li   t0, 0
target:
  .word ${addi1}
  j    fin
fin:
  ${EXIT_ASM}`;
    const interp = runInterpreted(SELF);
    expect(interp.reg(5)).toBe(10);

    const jitted = run(SELF, { jit: { hotThreshold: 1, interpChunk: 4 } });
    expect(jitted.reg(5)).toBe(10);
    expect(jitted.machine.engine.stats.jitInstructions).toBeGreaterThan(0);
  });

  it('ends a block before a CSR so the host owns its exact semantics', () => {
    const CSR_LOOP = `_start:
  li   t0, 20
loop:
  addi t3, t3, 1
  csrr t1, minstret
  addi t0, t0, -1
  bnez t0, loop
  ${EXIT_ASM}`;
    const r = run(CSR_LOOP, { jit: { hotThreshold: 1, interpChunk: 4 } });
    const ref = runInterpreted(CSR_LOOP);
    const s = r.machine.engine.stats;
    expect(s.slowPathFaults).toBeGreaterThan(0); // the CSR ends the block before itself
    expect(s.jitInstructions).toBeGreaterThan(0); // the rest of the loop still compiles
    expect(r.cpu.stop).toBe('exit');
    expect(Array.from(r.cpu.regs)).toEqual(Array.from(ref.cpu.regs));
  });

  it('declines a hot pc whose block would be empty', () => {
    // A loop header that *is* the CSR has no translatable instruction before it,
    // so there is nothing to compile: the engine must decline the pc rather than
    // emit an empty region, and the program must still be correct.
    const CSR_FIRST = `_start:
  li   t0, 8
loop:
  csrr t1, minstret
  addi t0, t0, -1
  bnez t0, loop
  ${EXIT_ASM}`;
    const r = run(CSR_FIRST, { jit: { hotThreshold: 1, interpChunk: 4 } });
    const ref = runInterpreted(CSR_FIRST);
    expect(r.machine.engine.stats.declinedPcs).toBeGreaterThan(0);
    expect(r.cpu.stop).toBe('exit');
    expect(Array.from(r.cpu.regs)).toEqual(Array.from(ref.cpu.regs));
  });

  it('keeps a precise pc across a fault so the host can emulate MMIO', () => {
    const MMIO = `_start:
  li   a0, 0x0200bff8
  li   t0, 0
loop:
  lw   t1, 0(a0)
  addi t0, t0, 1
  li   t2, 5
  blt  t0, t2, loop
  ${EXIT_ASM}`;
    for (const bounds of ['trap', 'inline'] as const) {
      const r = run(MMIO, { jit: { hotThreshold: 1, interpChunk: 4, config: { bounds } } });
      expect(r.reg(5), bounds).toBe(5);
      expect(r.cpu.stop, bounds).toBe('exit');
    }
  });

  it('tail chaining and host chaining agree', () => {
    const CHAIN = `_start:
  li   a0, 0
  li   t0, 20
a:
  addi a0, a0, 1
  addi t0, t0, -1
  bnez t0, b
  j    fin
b:
  addi a0, a0, 2
  addi t0, t0, -1
  bnez t0, a
fin:
  ${EXIT_ASM}`;
    const ref = runInterpreted(CHAIN);
    const host = run(CHAIN, { jit: { hotThreshold: 1, interpChunk: 4, config: { chaining: 'host' } } });
    const tail = run(CHAIN, { jit: { hotThreshold: 1, interpChunk: 4, config: { chaining: 'tail' } } });
    expect(host.reg(10)).toBe(ref.reg(10));
    expect(tail.reg(10)).toBe(ref.reg(10));
    expect(tail.machine.engine.stats.jitInstructions).toBeGreaterThan(0);
  });

  it('is faster than the interpreter on a hot loop (the Spike A question)', () => {
    const BENCH = `_start:
  li   t0, 0
  li   t1, 400000
loop:
  add  t2, t2, t0
  xor  t3, t3, t2
  addi t0, t0, 1
  blt  t0, t1, loop
  ${EXIT_ASM}`;
    const interp = runInterpreted(BENCH, { budget: 2_000_000 });
    const jitted = run(BENCH, { budget: 2_000_000, jit: { hotThreshold: 8, interpChunk: 64 } });
    expect(jitted.reg(7)).toBe(interp.reg(7));
    const interpIps = interp.instructions / Math.max(interp.machine.stats().wallMs, 1e-9);
    const jitIps = jitted.instructions / Math.max(jitted.machine.stats().wallMs, 1e-9);
    // Recorded, not just asserted: this is the number the spike exists for.
    // eslint-disable-next-line no-console
    console.log(`[spike-a] interpreter ${(interpIps / 1e6).toFixed(1)} MIPS, jit ${(jitIps / 1e6).toFixed(1)} MIPS, speedup x${(jitIps / interpIps).toFixed(2)}`);
    expect(jitIps).toBeGreaterThan(interpIps);
  });
});

describe('machine-level integration', () => {
  it('runs the same program through Machine with and without the JIT', () => {
    const src = `_start:
  li   a0, 0
  li   t0, 500
loop:
  add  a0, a0, t0
  addi t0, t0, -1
  bnez t0, loop
  ${EXIT_ASM}`;
    const jit = run(src);
    const interp = run(src, { jit: false });
    expect(jit.reg(10)).toBe(interp.reg(10));
    expect(jit.cpu.stop).toBe('exit');
  });

  it('shares one register file across regions', () => {
    const r = run(CORPUS[7]![1], { jit: { hotThreshold: 1, interpChunk: 4 } });
    const ref = runInterpreted(CORPUS[7]![1]);
    expect(Array.from(r.cpu.regs)).toEqual(Array.from(ref.cpu.regs));
  });

  it('survives a shared-memory machine (the SMP prerequisite)', () => {
    const r = run(CORPUS[4]![1], { shared: true, jit: { hotThreshold: 1, interpChunk: 4 } });
    const ref = runInterpreted(CORPUS[4]![1]);
    expect(Array.from(r.cpu.regs)).toEqual(Array.from(ref.cpu.regs));
    expect(r.machine.engine.config.sharedAtomics).toBe(true);
  });

  it('writes guest console output through the UART', () => {
    const r = run(`_start:
  li   a0, 1
  la   a1, msg
  li   a2, 6
  li   a7, 64
  ecall
  j    fin
  .balign 4
msg:
  .string "hello\\n"
  .balign 4
fin:
  ${EXIT_ASM}`);
    expect(r.machine.uartSinkText).toContain('hello');
  });

  it('exposes a Machine that can be reset and re-run deterministically', () => {
    const sink = new StringUartSink();
    const m = new Machine({ ramBytes: RAM_BYTES, ramBase: RAM_BASE, uartSink: sink });
    const a = assemble(CORPUS[0]![1], { base: RAM_BASE });
    m.load(a.bytes, RAM_BASE);
    m.reset(a.entry, SCRATCH + 0x4000);
    m.run(200_000);
    const first = Array.from(m.cpu.regs);
    m.mem.u8.fill(0);
    m.load(a.bytes, RAM_BASE);
    m.reset(a.entry, SCRATCH + 0x4000);
    m.run(200_000);
    expect(Array.from(m.cpu.regs)).toEqual(first);
  });
});
