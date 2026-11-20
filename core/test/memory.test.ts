import { describe, expect, it } from 'vitest';
import { GuestMemory } from '../src/machine/memory.ts';
import { Machine } from '../src/machine/machine.ts';

const BASE = 0x80000000;
const SIZE = 65536;

describe('guest physical memory bounds', () => {
  it('does not alias addresses wider than RV32, negative addresses, or fractional values', () => {
    const mem = new GuestMemory({ ramBytes: SIZE, ramBase: BASE });
    mem.writeU8(BASE, 0x5a);
    for (const addr of [BASE + 0x100000000, BASE - 0x100000000, BASE + 0.5, NaN, Infinity]) {
      expect(mem.ramOffset(addr)).toBe(-1);
      expect(mem.readU8(addr)).toBe(0);
      mem.writeU8(addr, 0xaa);
    }
    expect(mem.readU8(BASE)).toBe(0x5a);
  });

  it('rejects bulk reads and writes crossing RAM, without touching the control page', () => {
    const mem = new GuestMemory({ ramBytes: SIZE, ramBase: BASE, controlPage: true });
    mem.u8[SIZE] = 0x7b;
    mem.u8[SIZE - 1] = 0x12;
    expect(() => mem.readBytes(BASE + SIZE - 1, 2)).toThrow();
    expect(() => mem.readBytes(BASE, -1)).toThrow();
    expect(() => mem.readBytes(BASE, 0.5)).toThrow();
    expect(() => mem.writeBytes(BASE + SIZE - 1, new Uint8Array([1, 2]))).toThrow();
    expect(mem.u8[SIZE - 1]).toBe(0x12);
    expect(mem.u8[SIZE]).toBe(0x7b);
    expect(mem.readBytes(BASE + SIZE - 1, 1)).toEqual(new Uint8Array([0x12]));
  });

  it('does not access the control page through multi-byte physical accesses', () => {
    const mem = new GuestMemory({ ramBytes: SIZE, ramBase: BASE, controlPage: true });
    mem.u8.fill(0xa5, SIZE, SIZE + 4);
    expect(mem.readU16(BASE + SIZE - 1)).toBe(0);
    expect(mem.readU32(BASE + SIZE - 2)).toBe(0);
    expect(mem.fetch(BASE + SIZE - 2)).toBe(0);
    mem.writeU16(BASE + SIZE - 1, 0);
    mem.writeU32(BASE + SIZE - 2, 0);
    expect(Array.from(mem.u8.slice(SIZE, SIZE + 4))).toEqual([0xa5, 0xa5, 0xa5, 0xa5]);
  });

  it('rejects invalid RAM geometry and mismatched attached memory', () => {
    for (const opts of [
      { ramBytes: -1 },
      { ramBytes: NaN },
      { ramBytes: 1, ramBase: -1 },
      { ramBytes: SIZE * 2, ramBase: 0xffff0000 },
      { ramBytes: SIZE, ramBase: 0x100000000 },
    ])
      expect(() => new GuestMemory(opts)).toThrow();
    const shared = new WebAssembly.Memory({ initial: 1, maximum: 1, shared: true });
    const unshared = new WebAssembly.Memory({ initial: 1, maximum: 1 });
    expect(() => new GuestMemory({ ramBytes: SIZE, shared: false, memory: shared })).toThrow();
    expect(() => new GuestMemory({ ramBytes: SIZE, shared: true, memory: unshared })).toThrow();
  });
  it('rejects a flat image load address that would truncate to RAM', () => {
    const machine = new Machine({ ramBytes: SIZE });
    machine.mem.writeU8(BASE, 0x5a);
    expect(() => machine.load(new Uint8Array([0xcc]), BASE + 0x100000000)).toThrow();
    expect(machine.mem.readU8(BASE)).toBe(0x5a);
  });

  it('does not expose RAM via a negative or oversized control index', () => {
    const mem = new GuestMemory({ ramBytes: SIZE, ramBase: BASE, controlPage: true });
    mem.writeU32(BASE + SIZE - 4, 0x12345678);
    for (const i of [-1, SIZE / 4, 0.5, NaN]) {
      expect(() => mem.ctrlRead(i)).toThrow();
      expect(() => mem.ctrlWrite(i, 0)).toThrow();
    }
    expect(mem.readU32(BASE + SIZE - 4)).toBe(0x12345678);
  });
});
