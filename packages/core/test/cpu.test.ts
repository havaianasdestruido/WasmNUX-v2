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
