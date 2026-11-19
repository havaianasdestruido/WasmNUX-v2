/**
 * Sv39 MMU + software TLB (ADR-0004: "explicit TLB check in generated code").
 *
 * Wasm has no guard pages or `mprotect`, so every translated access performs an
 * explicit probe. The TLB is direct-mapped, lock-free for the single-vCPU case,
 * and mirrored into the memory footer so JIT-generated code can inline the
 * probe (spike A measures probe overhead; spike B validates cross-worker
 * coherence via SFENCE.VMA invalidation).
 */

export const SATP_MODE_BARE = 0n;
export const SATP_MODE_SV39 = 8n;

export const PTE_V = 1n;
export const PTE_R = 2n;
export const PTE_W = 4n;
export const PTE_X = 8n;
export const PTE_U = 16n;
export const PTE_A = 64n;
export const PTE_D = 128n;

export type AccessKind = "fetch" | "read" | "write";

export interface MmuFault {
  ok: false;
  kind: "page-fault";
  cause: bigint; // 12 = instr, 13 = load, 15 = store/AMO
  address: bigint;
}

export type MmuResult = { ok: true; pa: bigint; tlbHit: boolean } | MmuFault;

interface TlbEntry {
  valid: boolean;
  vpn: bigint;      // virtual page number (4 KiB pages, Sv39 27-bit VPN)
  ppn: bigint;      // physical page number
  pte: bigint;      // raw PTE (for permission re-checks / A/D flags)
}

const TLB_SIZE = 256; // direct-mapped; power of two

function tlbIndex(vpn: bigint): number {
  // xor-fold to spread sequential pages across sets
  const folded = vpn ^ (vpn >> 8n) ^ (vpn >> 16n);
  return Number(folded & BigInt(TLB_SIZE - 1));
}

export class Mmu {
  /** satp CSR value. */
  satp = 0n;
  /** Current privilege mode (0=U, 1=S, 3=M). Phase 0 spikes run in M. */
  privilege = 3;

  private readonly entries: TlbEntry[] = Array.from({ length: TLB_SIZE }, () => ({
    valid: false, vpn: 0n, ppn: 0n, pte: 0n,
  }));

  private _hits = 0;
  private _misses = 0;

  get stats() { return { hits: this._hits, misses: this._misses }; }

  resetStats(): void { this._hits = 0; this._misses = 0; }

  get mode(): bigint {
    return (this.satp >> 60n) & 0xfn;
  }

  get rootTable(): bigint {
    return this.satp & 0xfff_ffff_fffffn;
  }

  invalidateAll(): void {
    for (const e of this.entries) e.valid = false;
  }

  invalidateVpn(vpn: bigint): void {
    const e = this.entries[tlbIndex(vpn)]!;
    if (e.valid && e.vpn === vpn) e.valid = false;
  }

  /** Fast-path probe: returns the TLB entry for a VA page or null. */
  probe(va: bigint): TlbEntry | null {
    const vpn = va >> 12n;
    const e = this.entries[tlbIndex(vpn)]!;
    if (e.valid && e.vpn === vpn) {
      this._hits++;
      return e;
    }
    this._misses++;
    return null;
  }

  /**
   * Translate `va` → `pa`. Bare mode (or M-mode) is identity. Sv39 walks the
   * page tables through a reader callback and fills the TLB.
   */
  translate(va: bigint, kind: AccessKind, readPte: (pa: bigint) => bigint): MmuResult {
    const isM = this.privilege === 3;
    if (this.mode === SATP_MODE_BARE || isM) {
      // M-mode ignores translation; identity (spikes run fully in M-mode).
      return { ok: true, pa: va, tlbHit: false };
    }

    // Sv39: VA must be sign-extended 39-bit.
    const sext = (va << 25n) >> 25n;
    if (sext !== va) {
      return { ok: false, kind: "page-fault", cause: faultCause(kind), address: va };
    }

    const hit = this.probe(va);
    if (hit) {
      if (!this.checkPermission(hit.pte, kind)) {
        return { ok: false, kind: "page-fault", cause: faultCause(kind), address: va };
      }
      const pageOff = va & 0xfffn;
      const pa = (hit.ppn << 12n) | pageOff;
      return { ok: true, pa, tlbHit: true };
    }

    // Page-table walk (3 levels, 4 KiB pages, 512 entries × 8 bytes).
    let a = this.rootTable << 12n;
    let i = 2n;
    for (;;) {
      const vpn = (va >> (12n + i * 9n)) & 0x1ffn;
      const pteAddr = a + vpn * 8n;
      const pte = readPte(pteAddr);
      const v = pte & PTE_V;
      const r = pte & PTE_R;
      const w = pte & PTE_W;
      if (v === 0n || (w !== 0n && r === 0n)) {
        return { ok: false, kind: "page-fault", cause: faultCause(kind), address: va };
      }
      if ((r | (pte & PTE_X)) !== 0n) {
        // Leaf PTE. (Misaligned superpage: not checked in Phase 0 subset.)
        if (!this.checkPermission(pte, kind)) {
          return { ok: false, kind: "page-fault", cause: faultCause(kind), address: va };
        }
        const ppn = (pte >> 10n) & 0xfff_ffff_fffffn;
        const pageOff = va & 0xfffn;
        const pa = (ppn << 12n) | pageOff;
        const idx = tlbIndex(va >> 12n);
        this.entries[idx] = { valid: true, vpn: va >> 12n, ppn, pte };
        return { ok: true, pa, tlbHit: false };
      }
      // Pointer PTE → next level.
      a = ((pte >> 10n) & 0xfff_ffff_fffffn) << 12n;
      if (i === 0n) {
        return { ok: false, kind: "page-fault", cause: faultCause(kind), address: va };
      }
      i -= 1n;
    }
  }

  private checkPermission(pte: bigint, kind: AccessKind): boolean {
    if (this.privilege === 3) return true;
    const user = (pte & PTE_U) !== 0n;
    if (this.privilege === 0 && !user) return false;
    if (this.privilege === 1 && user) return false;
    switch (kind) {
      case "fetch": return (pte & PTE_X) !== 0n;
      case "read": return (pte & PTE_R) !== 0n;
      case "write": return (pte & PTE_W) !== 0n;
    }
  }
}

function faultCause(kind: AccessKind): bigint {
  if (kind === "fetch") return 12n;
  if (kind === "read") return 13n;
  return 15n;
}

/** Build a minimal identity-mapped Sv39 table set for tests/spikes. */
export function buildIdentityTables(): { root: bigint; pages: Map<bigint, bigint> } {
  // Maps VA [0, 1 GiB) via 1 GiB gigapages identity → PA (root L2 only).
  const root = 0x1000n;
  const pages = new Map<bigint, bigint>();
  for (let i = 0n; i < 512n; i++) {
    // leaf gigapage: ppn = i * 0x40000 (GiB units in ppn terms), RWX U A D V
    const pte = (i << 18n) << 10n | PTE_R | PTE_W | PTE_X | PTE_A | PTE_D | PTE_V;
    pages.set(root + i * 8n, pte);
  }
  return { root, pages };
}
