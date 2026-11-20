import { describe, expect, it } from 'vitest';
import { parseElf32, ElfError } from '../src/machine/elf.ts';
import { Machine } from '../src/machine/machine.ts';
import { runSmp } from '../src/smp/runtime.ts';
import { assemble } from '../src/cpu/asm.ts';

const BASE = 0x80000000;
function image(extra = false) {
  const program = assemble('li a0, 9\nli a7, 93\necall', { base: BASE + 4096 }).bytes;
  const elf = new Uint8Array(116 + program.length);
  const v = new DataView(elf.buffer);
  elf.set([0x7f, 0x45, 0x4c, 0x46, 1, 1, 1]);
  v.setUint16(16, 2, true);
  v.setUint16(18, 243, true);
  v.setUint32(20, 1, true);
  v.setUint32(24, BASE + 4096, true);
  v.setUint32(28, 52, true);
  v.setUint16(40, 52, true);
  v.setUint16(42, 32, true);
  v.setUint16(44, extra ? 2 : 1, true);
  v.setUint32(52, 1, true);
  v.setUint32(56, 116, true);
  v.setUint32(60, BASE + 4096, true);
  v.setUint32(68, program.length, true);
  v.setUint32(72, 4096, true);
  v.setUint32(76, 5, true);
  if (extra) {
    v.setUint32(84, 1, true);
    v.setUint32(92, BASE - 4096, true);
    v.setUint32(104, 4096, true);
  }
  elf.set(program, 116);
  return elf;
}

describe('ELF validation and hart entry', () => {
  it('loads static executable bytes, zeroes BSS and uses e_entry in actual SMP workers', async () => {
    const elf = image();
    const m = new Machine({ ramBytes: 65536 });
    m.mem.u8.fill(0xff);
    expect(m.load(elf)).toBe(BASE + 4096);
    expect(m.mem.u8[4096 + 20]).toBe(0);
    const run = await runSmp({
      harts: 2,
      program: elf,
      entry: BASE,
      stackTop: BASE + 65532,
      ramBytes: 65536,
      budget: 100,
    });
    expect(run.harts.map((hart) => [hart.stop, hart.exitCode])).toEqual([
      ['exit', 9],
      ['exit', 9],
    ]);
  });
  it('rejects all truncated headers with a typed ELF error', () => {
    for (let length = 4; length < 52; length++)
      expect(() => parseElf32(image().slice(0, length))).toThrow(ElfError);
  });
  it('rejects foreign ISA, unsupported version/type, invalid entry, alignment and wraparound', () => {
    const edits: Array<(v: DataView) => void> = [
      (v) => v.setUint16(18, 8, true),
      (v) => v.setUint16(16, 3, true),
      (v) => v.setUint32(20, 2, true),
      (v) => v.setUint16(40, 0, true),
      (v) => v.setUint32(36, 1, true),
      (v) => v.setUint32(24, BASE + 4097, true),
      (v) => v.setUint32(24, BASE, true),
      (v) => v.setUint32(76, 6, true),
      (v) => v.setUint32(80, 3, true),
      (v) => v.setUint32(80, 4096, true),
      (v) => v.setUint32(60, 0xfffffff0, true),
      (v) => v.setUint32(28, 0xffffffff, true),
    ];
    for (const edit of edits) {
      const elf = image();
      edit(new DataView(elf.buffer));
      expect(() => parseElf32(elf)).toThrow(ElfError);
    }
  });
  it('does not modify previously loaded memory when a later segment fails RAM validation', () => {
    const m = new Machine({ ramBytes: 65536 });
    m.mem.u8.fill(0x7b);
    expect(() => m.load(image(true))).toThrow('segment');
    expect(m.mem.u8.every((byte) => byte === 0x7b)).toBe(true);
  });
});
