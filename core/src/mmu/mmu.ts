/**
 * Sv32 / Sv39 MMU with a software TLB (ADR-0004).
 *
 * The RV32IMA core runs in M-mode with an identity map by default; paging is
 * opt-in through `satp`. Both Sv32 (the RV32 mode) and Sv39 (the mode the RV64
 * expansion will use) are implemented here so the page-table walker, superpage
 * composition and permission model are pinned by tests before any privilege
 * mode work lands.
 *
 * Correctness notes that the tests pin down:
 *  - superpage leaves compose their physical address from the *lower* VPN fields,
 *    not just the 4 KiB page offset (the bug that aliased a 1 GiB mapping onto
 *    its first page);
 *  - misaligned superpages fault;
 *  - A=0 always faults, D=0 faults on a store/AMO (no hardware A/D update);
 *  - `sfence.vma` invalidates the TLB, including address-specific flushes;
 *  - writing `satp` invalidates every translation.
 *
 * PTE reads are physical and go through a host callback, so the walker never
 * translates its own page tables.
 */

export type MmuMode = 'bare' | 'sv32' | 'sv39';
export type AccessKind = 'fetch' | 'load' | 'store' | 'amo';

export type TranslateResult =
  | { ok: true; pa: number; tlbHit: boolean }
  | { ok: false; cause: number; tval: number };

export interface MmuHost {
  /** Read a PTE from guest physical memory. `null` when the address is not RAM. */
  readPte(pa: number, size: 4 | 8): bigint | null;
}

/** RISC-V exception causes for page faults. */
export const PAGE_FAULT = {
  fetch: 12,
  load: 13,
  store: 15,
} as const;

// PTE flag bits (same positions in Sv32 and Sv39).
export const PTE_V = 1n;
export const PTE_R = 2n;
export const PTE_W = 4n;
export const PTE_X = 8n;
export const PTE_U = 16n;
export const PTE_A = 64n;
export const PTE_D = 128n;

const TLB_SIZE = 256;

interface TlbEntry {
  valid: boolean;
  vpn: number;
  mode: MmuMode;
  pte: bigint;
  level: number;
}

function tlbIndex(vpn: number): number {
  // xor-fold so sequential pages spread across the direct-mapped sets.
  return (vpn ^ (vpn >>> 8) ^ (vpn >>> 16)) & (TLB_SIZE - 1);
}

export class Mmu {
  /** Full `satp` value (both the Sv32 32-bit form and the Sv39 64-bit form). */
  satp = 0n;
  /** 0 = U, 1 = S, 3 = M. M-mode ignores translation. */
  privilege = 3;

  private readonly entries: TlbEntry[] = Array.from({ length: TLB_SIZE }, () => ({
    valid: false,
    vpn: 0,
    mode: 'bare',
    pte: 0n,
    level: 0,
  }));

  private hits = 0;
  private misses = 0;

  constructor(private readonly host: MmuHost) {}

  get stats(): { hits: number; misses: number } {
    return { hits: this.hits, misses: this.misses };
  }

  resetStats(): void {
    this.hits = 0;
    this.misses = 0;
  }

  get mode(): MmuMode {
    const sv39 = (this.satp >> 60n) & 0xfn;
    if (sv39 === 8n) return 'sv39';
    if ((this.satp & 0x8000_0000n) !== 0n) return 'sv32';
    return 'bare';
  }

  /** Root table physical address (PPN field shifted to a byte address). */
  get rootTable(): number {
    if (this.mode === 'sv39') {
      return Number((this.satp & 0x0000_ffff_ffff_ffffn) << 12n) >>> 0;
    }
    return Number((this.satp & 0x0000_0000_003f_ffffn) << 12n) >>> 0;
  }

  /** True when guest virtual addresses must be translated. */
  get active(): boolean {
    return this.mode !== 'bare' && this.privilege !== 3;
  }

  /** Write `satp`; every cached translation is now invalid. */
  setSatp(value: bigint): void {
    // Normalise to unsigned 64-bit: a 32-bit CSR write of 0x8000_0000 arrives
    // as a negative JS number and must not poison the mode field.
    this.satp = BigInt.asUintN(64, value);
    this.invalidateAll();
  }

  invalidateAll(): void {
    for (const e of this.entries) e.valid = false;
  }

  /** Address-specific flush (`sfence.vma rs1, rs2` with rs1 != 0). */
  invalidateVpn(va: number): void {
    const vpn = (va >>> 0) >> 12;
    const e = this.entries[tlbIndex(vpn)]!;
    if (e.valid && e.vpn === vpn) e.valid = false;
  }

  /**
   * Translate a guest virtual address. M-mode and bare mode are identity.
   * Page faults return the RISC-V cause and the faulting VA in `tval`.
   */
  translate(va: number, kind: AccessKind): TranslateResult {
    const v = va >>> 0;
    if (this.mode === 'bare' || this.privilege === 3) {
      return { ok: true, pa: v, tlbHit: false };
    }
    if (this.mode === 'sv39' && v >= 0x8000_0000_00) {
      // Canonical Sv39 addresses need bits 63:39 == bit 38; a 32-bit VA cannot
      // represent the sign-extended half, so bit 38 set is always non-canonical.
      return { ok: false, cause: this.faultCause(kind), tval: v };
    }

    const vpn = v >> 12;
    const hit = this.entries[tlbIndex(vpn)]!;
    if (hit.valid && hit.vpn === vpn && hit.mode === this.mode) {
      this.hits++;
      const perm = this.checkPermission(hit.pte, kind);
      if (!perm.ok) return { ok: false, cause: perm.cause, tval: v };
      return { ok: true, pa: this.composePa(hit.pte, hit.level, v), tlbHit: true };
    }
    this.misses++;
    return this.walk(v, vpn, kind);
  }

  private walk(va: number, vpn: number, kind: AccessKind): TranslateResult {
    const mode = this.mode;
    if (mode === 'sv32') return this.walkSv32(va, vpn, kind);
    return this.walkSv39(va, vpn, kind);
  }

  private walkSv32(va: number, vpn: number, kind: AccessKind): TranslateResult {
    let a = this.rootTable;
    let level = 1;
    for (;;) {
      const vpnPart = level === 1 ? (va >>> 22) & 0x3ff : (va >>> 12) & 0x3ff;
      const pte = this.host.readPte((a + vpnPart * 4) >>> 0, 4);
      if (pte === null) return this.fault(kind, va);
      if ((pte & PTE_V) === 0n) return this.fault(kind, va);
      const leaf = (pte & (PTE_R | PTE_X)) !== 0n;
      if (leaf) {
        const perm = this.checkPermission(pte, kind);
        if (!perm.ok) return { ok: false, cause: perm.cause, tval: va };
        let pa: number;
        if (level === 1) {
          // 4 MiB megapage: PPN[0] must be zero, PPN[1] is the high part.
          const ppn0 = (pte >> 10n) & 0x3ffn;
          if (ppn0 !== 0n) return this.fault(kind, va);
          const ppn1 = (pte >> 20n) & 0xfffn;
          pa = Number((ppn1 << 22n) | (BigInt(va) & 0x3f_ffffn)) >>> 0;
        } else {
          const ppn = (pte >> 10n) & 0x3f_ffffn;
          pa = Number((ppn << 12n) | (BigInt(va) & 0xfffn)) >>> 0;
        }
        this.fillTlb(vpn, 'sv32', pte, level);
        return { ok: true, pa, tlbHit: false };
      }
      if (level === 0) return this.fault(kind, va);
      // A Sv32 pointer PTE's next-level base is the full 22-bit PPN << 12.
      const next = (pte >> 10n) & 0x3f_ffffn;
      a = Number(next << 12n) >>> 0;
      level--;
    }
  }

  private walkSv39(va: number, vpn: number, kind: AccessKind): TranslateResult {
    let a = this.rootTable;
    let level = 2;
    for (;;) {
      const shift = 12 + level * 9;
      const vpnPart = (va >>> shift) & 0x1ff;
      const pte = this.host.readPte((a + vpnPart * 8) >>> 0, 8);
      if (pte === null) return this.fault(kind, va);
      if ((pte & PTE_V) === 0n) return this.fault(kind, va);
      const leaf = (pte & (PTE_R | PTE_X)) !== 0n;
      if (leaf) {
        const perm = this.checkPermission(pte, kind);
        if (!perm.ok) return { ok: false, cause: perm.cause, tval: va };
        const ppn2 = (pte >> 28n) & 0x3f_fffffn;
        const ppn1 = (pte >> 19n) & 0x1ffn;
        const ppn0 = (pte >> 10n) & 0x1ffn;
        let pa: number;
        if (level === 2) {
          // 1 GiB gigapage: PPN[1:0] must be zero.
          if (ppn1 !== 0n || ppn0 !== 0n) return this.fault(kind, va);
          pa = Number((ppn2 << 30n) | (BigInt(va) & 0x3fff_ffffn)) >>> 0;
        } else if (level === 1) {
          // 2 MiB megapage: PPN[0] must be zero.
          if (ppn0 !== 0n) return this.fault(kind, va);
          pa = Number((ppn2 << 30n) | (ppn1 << 21n) | (BigInt(va) & 0x1f_ffffn)) >>> 0;
        } else {
          pa = Number((ppn2 << 30n) | (ppn1 << 21n) | (ppn0 << 12n) | (BigInt(va) & 0xfffn)) >>> 0;
        }
        this.fillTlb(vpn, 'sv39', pte, level);
        return { ok: true, pa, tlbHit: false };
      }
      if (level === 0) return this.fault(kind, va);
      const next = (pte >> 10n) & 0x0000_ffff_ffff_ffffn; // 44-bit PPN
      a = Number(next << 12n) >>> 0;
      level--;
    }
  }

  private composePa(pte: bigint, level: number, va: number): number {
    if (this.mode === 'sv39') {
      const ppn2 = (pte >> 28n) & 0x3f_fffffn;
      const ppn1 = (pte >> 19n) & 0x1ffn;
      const ppn0 = (pte >> 10n) & 0x1ffn;
      if (level === 2) return Number((ppn2 << 30n) | (BigInt(va) & 0x3fff_ffffn)) >>> 0;
      if (level === 1) return Number((ppn2 << 30n) | (ppn1 << 21n) | (BigInt(va) & 0x1f_ffffn)) >>> 0;
      return Number((ppn2 << 30n) | (ppn1 << 21n) | (ppn0 << 12n) | (BigInt(va) & 0xfffn)) >>> 0;
    }
    if (level === 1) {
      const ppn1 = (pte >> 20n) & 0xfffn;
      return Number((ppn1 << 22n) | (BigInt(va) & 0x3f_ffffn)) >>> 0;
    }
    const ppn = (pte >> 10n) & 0x3f_ffffn;
    return Number((ppn << 12n) | (BigInt(va) & 0xfffn)) >>> 0;
  }

  private fillTlb(vpn: number, mode: MmuMode, pte: bigint, level: number): void {
    this.entries[tlbIndex(vpn)] = { valid: true, vpn, mode, pte, level };
  }

  private checkPermission(pte: bigint, kind: AccessKind): { ok: true } | { ok: false; cause: number } {
    if (this.privilege === 3) return { ok: true };
    if ((pte & PTE_A) === 0n) return { ok: false, cause: this.faultCause(kind) };
    if (kind === 'store' || kind === 'amo') {
      if ((pte & PTE_D) === 0n) return { ok: false, cause: this.faultCause(kind) };
    }
    const user = (pte & PTE_U) !== 0n;
    if (this.privilege === 0 && !user) return { ok: false, cause: this.faultCause(kind) };
    if (this.privilege === 1 && user) return { ok: false, cause: this.faultCause(kind) };
    switch (kind) {
      case 'fetch':
        if ((pte & PTE_X) === 0n) return { ok: false, cause: this.faultCause(kind) };
        break;
      case 'load':
        if ((pte & PTE_R) === 0n) return { ok: false, cause: this.faultCause(kind) };
        break;
      case 'store':
      case 'amo':
        if ((pte & PTE_W) === 0n) return { ok: false, cause: this.faultCause(kind) };
        break;
    }
    return { ok: true };
  }

  private fault(kind: AccessKind, va: number): TranslateResult {
    return { ok: false, cause: this.faultCause(kind), tval: va >>> 0 };
  }

  private faultCause(kind: AccessKind): number {
    if (kind === 'fetch') return PAGE_FAULT.fetch;
    if (kind === 'load') return PAGE_FAULT.load;
    return PAGE_FAULT.store;
  }
}
