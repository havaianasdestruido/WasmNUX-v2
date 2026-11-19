/**
 * The encoder is the foundation of Spike A: if it emits a wrong byte the JIT
 * silently miscompiles guest code, so every opcode family the translator uses is
 * exercised here by *instantiating and running* the emitted module.
 */
import { describe, expect, it } from 'vitest';

import { Buf, WasmModuleBuilder, compileModuleSync, createFuncTable } from '../src/jit/wasm/encoder.ts';
import { measureAtomicsMicro, probeWasmFeatures } from '../src/jit/wasm/features.ts';

describe('Buf / LEB128', () => {
  it('encodes unsigned LEB128', () => {
    expect(Array.from(new Buf(8).uleb(0).finish())).toEqual([0]);
    expect(Array.from(new Buf(8).uleb(127).finish())).toEqual([127]);
    expect(Array.from(new Buf(8).uleb(128).finish())).toEqual([0x80, 0x01]);
    expect(Array.from(new Buf(8).uleb(624485).finish())).toEqual([0xe5, 0x8e, 0x26]);
  });

  it('encodes signed LEB128', () => {
    expect(Array.from(new Buf(8).sleb(63).finish())).toEqual([0x3f]);
    expect(Array.from(new Buf(8).sleb(64).finish())).toEqual([0xc0, 0x00]);
    expect(Array.from(new Buf(8).sleb(-1).finish())).toEqual([0x7f]);
    expect(Array.from(new Buf(8).sleb(-64).finish())).toEqual([0x40]);
    expect(Array.from(new Buf(8).sleb(-65).finish())).toEqual([0xbf, 0x7f]);
    expect(Array.from(new Buf(8).sleb(-2048).finish())).toEqual([0x80, 0x70]);
  });

  it('encodes signed 64-bit LEB128', () => {
    expect(Array.from(new Buf(16).sleb64(-1n).finish())).toEqual([0x7f]);
    expect(Array.from(new Buf(16).sleb64(1n << 40n).finish())).toEqual([0x80, 0x80, 0x80, 0x80, 0x80, 0x20]);
  });

  it('grows past its initial capacity', () => {
    const b = new Buf(4);
    for (let i = 0; i < 1000; i++) b.u8(i & 0xff);
    expect(b.length).toBe(1000);
    expect(b.finish()[999]).toBe(999 & 0xff);
  });

  it('writes names as length-prefixed UTF-8', () => {
    expect(Array.from(new Buf(16).name('ab').finish())).toEqual([2, 0x61, 0x62]);
  });
});

describe('module builder', () => {
  it('compiles and runs a two-argument add', () => {
    const b = new WasmModuleBuilder();
    const f = b.addFunc('add', ['i32', 'i32'], ['i32']);
    f.localGet(0).localGet(1).i32Add();
    b.exportFunc('add', 0);
    const inst = compileModuleSync(b.build());
    const add = inst.exports['add'] as (a: number, c: number) => number;
    expect(add(2, 3)).toBe(5);
    expect(add(-1, -1)).toBe(-2);
  });

  it('deduplicates identical type entries', () => {
    const b = new WasmModuleBuilder();
    const t1 = b.addType(['i32'], ['i32']);
    const t2 = b.addType(['i32'], ['i32']);
    const t3 = b.addType(['i32', 'i32'], []);
    expect(t1).toBe(t2);
    expect(t3).toBe(t1 + 1);
  });

  it('runs a counted loop and keeps locals across iterations', () => {
    const b = new WasmModuleBuilder();
    // sum(n) = 1 + 2 + ... + n
    const f = b.addFunc('sum', ['i32'], ['i32']);
    const acc = f.addLocals(1, 'i32');
    f.i32(0).localSet(acc);
    f.block('void');
    f.loop('void');
    f.localGet(0).i32Eqz().brIf(1); // n == 0 -> leave block
    f.localGet(acc).localGet(0).i32Add().localSet(acc);
    f.localGet(0).i32(1).i32Sub().localSet(0);
    f.br(0);
    f.end(); // loop
    f.end(); // block
    f.localGet(acc);
    b.exportFunc('sum', 0);
    const inst = compileModuleSync(b.build());
    const sum = inst.exports['sum'] as (n: number) => number;
    expect(sum(100)).toBe(5050);
    expect(sum(0)).toBe(0);
    expect(sum(1)).toBe(1);
  });

  it('dispatches through br_table like a compiled region', () => {
    const b = new WasmModuleBuilder();
    const f = b.addFunc('dispatch', ['i32'], ['i32']);
    f.block('void'); // exit
    f.block('void'); // case 2
    f.block('void'); // case 1
    f.block('void'); // case 0
    f.localGet(0).brTable([0, 1, 2], 3);
    f.end(); // -> case 0 body
    f.i32(10).ret();
    f.end(); // -> case 1 body
    f.i32(20).ret();
    f.end(); // -> case 2 body
    f.i32(30).ret();
    f.end(); // -> default body
    f.i32(-1);
    b.exportFunc('dispatch', 0);
    const inst = compileModuleSync(b.build());
    const d = inst.exports['dispatch'] as (i: number) => number;
    expect([d(0), d(1), d(2), d(3), d(99)]).toEqual([10, 20, 30, -1, -1]);
  });

  it('supports declared memory, data segments and 32/16/8-bit accesses', () => {
    const b = new WasmModuleBuilder();
    b.addMemory({ min: 1, max: 2 });
    b.addData(new Uint8Array([0x78, 0x56, 0x34, 0x12]), (e) => e.i32(16));
    const load32 = b.addFunc('load32', ['i32'], ['i32']);
    load32.localGet(0).i32Load();
    const load16u = b.addFunc('load16u', ['i32'], ['i32']);
    load16u.localGet(0).i32Load16u();
    const load8s = b.addFunc('load8s', ['i32'], ['i32']);
    load8s.localGet(0).i32Load8s();
    const store = b.addFunc('store', ['i32', 'i32'], []);
    store.localGet(0).localGet(1).i32Store();
    b.exportFunc('load32', 0);
    b.exportFunc('load16u', 1);
    b.exportFunc('load8s', 2);
    b.exportFunc('store', 3);
    b.exportMemory('memory');

    const inst = compileModuleSync(b.build());
    const ex = inst.exports as Record<string, unknown>;
    expect((ex['load32'] as (a: number) => number)(16)).toBe(0x12345678);
    expect((ex['load16u'] as (a: number) => number)(18)).toBe(0x1234);
    expect((ex['load8s'] as (a: number) => number)(19)).toBe(0x12);
    (ex['store'] as (a: number, v: number) => void)(32, -1);
    expect((ex['load32'] as (a: number) => number)(32)).toBe(-1);
    expect((ex['memory'] as WebAssembly.Memory).buffer.byteLength).toBe(65536);
  });

  it('traps on out-of-bounds access instead of corrupting memory', () => {
    const b = new WasmModuleBuilder();
    b.addMemory({ min: 1 });
    const f = b.addFunc('oob', ['i32'], ['i32']);
    f.localGet(0).i32Load();
    b.exportFunc('oob', 0);
    const inst = compileModuleSync(b.build());
    const oob = inst.exports['oob'] as (a: number) => number;
    expect(() => oob(1 << 20)).toThrow(WebAssembly.RuntimeError);
    expect(oob(65532)).toBe(0);
  });

  it('shares one imported memory across two instances (Spike B prerequisite)', () => {
    const mem = new WebAssembly.Memory({ initial: 1, maximum: 4, shared: true });
    const build = () => {
      const b = new WasmModuleBuilder();
      b.importMemory('env', 'mem', { min: 1, max: 4, shared: true });
      // inc(p): *p += 1; return *p
      const inc = b.addFunc('inc', ['i32'], ['i32']);
      inc.localGet(0).localGet(0).i32Load().i32(1).i32Add().i32Store();
      inc.localGet(0).i32Load();
      b.exportFunc('inc', 0);
      return compileModuleSync(b.build(), { env: { mem } });
    };
    const a = build();
    const c = build();
    const incA = a.exports['inc'] as (p: number) => number;
    const incC = c.exports['inc'] as (p: number) => number;
    expect(incA(0)).toBe(1);
    expect(incC(0)).toBe(2);
    expect(incA(0)).toBe(3);
    expect(new Int32Array(mem.buffer)[0]).toBe(3);
  });

  it('executes atomic RMW, cmpxchg and wait32 on shared memory', () => {
    const mem = new WebAssembly.Memory({ initial: 1, maximum: 1, shared: true });
    const b = new WasmModuleBuilder();
    b.importMemory('env', 'mem', { min: 1, max: 1, shared: true });

    const add = b.addFunc('atomicAdd', ['i32', 'i32'], ['i32']);
    add.localGet(0).localGet(1).i32AtomicAdd();

    const cas = b.addFunc('cas', ['i32', 'i32', 'i32'], ['i32']);
    cas.localGet(0).localGet(1).localGet(2).i32AtomicCmpxchg();

    const wait = b.addFunc('wait', ['i32', 'i32'], ['i32']);
    wait.localGet(0).localGet(1).i64(0n).memoryAtomicWait32();

    const notify = b.addFunc('notify', ['i32', 'i32'], ['i32']);
    notify.localGet(0).localGet(1).memoryAtomicNotify();

    const fence = b.addFunc('fence', [], []);
    fence.atomicFence();

    b.exportFunc('atomicAdd', 0);
    b.exportFunc('cas', 1);
    b.exportFunc('wait', 2);
    b.exportFunc('notify', 3);
    b.exportFunc('fence', 4);
    const inst = compileModuleSync(b.build(), { env: { mem } });
    const ex = inst.exports as Record<string, ((...a: number[]) => number) | undefined>;

    const i32 = new Int32Array(mem.buffer);
    Atomics.store(i32, 0, 10);
    expect(ex['atomicAdd']!(0, 5)).toBe(10); // returns the old value
    expect(Atomics.load(i32, 0)).toBe(15);
    expect(ex['cas']!(0, 15, 42)).toBe(15);
    expect(Atomics.load(i32, 0)).toBe(42);
    expect(ex['cas']!(0, 15, 43)).toBe(42); // failed CAS leaves the value alone
    expect(Atomics.load(i32, 0)).toBe(42);
    // wait32 with a mismatched expected value returns 1 ("not equal") immediately;
    // 0 would mean "woken", 2 would mean "timed out".
    expect(ex['wait']!(0, 7)).toBe(1);
    expect(ex['notify']!(0, 1)).toBe(0);
    ex['fence']!();
  });

  it('keeps imported mutable globals alive across calls (the JIT register file)', () => {
    const g = new WebAssembly.Global({ value: 'i32', mutable: true }, 1);
    const h = new WebAssembly.Global({ value: 'i32', mutable: true }, 100);
    const build = (name: string) => {
      const b = new WasmModuleBuilder();
      b.importGlobal('env', 'x', 'i32', true);
      b.importGlobal('env', 'y', 'i32', true);
      const f = b.addFunc(name, [], ['i32']);
      f.globalGet(0).globalGet(1).i32Add().globalSet(0);
      f.globalGet(0);
      b.exportFunc(name, 0);
      return compileModuleSync(b.build(), { env: { x: g, y: h } });
    };
    const m1 = build('step1');
    const m2 = build('step2');
    const s1 = m1.exports['step1'] as () => number;
    const s2 = m2.exports['step2'] as () => number;
    expect(s1()).toBe(101);
    // A second module instance sees the same register file.
    expect(s2()).toBe(201);
    expect(g.value as number).toBe(201);
  });

  it('supports SIMD v128 load/store/add when available', () => {
    const features = probeWasmFeatures();
    const b = new WasmModuleBuilder();
    b.addMemory({ min: 1 });
    const f = b.addFunc('addv', ['i32', 'i32', 'i32'], []);
    f.localGet(2).localGet(0).v128Load().localGet(1).v128Load().i32x4Add().v128Store();
    b.exportFunc('addv', 0);
    b.exportMemory('memory');
    const bytes = b.build();
    if (!features.simd) {
      expect(WebAssembly.validate(bytes)).toBe(false);
      return;
    }
    const inst = compileModuleSync(bytes);
    const mem = inst.exports['memory'] as WebAssembly.Memory;
    const u32 = new Uint32Array(mem.buffer);
    u32.set([1, 2, 3, 4], 0);
    u32.set([10, 20, 30, 40], 4);
    (inst.exports['addv'] as (a: number, c: number, d: number) => void)(0, 16, 32);
    expect(Array.from(u32.subarray(8, 12))).toEqual([11, 22, 33, 44]);
  });

  it('supports bulk memory copy and fill', () => {
    const b = new WasmModuleBuilder();
    b.addMemory({ min: 1 });
    const copy = b.addFunc('copy', ['i32', 'i32', 'i32'], []);
    copy.localGet(0).localGet(1).localGet(2).memoryCopy();
    const fill = b.addFunc('fill', ['i32', 'i32', 'i32'], []);
    fill.localGet(0).localGet(1).localGet(2).memoryFill();
    b.exportFunc('copy', 0);
    b.exportFunc('fill', 1);
    b.exportMemory('memory');
    const inst = compileModuleSync(b.build());
    const u8 = new Uint8Array((inst.exports['memory'] as WebAssembly.Memory).buffer);
    u8.set([9, 8, 7, 6], 0);
    (inst.exports['copy'] as (d: number, s: number, n: number) => void)(100, 0, 4);
    expect(Array.from(u8.subarray(100, 104))).toEqual([9, 8, 7, 6]);
    (inst.exports['fill'] as (d: number, v: number, n: number) => void)(200, 0xab, 3);
    expect(Array.from(u8.subarray(200, 203))).toEqual([0xab, 0xab, 0xab]);
  });

  it('rejects malformed modules at validation time', () => {
    const b = new WasmModuleBuilder();
    const f = b.addFunc('bad', [], ['i32']);
    f.i64(1n); // returns i64 where i32 is declared
    b.exportFunc('bad', 0);
    expect(WebAssembly.validate(b.build())).toBe(false);
    expect(() => compileModuleSync(b.build())).toThrow();
  });
});

describe('tail calls (ADR-0003 region chaining)', () => {
  it('self-tail-calls a million times without growing the stack', () => {
    const features = probeWasmFeatures();
    if (!features.tailCalls) return; // reported in the spike doc instead
    const b = new WasmModuleBuilder();
    const f = b.addFunc('countdown', ['i32'], ['i32']);
    f.localGet(0).i32Eqz().if('i32');
    f.i32(0);
    f.else();
    f.localGet(0).i32(1).i32Sub().returnCall(0);
    f.end();
    b.exportFunc('countdown', 0);
    const inst = compileModuleSync(b.build());
    const countdown = inst.exports['countdown'] as (n: number) => number;
    expect(countdown(1_000_000)).toBe(0);
  });

  it('chains across module instances through an imported table', () => {
    const features = probeWasmFeatures();
    if (!features.tailCalls) return;
    const table = createFuncTable(4);
    const make = (delta: number) => {
      const b = new WasmModuleBuilder();
      b.importTable('env', 'table', 4);
      const t = b.addType(['i32'], ['i32']);
      const f = b.addFunc('hop', ['i32'], ['i32']);
      // if (n == 0) return delta; else return_call_indirect table[n & 3](n - 1)
      f.localGet(0).i32Eqz().if('i32');
      f.i32(delta);
      f.else();
      f.localGet(0).i32(1).i32Sub().localSet(0);
      f.localGet(0);
      f.localGet(0).i32(3).i32And();
      f.returnCallIndirect(t, 0);
      f.end();
      b.exportFunc('hop', 0);
      return compileModuleSync(b.build(), { env: { table } });
    };
    for (let i = 0; i < 4; i++) {
      table.set(i, make(i + 1).exports['hop'] as unknown as (n: number) => number);
    }
    const hop = table.get(0) as unknown as (n: number) => number;
    // Walks 0 -> 3 -> 2 -> 1 -> 0 ... and stops when n reaches 0.
    expect(hop(0)).toBe(1);
    expect(hop(4)).toBe(1);
    expect(hop(100_000)).toBe(1);
  });
});

describe('feature probes', () => {
  it('reports a coherent feature set for this runtime', () => {
    const f = probeWasmFeatures();
    expect(typeof f.threads).toBe('boolean');
    expect(f.simd).toBe(true); // mandatory in every Tier-1/2 browser and in Node >= 16
    expect(f.bulkMemory).toBe(true);
    expect(f.maxMemory32Pages).toBeGreaterThan(0);
    expect(f.hardwareConcurrency).toBeGreaterThanOrEqual(1);
    expect(f.isNode).toBe(true);
    if (f.threads) {
      expect(f.atomics).toBe(true);
      expect(f.atomicWait).toBe(true);
      expect(f.sharedMemoryGrowable).toBe(true);
    }
  });

  it('measures atomics micro-costs without producing nonsense', () => {
    const m = measureAtomicsMicro(200_000);
    expect(m.iterations).toBe(200_000);
    for (const v of [m.atomicsAddNs, m.atomicsCmpxchgNs, m.wasmAtomicAddNs, m.wasmPlainStoreNs]) {
      expect(Number.isFinite(v)).toBe(true);
      expect(v).toBeGreaterThan(0);
      expect(v).toBeLessThan(10_000);
    }
  });
});
