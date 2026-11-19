import { describe, expect, it } from "vitest";
import { assemble } from "../src/isa/assembler.js";
import { decode, decodeAt, isTerminator, type Op } from "../src/isa/decoder.js";

function wordOf(src: string): number {
  const { image } = assemble(src);
  return new DataView(image.buffer, image.byteOffset).getUint32(0, true);
}

describe("decoder", () => {
  it("decodes known RV64 encodings", () => {
    // addi a0, zero, 42
    expect(wordOf("addi a0, zero, 42")).toBe(0x02a00513);
    expect(decode(0x02a00513)).toMatchObject({ op: "addi", rd: 10, rs1: 0, imm: 42n });

    // ret = jalr zero, 0(ra)
    expect(wordOf("ret")).toBe(0x00008067);

    // ecall
    expect(wordOf("ecall")).toBe(0x00000073);

    // nop = addi zero, zero, 0
    expect(decode(wordOf("nop")).op).toBe("addi");

    // add a0, a1, a2
    const add = decode(wordOf("add a0, a1, a2"));
    expect(add).toMatchObject({ op: "add", rd: 10, rs1: 11, rs2: 12 });
  });

  it("decodes every mnemonic the assembler emits to a non-illegal op", () => {
    const mnemonics = [
      "lui a0, 0x1", "auipc a0, 0x2", "jal ra, 1f", "jalr ra, a0, 8",
      "beq a0, a1, 1f", "bne a0, a1, 1f", "blt a0, a1, 1f", "bge a0, a1, 1f",
      "bltu a0, a1, 1f", "bgeu a0, a1, 1f",
      "lb a0, 0(a1)", "lh a0, 0(a1)", "lw a0, 0(a1)", "ld a0, 0(a1)",
      "lbu a0, 0(a1)", "lhu a0, 0(a1)", "lwu a0, 0(a1)",
      "sb a0, 0(a1)", "sh a0, 0(a1)", "sw a0, 0(a1)", "sd a0, 0(a1)",
      "addi a0, a1, 1", "slti a0, a1, 1", "sltiu a0, a1, 1", "xori a0, a1, 1",
      "ori a0, a1, 1", "andi a0, a1, 1", "slli a0, a1, 3", "srli a0, a1, 3",
      "srai a0, a1, 3",
      "add a0, a1, a2", "sub a0, a1, a2", "sll a0, a1, a2", "slt a0, a1, a2",
      "sltu a0, a1, a2", "xor a0, a1, a2", "srl a0, a1, a2", "sra a0, a1, a2",
      "or a0, a1, a2", "and a0, a1, a2",
      "mul a0, a1, a2", "mulh a0, a1, a2", "mulhsu a0, a1, a2", "mulhu a0, a1, a2",
      "div a0, a1, a2", "divu a0, a1, a2", "rem a0, a1, a2", "remu a0, a1, a2",
      "csrrs a0, 0x300, a1", "csrrwi a0, 0x300, 3",
      "lr.w a0, (a1)", "sc.w a0, a2, (a1)", "amoadd.w a0, a2, (a1)",
      "amoadd.d a0, a2, (a1)", "amoswap.w a0, a2, (a1)", "amomax.d a0, a2, (a1)",
      "ecall", "ebreak", "mret", "wfi", "fence", "fence.i", "sfence.vma",
      "1: nop",
    ];
    for (const m of mnemonics) {
      const { image } = assemble(`${m}\n1: nop`);
      expect(image.byteLength).toBeGreaterThan(0);
      const insn = decodeAt(image, 0);
      expect(insn.op, `mnemonic: ${m}`).not.toBe("illegal");
      expect(insn.len).toBe(4);
    }
  });

  it("decodes negative immediates with correct sign extension", () => {
    const i = decode(wordOf("addi a0, a1, -1"));
    expect(i.imm).toBe(-1n);
    const s = decode(wordOf("sw a0, -4(sp)"));
    expect(s.imm).toBe(-4n);
    expect(s.op).toBe("sw");
  });

  it("classifies terminators vs slow-path ops", () => {
    expect(isTerminator("jal" as Op)).toBe(true);
    expect(isTerminator("beq" as Op)).toBe(true);
    expect(isTerminator("add" as Op)).toBe(false);
    expect(isTerminator("csrrw" as Op)).toBe(true);
    expect(isTerminator("amoadd_d" as Op)).toBe(true);
    expect(isTerminator("illegal" as Op)).toBe(true);
  });

  it("flags garbage words as illegal", () => {
    expect(decode(0x00000000).op).toBe("illegal");
    expect(decode(0xffffffff).op).toBe("illegal");
    expect(decode(0x0000007f).op).toBe("illegal"); // opcode 0x7f unknown
  });
});

describe("decoder — sfence.vma operand forms (Codex)", () => {
  const SFENCE = 0x12000073; // funct7=0001001, rd=rs1=rs2=0
  it("accepts nonzero rs1 (address) and rs2 (ASID)", () => {
    const withOps = (SFENCE | (5 << 15) | (3 << 20)) >>> 0; // rs1=5, rs2=3, rd=0
    const insn = decode(withOps);
    expect(insn.op).toBe("sfence_vma");
    expect(insn.rs1).toBe(5);
    expect(insn.rs2).toBe(3);
  });
  it("still accepts the all-zero form", () => {
    expect(decode(SFENCE).op).toBe("sfence_vma");
  });
  it("rejects a nonzero rd", () => {
    const bad = SFENCE | (7 << 7);
    expect(decode(bad).op).toBe("illegal");
  });
});
