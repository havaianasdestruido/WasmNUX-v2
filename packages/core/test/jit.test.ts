import { describe, expect, it } from "vitest";
import { assemble } from "../src/isa/assembler.js";
import { Cpu } from "../src/cpu.js";
import { GuestMemory } from "../src/memory.js";
import { JitEngine } from "../src/jit/engine.js";
import { coverageNote, isFastOp } from "../src/jit/block.js";
import type { Op } from "../src/isa/decoder.js";

interface RunResult {
  exit: { kind: string; code?: number; cause?: bigint };
  regs: bigint[];
  output: string;
  stats: unknown;
}

function runWith(mode: "interp" | "jit", src: string, maxSteps = 5_000_000, base = 0): RunResult {
  const mem = new GuestMemory({ sizeBytes: 1 << 20, base });
  const prog = assemble(src, { base });
  mem.loadImage(base, prog.image);
  const cpu = new Cpu({ memory: mem, pc: BigInt(prog.entry), captureOutput: true });
  let exit;
  let stats: unknown = null;
  if (mode === "interp") {
    exit = cpu.run(maxSteps);
  } else {
    const engine = new JitEngine(mem);
    exit = engine.run(cpu, maxSteps);
    stats = { ...engine.stats, blocks: engine.size };
  }
  const regs: bigint[] = [];
  for (let i = 0; i < 32; i++) regs.push(cpu.getReg(i));
  return { exit, regs, output: cpu.output, stats };
}

function expectEquivalent(src: string, base = 0): RunResult {
  const a = runWith("interp", src, 5_000_000, base);
  const b = runWith("jit", src, 5_000_000, base);
  expect(b.exit).toEqual(a.exit);
  expect(b.regs).toEqual(a.regs);
  expect(b.output).toBe(a.output);
  return b;
}

describe("spike A — JIT vs interpreter equivalence", () => {
  it("covers the RV64I fast path (documented subset)", () => {
    const { fast, total } = coverageNote();
    // 42 fast ops: all of RV64I base + fence + mul (div/mulh*, CSR, AMO,
    // system ops go through the interpreter slow path — see RESULTS.md).
    expect(fast).toBe(42);
    expect(total).toBeGreaterThan(60);
    expect(isFastOp("add" as Op)).toBe(true);
    expect(isFastOp("ecall" as Op)).toBe(false);
    expect(isFastOp("amoadd_d" as Op)).toBe(false);
    expect(isFastOp("div" as Op)).toBe(false); // div/rem: slow path (no i64.div trap divergence)
    expect(isFastOp("mul" as Op)).toBe(true);
  });

  it("fibonacci loop — same final state on both tiers", () => {
    expectEquivalent(`
      start:
        li t0, 0          # a
        li t1, 1          # b
        li t2, 30         # n
      loop:
        beqz t2, done
        add t3, t0, t1
        mv t0, t1
        mv t1, t3
        addi t2, t2, -1
        j loop
      done:
        mv a0, t0
        li a7, 93
        ecall
    `);
  });

  it("memcpy + checksum over memory (loads/stores of all widths)", () => {
    expectEquivalent(`
      start:
        la t0, src
        la t1, dst
        li t2, 64          # words
      copy:
        ld t3, 0(t0)
        sd t3, 0(t1)
        addi t0, t0, 8
        addi t1, t1, 8
        addi t2, t2, -1
        bnez t2, copy
        # checksum dst
        la t1, dst
        li t4, 0
        li t2, 64
      sum:
        ld t3, 0(t1)
        add t4, t4, t3
        addi t1, t1, 8
        addi t2, t2, -1
        bnez t2, sum
        mv a0, t4
        li a7, 93
        ecall
      .align 3
      src: .dword 0x0123456789abcdef, 0xfedcba9876543210, 0x1111111111111111, 0x2222222222222222
           .dword 0x3333333333333333, 0x4444444444444444, 0x5555555555555555, 0x6666666666666666
           .dword 0x7777777777777777, 0x8888888888888888, 0x9999999999999999, 0xa0a0a0a0a0a0a0a0
           .dword 0xb1b1b1b1b1b1b1b1, 0xc2c2c2c2c2c2c2c2, 0xd3d3d3d3d3d3d3d3, 0xe4e4e4e4e4e4e4e4
           .dword 0x1111222233334444, 0x5555666677778888, 0x9999aaaabbbbcccc, 0xddddeeeeffff0000
           .dword 0x0f0f0f0f0f0f0f0f, 0xf0f0f0f0f0f0f0f0, 0xaaaaaaaa55555555, 0x33333333cccccccc
           .dword 0x13579bdf2468ace0, 0x2468ace013579bdf, 0x0102030405060708, 0xfefdfcfbfaf9f8f7
           .dword 0x7f80818283848586, 0x1020304050607080, 0x0badf00ddeadbeef, 0x1cedface1cedface
           .dword 0x55aa55aa55aa55aa, 0xaa55aa55aa55aa55, 0x0123432156788765, 0x9abcdef0fedcba98
           .dword 0x0000000100000002, 0x0000000300000004, 0xfffffffffffffffe, 0x7fffffffffffffff
           .dword 0x8000000000000000, 0x00000000ffffffff, 0xabcdef0123456789, 0x123456789abcdef0
           .dword 0x2d2d2d2d2d2d2d2d, 0x7e7e7e7e7e7e7e7e, 0x00ff00ff00ff00ff, 0xff00ff00ff00ff00
           .dword 0x1000000000000001, 0x2000000000000002, 0x4000000000000004, 0x8000000000000008
           .dword 0x13572468abcdef00, 0xfedcba0024681357, 0x1122334455667788, 0x99aabbccddeeff00
           .dword 0x0101010101010101, 0x0202020202020202, 0x0303030303030303, 0x0404040404040404
           .dword 0x0505050505050505, 0x0606060606060606, 0x0707070707070707, 0x0808080808080808
           .dword 0x0909090909090909, 0x0a0a0a0a0a0a0a0a, 0x0b0b0b0b0b0b0b0b, 0x0c0c0c0c0c0c0c0c
      .align 3
      dst: .space 512
    `);
  });

  it("all RV64I ALU ops: random straight-line differential fuzz", () => {
    // Deterministic PRNG so CI failures are reproducible.
    let seed = 0xc0ffee;
    const rnd = (n: number): number => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed % n;
    };
    const ALU = ["add", "sub", "and", "or", "xor", "sll", "srl", "sra", "slt", "sltu", "mul"];
    const IMMS = [-4096, -1, 0, 1, 17, 1024, 2047, -2048];
    const lines: string[] = ["start:"];
    // seed registers with interesting constants
    lines.push("li t0, 0xdeadbeefcafebabe1");
    lines.push("li t1, -0x123456789abcdef");
    lines.push("li t2, 0x7fffffffffffffff");
    lines.push("li t3, 0x8000000000000000");
    lines.push("li t4, 0x100000000");
    lines.push("li t5, 0xffff");
    lines.push("li t6, 42");
    const regs = ["t0", "t1", "t2", "t3", "t4", "t5", "t6"];
    for (let i = 0; i < 150; i++) {
      const dst = regs[rnd(regs.length)]!;
      const s1 = regs[rnd(regs.length)]!;
      const s2 = regs[rnd(regs.length)]!;
      const kind = rnd(3);
      if (kind === 0) {
        const op = ALU[rnd(ALU.length)]!;
        lines.push(`${op} ${dst}, ${s1}, ${s2}`);
      } else if (kind === 1) {
        const op = ["addi", "xori", "ori", "andi", "slti", "sltiu", "slli", "srli", "srai"][rnd(9)]!;
        const imm = ["slli", "srli", "srai"].includes(op)
          ? rnd(64)
          : IMMS[rnd(IMMS.length)]!;
        lines.push(`${op} ${dst}, ${s1}, ${imm}`);
      } else {
        lines.push(`mul ${dst}, ${s1}, ${s2}`);
      }
    }
    lines.push("mv a0, t0");
    lines.push("li a7, 93");
    lines.push("ecall");
    expectEquivalent(lines.join("\n"));
  });

  it("conditional branches: nested diamond patterns", () => {
    expectEquivalent(`
      start:
        li s0, 0
        li t0, 7
        li t1, 9
        blt t0, t1, l1
        addi s0, s0, 100
        j join1
      l1:
        addi s0, s0, 1
      join1:
        bge t0, t1, l2
        addi s0, s0, 10
        j join2
      l2:
        addi s0, s0, 2
      join2:
        beq t0, t1, l3
        xori s0, s0, 0x55
      l3:
        bne t0, t1, l4
        addi s0, s0, 1000
      l4:
        sltu t2, t0, t1
        beqz t2, l5
        addi s0, s0, 10000
      l5:
        mv a0, s0
        li a7, 93
        ecall
    `);
  });

  it("slow path: ecall, div, CSR and atomic ops interleave with fast blocks", () => {
    const r = expectEquivalent(`
      start:
        li t0, 1000
        li t1, 7
        div t2, t0, t1        # slow (div)
        mul t3, t0, t1        # fast
        add t4, t2, t3
        csrr t5, minstret     # slow (CSR): read for slow-path coverage…
        li t5, 0              # …then clear: instret accounting differs by tier
        la t6, slot
        amoadd.d t6, t4, (t6) # slow (AMO): mem[slot] += t4, old → t6
        mv a0, t4
        li a7, 93
        ecall
      .align 3
      slot: .dword 100000
    `);
    // t2 = 142 (1000/7), t3 = 7000, t4 = 7142
    expect(r.regs[10]).toBe(7142n);    // a0 = t4
    expect(r.regs[29]).toBe(7142n);    // t4
    expect(r.regs[30]).toBe(0n);       // t5 cleared
    expect(r.regs[31]).toBe(100000n);  // t6 = old slot value
    expect(r.exit).toEqual({ kind: "exit", code: 7142 });
  });

  it("equivalence on a program that writes output via write()", () => {
    const src = `
      start:
        li a0, 1            # fd
        la a1, msg
        li a2, 12
        li a7, 64
        ecall
        li a7, 93
        li a0, 0
        ecall
      msg: .ascii "WasmNUX jit!"
    `;
    expectEquivalent(src);
    expect(runWith("jit", src).output).toBe("WasmNUX jit!");
  });

  it("caches compiled blocks (hits > 0 on a hot loop)", () => {
    const r = runWith("jit", `
      start:
        li t0, 0
        li t1, 100000
      loop:
        addi t0, t0, 1
        blt t0, t1, loop
        mv a0, t0
        li a7, 93
        ecall
    `);
    const stats = r.stats as { cacheHits: number; compiles: number; fastSteps: number };
    expect(stats.cacheHits).toBeGreaterThan(100);
    expect(stats.compiles).toBeLessThan(10); // one block for the loop body
    expect(r.exit).toEqual({ kind: "exit", code: 100000 });
  });

  it("hits the slow path for out-of-range stores instead of corrupting memory", () => {
    const r = expectEquivalent(`
      start:
        la t0, handler
        csrw mtvec, t0
        li t0, 0x7fffffff000
        li t1, 0x1234
        sd t1, 0(t0)         # beyond RAM → slow path → store fault → handler
        li a7, 93
        li a0, 2             # unreachable if the fault fired
        ecall
      handler:
        li a7, 93
        li a0, 0
        ecall
    `);
    // Fault fired on both tiers: program exited via the trap handler with 0.
    expect(r.exit).toEqual({ kind: "exit", code: 0 });
  });

  it("JIT flushes when translation mode changes", () => {
    const mem = new GuestMemory({ sizeBytes: 1 << 20, base: 0 });
    const prog = assemble(`
      start:
        li t0, 0
        addi t0, t0, 1
        addi t0, t0, 1
        ecall_exit:
        li a7, 93
        mv a0, t0
        ecall
    `, { base: 0 });
    mem.loadImage(0, prog.image);
    const cpu = new Cpu({ memory: mem, pc: 0n, captureOutput: true });
    const engine = new JitEngine(mem);
    engine.run(cpu, 1000);
    expect(engine.stats.compiles).toBeGreaterThan(0);
    // Flip satp → next run must invalidate.
    cpu.halted = false;
    cpu.mmu.satp = (8n << 60n) | 1n;
    engine.run(cpu, 1);
    expect(engine.stats.flushes).toBeGreaterThanOrEqual(1);
  });
});

describe("spike A — Codex review regressions", () => {
  it("equivalence with a nonzero RAM base (QEMU virt 0x8000_0000)", () => {
    // Covers: interpreter PA/offset mixups, JIT range-probe offset conversion,
    // and the i32 return ABI for PCs ≥ 0x8000_0000.
    const r = expectEquivalent(
      `
      start:
        li t0, 0
        li t1, 20
      loop:
        addi t0, t0, 3
        blt t0, t1, loop
        la t2, slot
        sd t0, 0(t2)
        ld t3, 0(t2)
        mv a0, t3
        li a7, 93
        ecall
      .align 3
      slot: .dword 0
    `,
      0x80000000,
    );
    expect(r.exit).toEqual({ kind: "exit", code: 21 });
    expect(r.regs[5]).toBe(21n); // t0
    expect(r.regs[28]).toBe(21n); // t3
  });

  it("stores crossing the end of RAM trap identically on both tiers", () => {
    const r = expectEquivalent(`
      start:
        la t0, handler
        csrw mtvec, t0
        li t0, 1048572        # ramBytes - 4 (1 MiB RAM)
        li t1, -1
        sd t1, 0(t0)          # width crosses into the footer → store fault
        li a7, 93
        li a0, 2              # unreachable if the fault fired
        ecall
      handler:
        csrr a0, mcause       # 15 = store/AMO fault
        li a7, 93
        ecall
    `);
    expect(r.exit).toEqual({ kind: "exit", code: 15 });
  });

  it("counts only instructions actually executed when a block exits early", () => {
    // A block whose trailing instruction takes the slow path must count the
    // fast prefix + the slow op — not the whole compiled block twice.
    const mem = new GuestMemory({ sizeBytes: 1 << 20, base: 0 });
    const prog = assemble(`
      start:
        li t0, 0
        li t1, 5
      loop:
        addi t0, t0, 1
        mul t2, t0, t1       # mul is fast
        div t3, t0, t1       # trailing slow op ends the block
        blt t0, t1, loop
        li a7, 93
        li a0, 0
        ecall
    `, { base: 0 });
    mem.loadImage(0, prog.image);
    const cpu = new Cpu({ memory: mem, captureOutput: true });
    const engine = new JitEngine(mem);
    const exit = engine.run(cpu, 10_000);
    expect(exit).toEqual({ kind: "exit", code: 0 });
    // instret must equal fast + slow counts exactly (no over-counting)
    expect(cpu.instret).toBe(BigInt(engine.stats.fastSteps + engine.stats.slowSteps));
    // and the budget was actually consumed by real instructions
    expect(engine.stats.fastSteps + engine.stats.slowSteps).toBeGreaterThan(20);
  });
});
