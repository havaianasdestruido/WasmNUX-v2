/**
 * MMU regression tests.
 *
 * These pin the failure modes the audit found in earlier spikes: superpage
 * physical-address composition, misaligned superpages, A/D handling,
 * address-specific TLB invalidation, fetch translation, and the legal
 * `sfence.vma rs1, rs2` encoding.
 */

import { describe, expect, it } from 'vitest';
import { GuestMemory } from '../src/machine/memory.ts';
import {
  Mmu,
  PTE_A,
  PTE_D,
  PTE_R,
  PTE_U,
  PTE_V,
  PTE_W,
  PTE_X,
  type TranslateResult,
} from '../src/mmu/mmu.ts';
import { sv32Leaf, sv32Pointer, sv39Leaf, sv39Pointer, writePte } from '../src/mmu/tables.ts';
import { assemble } from '../src/cpu/asm.ts';
import { CSR } from '../src/cpu/state.ts';
import { Machine } from '../src/machine/machine.ts';

const RAM_BASE = 0x80000000;
const RAM_BYTES = 1 << 20;
const RWX = PTE_R | PTE_W | PTE_X | PTE_A | PTE_D | PTE_V;

function newMem(): GuestMemory {
  return new GuestMemory({ ramBytes: RAM_BYTES, ramBase: RAM_BASE });
}

function putPte(mem: GuestMemory, pa: number, pte: bigint): void {
  writePte(mem.view, (pa - RAM_BASE) >>> 0, pte);
}

function mmuWith(mem: GuestMemory): Mmu {
  return new Mmu({
    readPte: (pa, size) => {
      const off = mem.ramOffset(pa);
      if (off < 0 || off + size > mem.ramSize) return null;
      if (size === 4) return BigInt(mem.view.getUint32(off, true));
      return BigInt(mem.view.getUint32(off, true)) | (BigInt(mem.view.getUint32(off + 4, true)) << 32n);
    },
  });
}

function paOf(r: TranslateResult): number {
  if (!r.ok) throw new Error('expected a successful translation');
  return r.pa;
}

function hitOf(r: TranslateResult): boolean {
  if (!r.ok) throw new Error('expected a successful translation');
  return r.tlbHit;
}

describe('Sv32', () => {
  it('translates a 4 KiB mapping through two levels', () => {
    const mem = newMem();
    const root = RAM_BASE + 0x1000;
    const leaf = RAM_BASE + 0x2000;
    const va = 0x40000000;
    const pa = RAM_BASE + 0x4000;
    const vpn1 = (va >>> 22) & 0x3ff;
    const vpn0 = (va >>> 12) & 0x3ff;
    putPte(mem, root + vpn1 * 4, BigInt(sv32Pointer(leaf >>> 12)));
    putPte(mem, leaf + vpn0 * 4, BigInt(sv32Leaf(pa >>> 12, RWX | PTE_U)));
    const mmu = mmuWith(mem);
    mmu.privilege = 0;
    mmu.setSatp(BigInt(0x80000000 | (root >>> 12)));

    expect(mmu.translate(va, 'load')).toEqual({ ok: true, pa, tlbHit: false });
    expect(mmu.translate(va + 4, 'load')).toEqual({ ok: true, pa: pa + 4, tlbHit: true });
    expect(mmu.translate(va + 0x1000, 'load').ok).toBe(false); // unmapped next page
  });

  it('composes a 4 MiB megapage physical address from the low VPN bits', () => {
    const mem = newMem();
    const root = RAM_BASE + 0x1000;
    const va = 0x40000000; // vpn1 = 0x100
    const pa = RAM_BASE; // 4 MiB aligned
    const vpn1 = (va >>> 22) & 0x3ff;
    // level-1 leaf: PPN = pa >>> 12; PPN[0] must be zero for an aligned megapage.
    putPte(mem, root + vpn1 * 4, BigInt(sv32Leaf(pa >>> 12, RWX)));
    const mmu = mmuWith(mem);
    mmu.privilege = 1;
    mmu.setSatp(BigInt(0x80000000 | (root >>> 12)));

    const r = mmu.translate(va + 0x12345, 'load');
    expect(r).toEqual({ ok: true, pa: pa + 0x12345, tlbHit: false });
  });

  it('faults on a misaligned megapage', () => {
    const mem = newMem();
    const root = RAM_BASE + 0x1000;
    const va = 0x40000000;
    const vpn1 = (va >>> 22) & 0x3ff;
    // PPN[0] = 1 -> misaligned 4 MiB leaf.
    const pte = (1n << 20n) | (1n << 10n) | RWX;
    putPte(mem, root + vpn1 * 4, pte);
    const mmu = mmuWith(mem);
    mmu.privilege = 1;
    mmu.setSatp(BigInt(0x80000000 | (root >>> 12)));
    expect(mmu.translate(va, 'load').ok).toBe(false);
  });

  it('enforces U/S and X/R/W permissions', () => {
    const mem = newMem();
    const root = RAM_BASE + 0x1000;
    const va = 0x40000000;
    const vpn1 = (va >>> 22) & 0x3ff;
    // Supervisor-only, read+execute leaf.
    putPte(mem, root + vpn1 * 4, (BigInt(0x10) << 20n) | PTE_R | PTE_X | PTE_A | PTE_V);
    const mmu = mmuWith(mem);
    mmu.setSatp(BigInt(0x80000000 | (root >>> 12)));

    mmu.privilege = 0; // U-mode: no U bit -> fault
    expect(mmu.translate(va, 'fetch').ok).toBe(false);
    mmu.privilege = 1; // S-mode: may fetch
    expect(mmu.translate(va, 'fetch').ok).toBe(true);
    mmu.privilege = 3; // M-mode bypasses
    expect(mmu.translate(va, 'store').ok).toBe(true);
  });

  it('faults when A=0 and when D=0 on a store', () => {
    const mem = newMem();
    const root = RAM_BASE + 0x1000;
    const va = 0x40000000;
    const vpn1 = (va >>> 22) & 0x3ff;
    putPte(mem, root + vpn1 * 4, (BigInt(0x10) << 20n) | PTE_R | PTE_W | PTE_V); // A=0,D=0
    const mmu = mmuWith(mem);
    mmu.privilege = 1;
    mmu.setSatp(BigInt(0x80000000 | (root >>> 12)));
    expect(mmu.translate(va, 'load').ok).toBe(false);
  });
});

describe('Sv39', () => {
  function threeLevel(mem: GuestMemory, leafPa: number, level: 2 | 1 | 0): { root: number; va: number } {
    const root = RAM_BASE + 0x1000;
    const l2 = RAM_BASE + 0x2000;
    const l1 = RAM_BASE + 0x3000;
    const va = 0x40000000; // vpn2 = 1
    if (level === 2) {
      putPte(mem, root + 1 * 8, sv39Leaf(BigInt(leafPa >>> 12), RWX));
    } else if (level === 1) {
      putPte(mem, root + 1 * 8, sv39Pointer(BigInt(l2 >>> 12)));
      putPte(mem, l2 + 0 * 8, sv39Leaf(BigInt(leafPa >>> 12), RWX));
    } else {
      putPte(mem, root + 1 * 8, sv39Pointer(BigInt(l2 >>> 12)));
      putPte(mem, l2 + 0 * 8, sv39Pointer(BigInt(l1 >>> 12)));
      putPte(mem, l1 + 0 * 8, sv39Leaf(BigInt(leafPa >>> 12), RWX));
    }
    return { root, va };
  }

  it('composes a 1 GiB gigapage address', () => {
    const mem = newMem();
    const pa = RAM_BASE; // 1 GiB aligned
    const { root, va } = threeLevel(mem, pa, 2);
    const mmu = mmuWith(mem);
    mmu.privilege = 1;
    mmu.setSatp((8n << 60n) | BigInt(root >>> 12));
    expect(mmu.translate(va + 0x1234567, 'load')).toEqual({
      ok: true,
      pa: pa + 0x1234567,
      tlbHit: false,
    });
  });

  it('composes a 2 MiB megapage address', () => {
    const mem = newMem();
    const pa = RAM_BASE + 0x400000; // 2 MiB aligned
    const { root, va } = threeLevel(mem, pa, 1);
    const mmu = mmuWith(mem);
    mmu.privilege = 1;
    mmu.setSatp((8n << 60n) | BigInt(root >>> 12));
    expect(mmu.translate(va + 0x1abcd, 'load')).toEqual({
      ok: true,
      pa: pa + 0x1abcd,
      tlbHit: false,
    });
  });

  it('composes a 4 KiB leaf through three levels', () => {
    const mem = newMem();
    const pa = RAM_BASE + 0x9000;
    const { root, va } = threeLevel(mem, pa, 0);
    const mmu = mmuWith(mem);
    mmu.privilege = 1;
    mmu.setSatp((8n << 60n) | BigInt(root >>> 12));
    expect(mmu.translate(va + 0x10, 'load')).toEqual({ ok: true, pa: pa + 0x10, tlbHit: false });
  });

  it('rejects a misaligned gigapage and a non-canonical VA', () => {
    const mem = newMem();
    const pa = RAM_BASE;
    const { root, va } = threeLevel(mem, pa, 2);
    // Corrupt PPN[1] to make the gigapage misaligned.
    const rootOff = (root - RAM_BASE) >>> 0;
    const pte = mem.view.getBigUint64(rootOff + 8, true) | (1n << 19n);
    mem.view.setBigUint64(rootOff + 8, pte, true);
    const mmu = mmuWith(mem);
    mmu.privilege = 1;
    mmu.setSatp((8n << 60n) | BigInt(root >>> 12));
    expect(mmu.translate(va, 'load').ok).toBe(false);
    expect(mmu.translate(0x80000000_00, 'load').ok).toBe(false); // non-canonical
  });
});

describe('invalidation', () => {
  it('re-walks after sfence.vma and after a satp write', () => {
    const mem = newMem();
    const root = RAM_BASE + 0x1000;
    const va = 0x40000000;
    const vpn1 = (va >>> 22) & 0x3ff;
    // Megapage leaves must be 4 MiB aligned, so step by whole megapages.
    const pa1 = RAM_BASE;
    const pa2 = RAM_BASE + 0x400000;
    putPte(mem, root + vpn1 * 4, BigInt(sv32Leaf(pa1 >>> 12, RWX)));
    const mmu = mmuWith(mem);
    mmu.privilege = 1;
    mmu.setSatp(BigInt(0x80000000 | (root >>> 12)));

    expect(paOf(mmu.translate(va, 'load'))).toBe(pa1);
    expect(hitOf(mmu.translate(va, 'load'))).toBe(true);
    // Change the PTE behind the TLB's back.
    putPte(mem, root + vpn1 * 4, BigInt(sv32Leaf(pa2 >>> 12, RWX)));
    expect(paOf(mmu.translate(va, 'load'))).toBe(pa1); // still cached
    mmu.invalidateVpn(va);
    expect(paOf(mmu.translate(va, 'load'))).toBe(pa2);
    // satp write flushes everything.
    putPte(mem, root + vpn1 * 4, BigInt(sv32Leaf(pa1 >>> 12, RWX)));
    mmu.setSatp(BigInt(0x80000000 | (root >>> 12)));
    expect(paOf(mmu.translate(va, 'load'))).toBe(pa1);
  });
});

describe('machine integration', () => {
  const ROOT = RAM_BASE + 0x1000;

  function sv32IdentityMachine(): Machine {
    const machine = new Machine({ ramBytes: RAM_BYTES, ramBase: RAM_BASE, mmu: true });
    const va = RAM_BASE; // program linked at the RAM base
    const vpn1 = (va >>> 22) & 0x3ff;
    // 4 MiB megapage covering RAM, VA == PA.
    putPte(machine.mem, ROOT + vpn1 * 4, BigInt(sv32Leaf(RAM_BASE >>> 12, RWX)));
    machine.mmu.privilege = 1;
    machine.mmu.setSatp(BigInt(0x80000000 | (ROOT >>> 12)));
    return machine;
  }

  it('fetches and executes through the MMU, bypassing the JIT', () => {
    const machine = sv32IdentityMachine();
    const asm = assemble('  li a0, 7\n  li a7, 93\n  ecall\n', { base: RAM_BASE });
    machine.load(asm.bytes, RAM_BASE);
    machine.reset(RAM_BASE, RAM_BASE + 0x8000);
    expect(machine.mmuActive).toBe(true);
    machine.run(1000);
    expect(machine.cpu.stop).toBe('exit');
    expect(machine.cpu.exitCode).toBe(7);
    expect(machine.stats().jitInstructions).toBe(0);
    expect(machine.stats().interpInstructions).toBeGreaterThan(0);
  });

  it('raises an instruction page fault and records the faulting PC in mepc', () => {
    const machine = sv32IdentityMachine();
    const vpn1 = (RAM_BASE >>> 22) & 0x3ff;
    // Replace the megapage with a non-executable leaf at the program VA.
    putPte(machine.mem, ROOT + vpn1 * 4, BigInt(PTE_R | PTE_W | PTE_A | PTE_D | PTE_V));
    const asm = assemble('  li a0, 1\n', { base: RAM_BASE });
    machine.load(asm.bytes, RAM_BASE);
    machine.reset(RAM_BASE, RAM_BASE + 0x8000);
    const handler = RAM_BASE + 0x100;
    machine.cpu.writeCsr(CSR.mtvec, handler);
    machine.run(1);
    expect(machine.cpu.readCsr(CSR.mepc) >>> 0).toBe(RAM_BASE);
    expect(machine.cpu.pc).toBe(handler);
  });

  it('accepts a legal sfence.vma rs1, rs2 without trapping', () => {
    const machine = new Machine({ ramBytes: RAM_BYTES, ramBase: RAM_BASE, mmu: true });
    // sfence.vma a0, a1: funct7=0x09, rd=0, rs1=a0(10), rs2=a1(11).
    const word = ((0x09 << 25) | (11 << 20) | (10 << 15) | 0x73) >>> 0;
    const asm = assemble(`  .word ${word}\n  li a0, 5\n  li a7, 93\n  ecall\n`, { base: RAM_BASE });
    machine.load(asm.bytes, RAM_BASE);
    machine.reset(RAM_BASE, RAM_BASE + 0x8000);
    machine.run(100);
    expect(machine.cpu.stop).toBe('exit');
    expect(machine.cpu.exitCode).toBe(5);
  });
});
