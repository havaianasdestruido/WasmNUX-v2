import { describe, expect, it } from "vitest";
import { AsmError, assemble, materialize64 } from "../src/isa/assembler.js";
import { decodeAt } from "../src/isa/decoder.js";
import { Cpu } from "../src/cpu.js";
import { GuestMemory } from "../src/memory.js";

function run(src: string, maxSteps = 1_000_000): Cpu {
  const mem = new GuestMemory({ sizeBytes: 1 << 20, base: 0 });
  const prog = assemble(src, { base: 0 });
  mem.loadImage(0, prog.image);
  const cpu = new Cpu({ memory: mem, pc: BigInt(prog.entry), captureOutput: true });
  cpu.run(maxSteps);
  return cpu;
}

describe("assembler", () => {
  it("emits and labels resolve for forward/backward branches", () => {
    const { image, labels } = assemble(`
      start:
        li a0, 0
      loop:
        addi a0, a0, 1
        li t0, 5
        blt a0, t0, loop
        ecall
    `);
    expect(image.byteLength).toBeGreaterThan(0);
    expect(labels["loop"]).toBeGreaterThan(0);
    const insn = decodeAt(image, labels["loop"]!);
    expect(insn.op).not.toBe("illegal");
  });

  it("li materializes boundary constants correctly (executed)", () => {
    const cases: Array<[bigint, number]> = [
      [0n, 18],
      [1n, 19],
      [-1n, 20],
      [2047n, 21],
      [-2048n, 22],
      [0x7fffffffn, 23],
      [-0x80000000n, 24],
      [0xffffffffn, 25],
      [0x1234_5678_9abc_def0n, 26],
      [0x8000_0000_0000_0000n, 27],
      [0xdead_beef_0123_4567n, 28],
      [0x7ffff800n, 29], // lui+addi gap (falls back to chunked materialization)
      [-0x7ffff801n, 30],
    ];
    for (const [value, rd] of cases) {
      const cpu = run(`
        li x${rd}, ${value.toString()}
        li a7, 93
        li a0, 0
        ecall
      `);
      expect(cpu.halted).toBe(true);
      expect(cpu.getReg(rd)).toBe(BigInt.asUintN(64, value));
    }
  });

  it("materialize64 only touches rd", () => {
    const words = materialize64(10, 0xdead_beef_cafe_babe1n);
    // Every emitted instruction must have rd = x10.
    const pc = 0;
    while (pc * 4 < 0 && words.length) break;
    for (let i = 0; i < words.length; i++) {
      const insn = decodeAt(Uint8Array.from([
        words[i]! & 0xff, (words[i]! >>> 8) & 0xff,
        (words[i]! >>> 16) & 0xff, (words[i]! >>> 24) & 0xff,
      ]), 0);
      expect(insn.rd, `word ${i}`).toBe(10);
      expect(insn.op).not.toBe("illegal");
    }
  });

  it("supports data directives and memory operands", () => {
    const cpu = run(`
      .data
      msg: .asciiz "hi\\n"
      .text
      start:
        li a0, 1
        la a1, msg
        li a2, 3
        li a7, 64
        ecall
        li a7, 93
        li a0, 0
        ecall
    `);
    expect(cpu.output).toBe("hi\n");
  });

  it("errors on unknown mnemonics and undefined labels", () => {
    expect(() => assemble("frobnicate a0, a1")).toThrow(AsmError);
    expect(() => assemble("j nowhere")).toThrow(/undefined label/);
  });

  it("assembles to deterministic bytes", () => {
    const src = "start: li a0, 5; ret";
    const a = assemble(src.replace(/;/g, "\n"));
    const b = assemble(src.replace(/;/g, "\n"));
    expect([...a.image]).toEqual([...b.image]);
  });
});
