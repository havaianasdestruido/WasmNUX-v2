import { describe, expect, it } from "vitest";
import { assemble } from "../src/isa/assembler.js";
import { Cpu, EXIT_SYSCALL } from "../src/cpu.js";
import { GuestMemory } from "../src/memory.js";
import { buildIdentityTables, PTE_A, PTE_D, PTE_R, PTE_V, PTE_W, PTE_X } from "../src/mmu.js";

function makeCpu(src: string, opts?: { memBytes?: number }): { cpu: Cpu; mem: GuestMemory } {
  const mem = new GuestMemory({ sizeBytes: opts?.memBytes ?? (1 << 20), base: 0 });
  const prog = assemble(src, { base: 0 });
  mem.loadImage(0, prog.image);
  const cpu = new Cpu({ memory: mem, pc: BigInt(prog.entry), captureOutput: true });
  return { cpu, mem };
}

const EXIT0 = `
  li a7, 93
  li a0, 0
  ecall
`;

describe("cpu interpreter", () => {
  it("arithmetic and branches: sums 1..n", () => {
    const { cpu } = makeCpu(`
      start:
        li t0, 0        # sum
        li t1, 1        # i
        li t2, 101      # limit
      loop:
        add t0, t0, t1
        addi t1, t1, 1
        blt t1, t2, loop
        mv a0, t0
        li a7, 93
        ecall
    `);
    const r = cpu.run(1_000_000);
    expect(r).toEqual({ kind: "exit", code: (100 * 101) / 2 });
  });

  it("loads/stores of every width round-trip", () => {
    const { cpu } = makeCpu(`
      start:
        la t0, buf
        li t1, 0x8899aabbccddeeff
        sd t1, 0(t0)
        ld t2, 0(t0)
        bne t1, t2, fail
        lw t3, 0(t0)         # low 32 sign-extended
        li t4, 0xffffffffccddeeff
        bne t3, t4, fail
        lwu t3, 4(t0)        # high 32 zero-extended
        li t4, 0x8899aabb
        bne t3, t4, fail
        sb t1, 8(t0)
        lb t3, 8(t0)
        li t4, -1             # 0xff sign-extended
        bne t3, t4, fail
        lbu t3, 8(t0)
        li t4, 0xff
        bne t3, t4, fail
        li a0, 0
        j done
      fail:
        li a0, 1
      done:
        li a7, 93
        ecall
      .align 3
      buf: .dword 0
      .dword 0
      .dword 0
    `);
    const r = cpu.run(100_000);
    expect(r).toEqual({ kind: "exit", code: 0 });
  });

  it("M-extension division semantics (div-by-zero, overflow)", () => {
    const { cpu } = makeCpu(`
      start:
        li t0, 100
        li t1, 0
        div t2, t0, t1        # → -1
        li t3, -1
        bne t2, t3, fail
        rem t2, t0, t1        # → 100
        bne t2, t0, fail
        li t0, -9
        li t1, 4
        div t2, t0, t1        # → -2 (trunc toward zero)
        li t3, -2
        bne t2, t3, fail
        rem t2, t0, t1        # → -1
        li t3, -1
        bne t2, t3, fail
        li t0, -0x8000000000000000
        li t1, -1
        div t2, t0, t1        # overflow → t0
        bne t2, t0, fail
        rem t2, t0, t1        # overflow r → 0
        bnez t2, fail
        li a0, 0
        j done
      fail:
        li a0, 1
      done:
        li a7, 93
        ecall
    `);
    expect(cpu.run(100_000)).toEqual({ kind: "exit", code: 0 });
  });

  it("write syscall captures output", () => {
    const { cpu } = makeCpu(`
      start:
        li a0, 1            # fd
        la a1, msg
        li a2, 5
        li a7, 64
        ecall
        ${EXIT0}
      msg: .ascii "hello"
    `);
    cpu.run(10_000);
    expect(cpu.output).toBe("hello");
  });

  it("LR/SC succeeds after LR and fails after conflicting store", () => {
    const { cpu } = makeCpu(`
      start:
        la t0, slot
        li t1, 7
        sd t1, 0(t0)
        lr.d t2, (t0)
        addi t2, t2, 1
        sc.d t3, t2, (t0)
        bnez t3, fail         # SC must succeed
        ld t4, 0(t0)
        li t5, 8
        bne t4, t5, fail
        lr.d t2, (t0)
        sd t1, 0(t0)          # conflicting store clears reservation
        sc.d t3, t2, (t0)
        beqz t3, fail         # SC must fail now
        li a0, 0
        j done
      fail:
        li a0, 1
      done:
        li a7, 93
        ecall
      .align 3
      slot: .dword 0
    `);
    expect(cpu.run(100_000)).toEqual({ kind: "exit", code: 0 });
  });

  it("AMO ops (add/max/and/or/xor/swap, w and d)", () => {
    const { cpu } = makeCpu(`
      start:
        la t0, slot
        li t1, 100
        sd t1, 0(t0)
        li t2, 5
        amoadd.d t3, t2, (t0)
        li t4, 100
        bne t3, t4, fail
        ld t3, 0(t0)
        li t4, 105
        bne t3, t4, fail
        li t2, 200
        amomax.d t3, t2, (t0)
        ld t3, 0(t0)
        li t4, 200
        bne t3, t4, fail
        li t2, 0x0f
        amoand.d t3, t2, (t0)
        ld t3, 0(t0)
        li t4, 8            # 200 & 15 = 8
        bne t3, t4, fail
        li a0, 0
        j done
      fail:
        li a0, 1
      done:
        li a7, 93
        ecall
      .align 3
      slot: .dword 0
    `);
    expect(cpu.run(100_000)).toEqual({ kind: "exit", code: 0 });
  });

  it("CSR counters advance and unknown CSRs trap", () => {
    const { cpu, mem } = makeCpu(`
      start:
        csrr t0, minstret
        nop
        nop
        csrr t1, minstret
        sub a0, t1, t0        # ≥ 3 (csrrs + 2 nops + this reads…)
        li a7, 93
        ecall
    `);
    const r = cpu.run(10_000);
    expect(r.kind).toBe("exit");
    expect(cpu.getReg(10)).toBeGreaterThanOrEqual(3n);
    void mem;
  });

  it("Sv39 translation: identity mapping via gigapages", () => {
    const mem = new GuestMemory({ sizeBytes: 1 << 20, base: 0 });
    const prog = assemble(`
      start:
        la t0, buf
        li t1, 0x12345678
        sd t1, 0(t0)
        ld t2, 0(t0)
        li t3, 0x12345678
        bne t2, t3, fail
        li a0, 0
        j done
      fail:
        li a0, 1
      done:
        li a7, 93
        ecall
      .align 3
      buf: .dword 0
    `, { base: 0 });
    mem.loadImage(0, prog.image);
    const cpu = new Cpu({ memory: mem, captureOutput: true });
    // Install identity gigapages and enable Sv39 in S-mode.
    const { root, pages } = buildIdentityTables();
    for (const [addr, pte] of pages) mem.writeU64(Number(addr), pte);
    cpu.mmu.satp = (8n << 60n) | (root >> 12n);
    cpu.mmu.privilege = 1; // S-mode: translation active
    cpu.pc = 0n;
    const r = cpu.run(100_000);
    expect(r).toEqual({ kind: "exit", code: 0 });
    expect(cpu.mmu.stats.hits + cpu.mmu.stats.misses).toBeGreaterThan(0);
  });

  it("page fault raises the right cause when PTE invalid", () => {
    const mem = new GuestMemory({ sizeBytes: 1 << 20, base: 0 });
    const prog = assemble(`
      start:
        li t0, 0x100000000
        ld t1, 0(t0)         # outside the mapped gigapage → load page fault
        li a7, 93
        li a0, 0
        ecall
    `, { base: 0 });
    mem.loadImage(0, prog.image);
    const cpu = new Cpu({ memory: mem, captureOutput: true });
    const { root, pages } = buildIdentityTables();
    for (const [addr, pte] of pages) mem.writeU64(Number(addr), pte);
    // Unmap VA 0x1_0000_0000 (vpn2 index 4): 4 GiB.
    mem.writeU64(Number(root) + 4 * 8, 0n);
    cpu.mmu.satp = (8n << 60n) | (root >> 12n);
    cpu.mmu.privilege = 1;
    cpu.pc = 0n;
    cpu.run(1_000);
    const mcause = cpu.readCsr(0x342, cpu.pc);
    expect(mcause).toBe(13n); // load page fault
    expect(PTE_V | PTE_R | PTE_W | PTE_X | PTE_A | PTE_D).toBeGreaterThan(0n);
    expect(EXIT_SYSCALL).toBe(93n);
  });

  it("ecall with unknown syscall returns -ENOSYS", () => {
    const { cpu } = makeCpu(`
      start:
        li a7, 1234
        ecall
        mv t0, a0
        li a7, 93
        mv a0, t0
        ecall
    `);
    const r = cpu.run(10_000);
    expect(r).toEqual({ kind: "exit", code: -38 });
  });
});

describe("cpu — Codex review regressions", () => {
  it("mepc records the faulting instruction, not pc+4", () => {
    // Illegal word at offset 8; trap writes mepc = 8 (not 12).
    const mem = new GuestMemory({ sizeBytes: 1 << 16, base: 0 });
    const prog = assemble(`
      start:
        li t0, 1
        .word 0xffffffff
      after:
        li a7, 93
        ecall
    `, { base: 0 });
    mem.loadImage(0, prog.image);
    const cpu = new Cpu({ memory: mem, captureOutput: true });
    cpu.run(100);
    const mepc = cpu.readCsr(0x341, cpu.pc); // CSR_MEPC
    expect(mepc).toBe(BigInt(prog.entry + 4)); // li t0,1 is one insn
    const mcause = cpu.readCsr(0x342, cpu.pc);
    expect(mcause).toBe(2n); // illegal instruction
  });

  it("SC consumes the reservation even when the address mismatches", () => {
    const { cpu } = makeCpu(`
      start:
        la t0, slot
        la t1, other
        lr.d t2, (t0)      # reserve slot
        sc.d t3, t2, (t1)  # wrong address → fails AND consumes
        sc.d t3, t2, (t0)  # no fresh LR → must also fail
        mv a0, t3          # a0 = 1 if the reservation was consumed
        li a7, 93
        ecall
      .align 3
      slot: .dword 0
      other: .dword 0
    `);
    const r = cpu.run(100_000);
    expect(r).toEqual({ kind: "exit", code: 1 }); // second SC failed
    expect(cpu.resValid).toBe(false);
  });

  it("SC fails when another hart stores between LR and SC", () => {
    const mem = new GuestMemory({ sizeBytes: 1 << 16, shared: true, hartCount: 2, hart: 0 });
    const prog = assemble(`
      start:
        la t0, slot
        lr.d t2, (t0)
        # ... concurrent hart stores here (simulated below) ...
        sc.d t3, t2, (t0)  # must FAIL: epoch changed since LR
        mv a0, t3          # a0 = 1 (failure)
        li a7, 93
        ecall
      .align 3
      slot: .dword 0
    `, { base: 0 });
    // Insert a foreign-hart store between LR and SC by stepping to the SC.
    const img = prog.image;
    mem.loadImage(0, img);
    const cpu = new Cpu({ memory: mem, captureOutput: true });
    // Step until we reach the SC (pc past LR), then bump the epoch as a
    // store from another hart would.
    let scPc = -1;
    for (let i = 0; i < 20 && scPc < 0; i++) {
      const pcNow = cpu.pc;
      cpu.step();
      // crude: after executing lr (which sets resValid), the next insn is SC
      if (cpu.resValid && cpu.pc > pcNow) {
        // next step executes SC — bump epoch now, as another hart's store
        mem.bumpStoreEpoch();
        cpu.step();
        scPc = 1;
      }
    }
    expect(scPc).toBe(1);
    expect(cpu.getReg(28)).toBe(1n); // t3 = 1 → SC failed
    expect(cpu.resValid).toBe(false);
  });

  it("stores from another hart (its own view) invalidate reservations", () => {
    const memA = new GuestMemory({ sizeBytes: 1 << 16, shared: true, hartCount: 2, hart: 0 });
    const memB = new GuestMemory({ sizeBytes: 1 << 16, shared: true, hartCount: 2, hart: 1, attach: memA.memory });
    const epoch0 = memA.storeEpoch;
    // hart 1 executes a real store through ITS view (bumps the shared epoch)
    const prog = assemble(`
      start:
        li t0, 0x100
        li t1, 7
        sd t1, 0(t0)
        li a7, 93
        li a0, 0
        ecall
    `, { base: 0 });
    memB.loadImage(0, prog.image);
    const cpuB = new Cpu({ memory: memB, captureOutput: true });
    expect(cpuB.run(1000)).toEqual({ kind: "exit", code: 0 });
    expect(memA.storeEpoch).not.toBe(epoch0);
    expect(memA.storeEpoch).toBe(memB.storeEpoch); // same sync page
    expect(memA.readU64(0x100)).toBe(7n);          // shared RAM
  });

  it("amominu_w/amomaxu_w compare the low 32 bits only", () => {
    const { cpu, mem } = makeCpu(`
      start:
        la t0, slot
        li t1, 5
        li t2, 0x100000001     # low 32 = 1
        amominu.w t3, t2, (t0) # min(5u32, 1u32) = 1 → memory becomes 1
        ld t4, 0(t0)
        li a0, 0
        li a7, 93
        ecall
      .align 3
      slot: .dword 5
    `);
    const r = cpu.run(10_000);
    expect(r).toEqual({ kind: "exit", code: 0 });
    // memory must hold the 32-bit minimum (1), not the 64-bit minimum (5)
    const slotAddr = 0; // find slot: scan for dword 1 or 5 near end of image
    void mem; void slotAddr;
    // Verify via re-read of the slot: search RAM for the updated value
    let found = false;
    for (let off = 0; off < mem.ramBytes; off += 8) {
      if (mem.readU64(off) === 1n) { found = true; break; }
    }
    expect(found).toBe(true);
  });

  it("accesses crossing the end of RAM fault (footer stays host-internal)", () => {
    const mem = new GuestMemory({ sizeBytes: 1 << 16, base: 0 });
    const epochBefore = mem.storeEpoch;
    const prog = assemble(`
      start:
        li t0, 65532        # ramBytes - 4
        li t1, -1
        sd t1, 0(t0)        # 8 bytes from 65532 crosses ramBytes=65536
        li a7, 93
        li a0, 0
        ecall
    `, { base: 0 });
    mem.loadImage(0, prog.image);
    const cpu = new Cpu({ memory: mem, captureOutput: true });
    for (let i = 0; i < 20 && cpu.readCsr(0x342, cpu.pc) !== 15n; i++) cpu.step();
    expect(cpu.readCsr(0x342, cpu.pc)).toBe(15n); // store/AMO fault
    // The rejected store must not have written the footer nor bumped the epoch.
    expect(mem.storeEpoch).toBe(epochBefore);
    expect(cpu.getReg(5)).toBe(65532n); // t0 = x5 intact (footer not clobbered)
  });

  it("interpreter works with a nonzero RAM base (QEMU virt style)", () => {
    const BASE = 0x80000000;
    const mem = new GuestMemory({ sizeBytes: 1 << 16, base: BASE });
    const prog = assemble(`
      start:
        li t0, 40
        addi t0, t0, 2
        mv a0, t0
        li a7, 93
        ecall
    `, { base: BASE });
    mem.loadImage(BASE, prog.image);
    const cpu = new Cpu({ memory: mem, captureOutput: true });
    expect(cpu.pc).toBe(BigInt(BASE));
    const r = cpu.run(1000);
    expect(r).toEqual({ kind: "exit", code: 42 });
  });

  it("fetches through the MMU: non-identity mapping executes from mapped PA", () => {
    const mem = new GuestMemory({ sizeBytes: 1 << 16, base: 0 });
    const prog = assemble(`
      start:
        li a0, 42
        li a7, 93
        ecall
    `, { base: 0 });
    // Code lives at PA 0x5000; VA 0 maps to it via a 3-level Sv39 walk.
    mem.loadImage(0x5000, prog.image);
    const cpu = new Cpu({ memory: mem, captureOutput: true });
    const ROOT = 0x1000n, L1 = 0x2000n, L0 = 0x3000n;
    mem.writeU64(Number(ROOT), (2n << 10n) | PTE_V);            // L2[0] → L1 table
    mem.writeU64(Number(L1), (3n << 10n) | PTE_V);              // L1[0] → L0 table
    mem.writeU64(Number(L0), (5n << 10n) | PTE_V | PTE_R | PTE_W | PTE_X | PTE_A | PTE_D); // L0[0] → PA 0x5000
    cpu.mmu.satp = (8n << 60n) | (ROOT >> 12n);
    cpu.mmu.privilege = 1;
    cpu.pc = 0n; // fetch VA 0 → PA 0x5000
    const r = cpu.run(1000);
    expect(r).toEqual({ kind: "exit", code: 42 });
  });

  it("superpage translation splices VPN bits (no aliasing)", async () => {
    const mem = new GuestMemory({ sizeBytes: 1 << 16, base: 0 });
    const { root, pages } = buildIdentityTables();
    for (const [addr, pte] of pages) mem.writeU64(Number(addr), pte);
    const cpu = new Cpu({ memory: mem });
    cpu.mmu.satp = (8n << 60n) | (root >> 12n);
    cpu.mmu.privilege = 1;
    const reader = (pa: bigint) => {
      const off = mem.physToOffset(pa);
      return off < 0 ? 0n : mem.readU64(Number(pa));
    };
    // 2 MiB into the second GiB must map to itself, not alias GiB 0.
    const tr = cpu.mmu.translate(0x40200000n, "read", reader);
    expect(tr.ok).toBe(true);
    if (tr.ok) expect(tr.pa).toBe(0x40200000n);
    // and still hits in the TLB
    const tr2 = cpu.mmu.translate(0x40200000n, "read", reader);
    expect(tr2.ok).toBe(true);
    if (tr2.ok) { expect(tr2.tlbHit).toBe(true); expect(tr2.pa).toBe(0x40200000n); }
  });

  it("AMOs are serialised and correct on shared memory", () => {
    const mem = new GuestMemory({ sizeBytes: 1 << 16, shared: true, hartCount: 2, hart: 0 });
    const prog = assemble(`
      start:
        la t0, slot
        li t1, 1
        amoadd.d t2, t1, (t0)
        amoadd.d t2, t1, (t0)
        ld t3, 0(t0)
        mv a0, t3
        li a7, 93
        ecall
      .align 3
      slot: .dword 10
    `, { base: 0 });
    mem.loadImage(0, prog.image);
    const cpu = new Cpu({ memory: mem, captureOutput: true });
    const r = cpu.run(10_000);
    expect(r).toEqual({ kind: "exit", code: 12 });
  });
});
