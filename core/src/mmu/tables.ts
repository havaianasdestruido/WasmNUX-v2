/**
 * Page-table construction helpers for tests, diagnostics and the Sv32/Sv39
 * identity maps a host may install before the guest takes over `satp`.
 *
 * PTE layouts (shared flag positions):
 *   Sv32: V R W X U G A D | RSW | PPN[1] (31:20) | PPN[0] (19:10)
 *   Sv39: V R W X U G A D | RSW | PPN[2] (53:28) | PPN[1] (27:19) | PPN[0] (18:10)
 */

import { PTE_A, PTE_D, PTE_R, PTE_V, PTE_W, PTE_X } from './mmu.ts';

export const PTE_FLAGS = { V: PTE_V, R: PTE_R, W: PTE_W, X: PTE_X, A: PTE_A, D: PTE_D } as const;

/** RWX leaf PTE with A/D set, for identity maps. */
export function sv32Leaf(ppn: number, flags: bigint = PTE_R | PTE_W | PTE_X | PTE_A | PTE_D | PTE_V): number {
  return Number((BigInt(ppn) << 10n) | flags) >>> 0;
}

export function sv32Pointer(nextTablePpn: number): number {
  return Number((BigInt(nextTablePpn) << 10n) | PTE_V) >>> 0;
}

export function sv39Leaf(ppn: bigint, flags: bigint = PTE_R | PTE_W | PTE_X | PTE_A | PTE_D | PTE_V): bigint {
  return (ppn << 10n) | flags;
}

export function sv39Pointer(nextTablePpn: bigint): bigint {
  return (nextTablePpn << 10n) | PTE_V;
}

/** Write a PTE into a little-endian view at a physical offset. */
export function writePte(view: DataView, byteOffset: number, pte: bigint): void {
  view.setUint32(byteOffset, Number(pte & 0xffff_ffffn), true);
  if (pte > 0xffff_ffffn) {
    view.setUint32(byteOffset + 4, Number((pte >> 32n) & 0xffff_ffffn), true);
  }
}
