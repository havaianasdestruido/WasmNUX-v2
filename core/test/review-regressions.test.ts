import { describe, expect, it } from 'vitest';
import { assemble } from '../src/cpu/asm.ts';
import { CpuState, CAUSE, CSR } from '../src/cpu/state.ts';
import { Interpreter, type MachinePort } from '../src/cpu/interp.ts';
import { GuestMemory } from '../src/machine/memory.ts';
import { Machine } from '../src/machine/machine.ts';
import { Clint, Plic } from '../src/devices/clint.ts';
import { Engine, JitCodeCache } from '../src/jit/engine.ts';
import { buildCfg } from '../src/jit/cfg.ts';
import { Mmu, PTE_A, PTE_D, PTE_R, PTE_V, PTE_W, PTE_X } from '../src/mmu/mmu.ts';
import { sv32Leaf } from '../src/mmu/tables.ts';

const BASE = 0x80000000;
function port(mem: GuestMemory): MachinePort {
  return {
    mem,
    onSyscall(cpu) {
      cpu.stop = 'exit';
    },
    onMMIORead: () => 0,
    onMMIOWrite() {},
    onIdle: () => false,
  };
}
function compiled(src: string, optimize = true): Machine {
  const image = assemble(src, { base: BASE });
  const m = new Machine({ ramBytes: 65536 });
  m.load(image.bytes, BASE);
  m.reset(BASE, BASE + 32768);
  expect(m.engine.compileAt(BASE, optimize)).not.toBeNull();
  return m;
}

describe('CodeRabbit correctness regressions', () => {
  it('preserves labels before and after alignment, including trailing padding', () => {
    const a = assemble('.byte 1\nbefore:\n.balign 4\nafter:\n.byte 2\n.balign 8\nend:');
    expect(a.labels.get('before')).toBe(1);
    expect(a.labels.get('after')).toBe(4);
    expect(a.labels.get('end')).toBe(8);
  });
  it('wraps absolute and PC-relative low relocations at the signed boundary', () => {
    const a = assemble('lui t0, %hi(TARGET)\naddi t0,t0,%lo(TARGET)', { defines: { TARGET: 0x7fffffff } });
    const m = new Machine({ ramBase: 0, ramBytes: 65536 });
    m.load(a.bytes, 0);
    m.reset(0);
    m.run(2);
    expect(m.cpu.reg(5) >>> 0).toBe(0x7fffffff);
    const b = assemble('la t0, TARGET', { base: BASE, defines: { TARGET: 0xffffffff } });
    const n = new Machine({ ramBytes: 65536 });
    n.load(b.bytes, BASE);
    n.reset(BASE);
    n.run(2);
    expect(n.cpu.reg(5) >>> 0).toBe(0xffffffff);
  });
  it('rejects displaced or unresolved atomic addressing', () => {
    for (const src of ['lr.w t0, 4(a0)', 'sc.w t0, t1, 4(a0)', 'amoadd.w t0, t1, label(a0)'])
      expect(() => assemble(src)).toThrow(/offset must be zero/);
    expect(assemble('lr.w t0, (a0)').bytes).toEqual(assemble('lr.w t0, 0(a0)').bytes);
  });
  it('rejects trap-based JIT with oversized attached memory', () => {
    const backing = new WebAssembly.Memory({ initial: 2, maximum: 2 });
    const mem = new GuestMemory({ ramBytes: 65536, memory: backing });
    expect(() => new Engine(port(mem), mem, { config: { bounds: 'trap' } })).toThrow(/exactly guest RAM/);
    expect(() => new Engine(port(mem), mem, { config: { bounds: 'inline' } })).not.toThrow();
    const growable = new WebAssembly.Memory({ initial: 1, maximum: 2 });
    const m = new GuestMemory({ ramBytes: 65536, memory: growable });
    const engine = new Engine(port(m), m, { config: { bounds: 'trap' } });
    growable.grow(1);
    expect(() => engine.run(new CpuState({ pc: BASE }), 1)).toThrow(/exactly guest RAM/);
    expect(() => engine.compileAt(BASE, false)).toThrow(/exactly guest RAM/);
  });
  it('keeps host retirement monotonic while the guest writes minstret', () => {
    for (const jit of [false, true]) {
      const src = assemble('nop\ncsrw minstret, zero\nnop\nnop\naddi t0,t0,1', { base: BASE });
      const m = new Machine({ ramBytes: 65536, jit });
      m.load(src.bytes);
      m.reset(BASE);
      if (jit) expect(m.engine.compileAt(BASE, false)).not.toBeNull();
      m.run(4);
      expect(m.cpu.instret).toBe(4);
      expect(m.cpu.cycles).toBe(4);
      expect(m.cpu.readCsr(CSR.minstret)).toBe(3);
      expect(m.cpu.reg(5)).toBe(0);
      expect(CpuState.fromJSON(m.cpu.toJSON()).readCsr(CSR.minstret)).toBe(3);
    }
  });
  it('does not perform MMIO for illegal load or store widths', () => {
    for (const instr of [0x0000b103, 0x0020b023]) {
      const mem = new GuestMemory({ ramBytes: 65536 });
      mem.view.setUint32(0, instr, true);
      let accesses = 0;
      const p = port(mem);
      p.onMMIORead = () => {
        accesses++;
        return 0;
      };
      p.onMMIOWrite = () => {
        accesses++;
      };
      const cpu = new CpuState({ pc: BASE });
      cpu.setReg(1, 0x100000);
      new Interpreter(p).step(cpu);
      expect(cpu.cause).toBe(CAUSE.ILLEGAL_INSTRUCTION);
      expect(cpu.tval >>> 0).toBe(instr);
      expect(accesses).toBe(0);
    }
  });
  it('does not translate only the first page of a crossing data access', () => {
    for (const source of ['lw t0, 0(t1)', 'sw t0, 0(t1)']) {
      const mem = new GuestMemory({ ramBytes: 65536 });
      mem.loadProgram(assemble(source).bytes, BASE);
      const p: MachinePort = { ...port(mem), mmuActive: true };
      p.translate = (kind, va) => ({ ok: true, pa: kind === 'fetch' ? va : BASE + 0xffe, tlbHit: false });
      const cpu = new CpuState({ pc: BASE });
      cpu.setReg(6, 0x4ffe);
      mem.writeU32(BASE + 0xffe, 0x12345678);
      new Interpreter(p).step(cpu);
      expect(cpu.cause).toBe(
        source.startsWith('lw') ? CAUSE.LOAD_ADDRESS_MISALIGNED : CAUSE.STORE_ADDRESS_MISALIGNED,
      );
      expect(cpu.instret).toBe(0);
      expect(mem.readU32(BASE + 0xffe)).toBe(0x12345678);
    }
  });
  it('checks control transfer alignment before link or retirement', () => {
    for (const source of ['.word 0x002000ef', 'jalr ra, 2(zero)', '.word 0x00000163']) {
      const a = assemble(source, { base: BASE });
      const m = new Machine({ ramBytes: 65536, jit: false });
      m.load(a.bytes);
      m.reset(BASE);
      m.cpu.setReg(1, 123);
      m.step();
      expect(m.cpu.cause, source).toBe(CAUSE.INSTRUCTION_ADDRESS_MISALIGNED);
      expect(m.cpu.instret, source).toBe(0);
      expect(m.cpu.reg(1), source).toBe(123);
      expect(m.cpu.pc, source).toBe(BASE);
    }
  });
  it('invalidates all cached pages belonging to an address-specific superpage', () => {
    const ptes = new Map<number, bigint>();
    const root = BASE + 0x1000;
    const va = 0xc0000000;
    const slot = root + (va >>> 22) * 4;
    ptes.set(slot, BigInt(sv32Leaf(BASE >>> 12, PTE_V | PTE_R | PTE_A)));
    const mmu = new Mmu({ readPte: (pa) => ptes.get(pa) ?? null });
    mmu.privilege = 1;
    mmu.setSatp(BigInt((0x80000000 | (root >>> 12)) >>> 0));
    expect(mmu.translate(va, 'load').ok).toBe(true);
    expect(mmu.translate(va + 0x1000, 'load').ok).toBe(true);
    ptes.delete(slot);
    mmu.invalidateVpn(va);
    expect(mmu.translate(va + 0x1000, 'load').ok).toBe(false);
  });
  it('uses unsigned timer comparisons and one clock origin', () => {
    let now = 1_000_000n;
    const pending: boolean[] = [];
    const c = new Clint({ now: () => now, onTimerPending: (_h, p) => pending.push(p) });
    expect(c.time).toBe(0n);
    expect(c.timerInterruptPending(0)).toBe(false);
    c.setCompare(0, 5n);
    now += 400n;
    c.tick(now);
    expect(c.time).toBe(4n);
    expect(c.timerInterruptPending(0)).toBe(false);
    now += 100n;
    c.tick(now);
    expect(c.timerInterruptPending(0)).toBe(true);
    c.setCompare(0, -1n);
    expect(c.timerInterruptPending(0)).toBe(false);
    expect(pending.at(-1)).toBe(false);
  });
  it('separates PLIC enable contexts, threshold, and claim', () => {
    const p = new Plic(1, 32);
    p.write(4, 4, 3);
    p.write(0x2080, 4, 2);
    p.raise(1, true);
    expect(p.read(0x200000, 4)).toBe(0);
    expect(p.bestFor(1)).toBe(1);
    p.write(0x201000, 4, 2);
    expect(p.read(0x201000, 4)).toBe(2);
    expect(p.bestFor(1)).toBe(1);
    expect(p.read(0x201008, 4)).toBe(0);
    expect(p.bestFor(1)).toBe(1);
    expect(p.read(0x201004, 4)).toBe(1);
  });
  it('keeps x0 constant and folds registers as signed i32', () => {
    const m = compiled(
      'addi zero,zero,5\naddi t0,zero,-1\nsrli t1,t0,0\nslti t2,t1,0\naddi t3,zero,1\necall',
    );
    m.run(100);
    expect(m.cpu.reg(7)).toBe(1);
    expect(m.cpu.reg(28)).toBe(1);
    expect(m.engine.stats.jitInstructions).toBeGreaterThan(0);
  });
  it('does not execute a compiled block beyond a one-instruction budget', () => {
    for (const mode of ['loop', 'block'] as const) {
      const src = assemble('addi t0,t0,1\naddi t0,t0,1\naddi t0,t0,1\necall', { base: BASE });
      const m = new Machine({ ramBytes: 65536, jit: { config: { budgetCheck: mode } } });
      m.load(src.bytes);
      m.reset(BASE);
      m.engine.compileAt(BASE, false);
      m.run(1);
      expect(m.cpu.reg(5)).toBe(1);
      expect(m.cpu.instret).toBe(1);
      expect(m.cpu.pc).toBe(BASE + 4);
    }
  });
  it('removes every cache tier for an invalidated PC', () => {
    const record = (pc: number, optimized: boolean) => ({ pc, optimized, blocks: [pc], bytes: [] });
    const c = new JitCodeCache('x', 'x', [record(BASE, false), record(BASE, true), record(BASE + 4, false)]);
    c.remove(BASE);
    expect(c.lookup(BASE, true)).toBeUndefined();
    expect(c.records).toHaveLength(1);
    expect(c.lookup(BASE + 4, false)).toBeDefined();
  });
  it('does not truncate a block for a misaligned target or create overlapping blocks', () => {
    const mem = new GuestMemory({ ramBytes: 65536 });
    const a = assemble('addi t0,zero,1\n.word 0x00000163\necall', { base: BASE });
    mem.loadProgram(a.bytes, BASE);
    const cfg = buildCfg(mem, BASE);
    expect(cfg.get(BASE)?.words.length).toBe(1);
    const b = assemble('beq zero,zero,target\naddi t0,t0,1\ntarget:\naddi t1,t1,1\necall', { base: BASE });
    mem.loadProgram(b.bytes, BASE);
    const blocks = [...buildCfg(mem, BASE).values()];
    const pcs = blocks.flatMap((block) => block.words.map((_, i) => block.start + i * 4));
    expect(new Set(pcs).size).toBe(pcs.length);
  });
  it('uses a load translation for LR on a read-only page', () => {
    const mem = new GuestMemory({ ramBytes: 65536 });
    mem.loadProgram(assemble('lr.w t0, (t1)').bytes, BASE);
    mem.writeU32(BASE + 0x100, 42);
    const p: MachinePort = {
      ...port(mem),
      mmuActive: true,
      translate: (kind, va) =>
        kind === 'fetch'
          ? { ok: true, pa: va, tlbHit: false }
          : kind === 'load'
            ? { ok: true, pa: BASE + 0x100, tlbHit: false }
            : { ok: false, cause: 15, tval: va },
    };
    const cpu = new CpuState({ pc: BASE });
    cpu.setReg(6, 0x4000);
    new Interpreter(p).step(cpu);
    expect(cpu.reg(5)).toBe(42);
    expect(cpu.instret).toBe(1);
  });

  it('records the old address for aliased LR and traps misaligned compiled atomics', () => {
    for (const optimize of [false, true]) {
      const a = compiled('lr.w t0, (t0)\nsc.w t1,t2,(t0)\necall', optimize);
      const first = BASE + 0x100;
      const second = BASE + 0x200;
      a.mem.writeU32(first, second);
      a.mem.writeU32(second, second);
      a.cpu.setReg(5, first);
      a.cpu.setReg(7, 17);
      a.run(100);
      expect(a.cpu.reg(6)).toBe(1);
      expect(a.mem.readU32(second)).toBe(second);
      const b = compiled('lr.w t0, (t1)\necall', optimize);
      b.cpu.setReg(6, BASE + 0x102);
      b.run(100);
      expect(b.cpu.stop).toBe('trap');
      expect(b.cpu.cause).toBe(CAUSE.STORE_ADDRESS_MISALIGNED);
      expect(b.cpu.instret).toBe(0);
    }
  });

  it('rounds ELF heap placement above a high-address loaded segment', () => {
    const elf = new Uint8Array(85);
    const v = new DataView(elf.buffer);
    elf.set([0x7f, 0x45, 0x4c, 0x46, 1, 1]);
    v.setUint16(18, 243, true);
    v.setUint32(24, BASE + 0x2000, true);
    v.setUint32(28, 52, true);
    v.setUint16(42, 32, true);
    v.setUint16(44, 1, true);
    v.setUint32(52, 1, true);
    v.setUint32(56, 84, true);
    v.setUint32(60, BASE + 0x2000, true);
    v.setUint32(68, 1, true);
    v.setUint32(72, 1, true);
    elf[84] = 0x42;
    const m = new Machine({ ramBytes: 65536 });
    m.load(elf);
    m.reset();
    expect(m.mem.readU8(BASE + 0x2000)).toBe(0x42);
    expect(m.cpu.reg(2) >>> 0).toBe(BASE + 0x3000);
  });

  it('invalidates a target actually executed from compiled code before fence.i', () => {
    const src = assemble(
      `_start:
      la a0,target
      li a1,0x00a28293
      sw a1,0(a0)
      fence.i
      li t0,0
      jal ra,target
      li a7,93
      ecall
    target:
      addi t0,t0,1
      ret
    preexit:
      ebreak`,
      { base: BASE },
    );
    const m = new Machine({ ramBytes: 65536 });
    m.load(src.bytes);
    m.reset(BASE);
    const target = src.labels.get('target')!;
    expect(m.engine.compileAt(target, false)).not.toBeNull();
    m.cpu.pc = target;
    m.cpu.setReg(1, src.labels.get('preexit')!);
    m.run(10);
    expect(m.cpu.reg(5)).toBe(1);
    expect(m.engine.stats.jitInstructions).toBeGreaterThan(0);
    m.cpu.pc = BASE;
    m.cpu.stop = 'running';
    m.run(1000);
    expect(m.cpu.stop).toBe('exit');
    expect(m.cpu.reg(5)).toBe(10);
  });
  it('keeps the link register intact when a compiled JALR target is misaligned', () => {
    for (const optimize of [false, true]) {
      const m = compiled('jalr ra,0(t0)\necall', optimize);
      m.cpu.setReg(5, BASE + 2);
      m.cpu.setReg(1, 123);
      m.run(100);
      expect(m.cpu.cause).toBe(CAUSE.INSTRUCTION_ADDRESS_MISALIGNED);
      expect(m.cpu.reg(1)).toBe(123);
      expect(m.cpu.instret).toBe(0);
    }
  });

  it('does not split a preceding block at a misaligned backward branch target', () => {
    // beq x0,x0,-6 at BASE+8 targets BASE+2, which is not an instruction boundary.
    const mem = new GuestMemory({ ramBytes: 65536 });
    mem.view.setUint32(0, 0x00128293, true);
    mem.view.setUint32(4, 0x00130313, true);
    const imm = -6 & 0x1fff;
    const branch =
      (((imm >>> 12) & 1) << 31) |
      (((imm >>> 5) & 0x3f) << 25) |
      (((imm >>> 1) & 0xf) << 8) |
      (((imm >>> 11) & 1) << 7) |
      0x63;
    mem.view.setUint32(8, branch >>> 0, true);
    const cfg = buildCfg(mem, BASE);
    expect(cfg.get(BASE)?.words.length).toBe(2);
    expect(cfg.has(BASE + 2)).toBe(false);
  });
  it('records the origin and target of a misaligned transfer in machine trap CSRs', () => {
    const src = assemble('jalr ra, 2(zero)', { base: BASE });
    const m = new Machine({ ramBytes: 65536, jit: false });
    m.load(src.bytes);
    m.reset(BASE);
    m.cpu.writeCsr(CSR.mtvec, BASE + 0x100);
    m.cpu.setReg(1, 123);
    m.step();
    expect(m.cpu.readCsr(CSR.mepc) >>> 0).toBe(BASE);
    expect(m.cpu.readCsr(CSR.mtval) >>> 0).toBe(2);
    expect(m.cpu.reg(1)).toBe(123);
    expect(m.cpu.instret).toBe(0);
  });
});
