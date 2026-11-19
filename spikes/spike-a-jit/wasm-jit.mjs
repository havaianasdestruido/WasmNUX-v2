// Minimal RV64I -> WebAssembly binary JIT compiler for Spike A
// Emits a valid Wasm module that executes a register-mapped RV64I program
// directly in V8/TurboFan using i64 locals and structured control flow.

import { OP_IMM, OP, BRANCH, SYSTEM } from "./rv64i.mjs";

function encodeULEB128(value) {
  const bytes = [];
  let v = value >>> 0;
  do {
    let byte = v & 0x7f;
    v >>>= 7;
    if (v !== 0) byte |= 0x80;
    bytes.push(byte);
  } while (v !== 0);
  return bytes;
}

function encodeSLEB128(value) {
  const bytes = [];
  let v = BigInt(value);
  let more = true;
  while (more) {
    let byte = Number(v & 0x7fn);
    v >>= 7n;
    if ((v === 0n && (byte & 0x40) === 0) || (v === -1n && (byte & 0x40) !== 0)) {
      more = false;
    } else {
      byte |= 0x80;
    }
    bytes.push(byte);
  }
  return bytes;
}

function section(id, payload) {
  return [id, ...encodeULEB128(payload.length), ...payload];
}

function signExtend12(val) {
  return (val << 20) >> 20;
}

function signExtend13(val) {
  return (val << 19) >> 19;
}

export function compileRv64ToWasm(program) {
  // Wasm function signature: () -> i64 (returns x10 / a0)
  // Locals: 32 x i64 (representing x0..x31)
  const body = [];

  // Local declarations: 1 group of 32 i64s (0x7e)
  body.push(1, ...encodeULEB128(32), 0x7e);

  // Detect simple backward branch loops for structured Wasm `loop` emission
  let loopStartIdx = -1;
  let loopEndIdx = -1;
  for (let i = 0; i < program.length; i++) {
    const insn = program[i];
    if ((insn & 0x7f) === BRANCH) {
      const b12 = (insn >>> 31) & 1;
      const b10_5 = (insn >>> 25) & 0x3f;
      const b4_1 = (insn >>> 8) & 0xf;
      const b11 = (insn >>> 7) & 1;
      const imm = signExtend13((b12 << 12) | (b11 << 11) | (b10_5 << 5) | (b4_1 << 1));
      if (imm < 0) {
        loopStartIdx = i + (imm >> 2);
        loopEndIdx = i;
        break;
      }
    }
  }

  for (let i = 0; i < program.length; i++) {
    if (i === loopStartIdx) {
      body.push(0x03, 0x40); // loop (void)
    }

    const insn = program[i];
    const opcode = insn & 0x7f;
    const rd = (insn >>> 7) & 0x1f;
    const funct3 = (insn >>> 12) & 0x7;
    const rs1 = (insn >>> 15) & 0x1f;
    const rs2 = (insn >>> 20) & 0x1f;
    const funct7 = (insn >>> 25) & 0x7f;

    if (opcode === OP_IMM && funct3 === 0x0) {
      const imm = signExtend12((insn >>> 20) & 0xfff);
      if (rd !== 0) {
        body.push(0x20, ...encodeULEB128(rs1)); // local.get rs1
        body.push(0x42, ...encodeSLEB128(imm)); // i64.const imm
        body.push(0x7c); // i64.add
        body.push(0x21, ...encodeULEB128(rd)); // local.set rd
      }
    } else if (opcode === OP && funct3 === 0x0) {
      if (rd !== 0) {
        body.push(0x20, ...encodeULEB128(rs1)); // local.get rs1
        body.push(0x20, ...encodeULEB128(rs2)); // local.get rs2
        body.push(funct7 === 0x20 ? 0x7d : 0x7c); // i64.sub or i64.add
        body.push(0x21, ...encodeULEB128(rd)); // local.set rd
      }
    } else if (opcode === BRANCH && i === loopEndIdx) {
      body.push(0x20, ...encodeULEB128(rs1)); // local.get rs1
      body.push(0x20, ...encodeULEB128(rs2)); // local.get rs2
      body.push(funct3 === 0x1 ? 0x52 : 0x53); // i64.ne or i64.lt_s
      body.push(0x0d, 0x00); // br_if 0 (branch to loop)
      body.push(0x0b); // end loop
    } else if (opcode === SYSTEM) {
      break;
    } else {
      throw new Error(`JIT unsupported opcode 0x${opcode.toString(16)} at idx=${i}`);
    }
  }

  // Return x10 (a0)
  body.push(0x20, ...encodeULEB128(10)); // local.get 10
  body.push(0x0b); // end function

  const typeSection = section(1, [
    1, // 1 type
    0x60, 0, 1, 0x7e, // () -> i64
  ]);
  const funcSection = section(3, [
    1, // 1 function
    0, // type index 0
  ]);
  const exportSection = section(7, [
    1, // 1 export
    3, 0x72, 0x75, 0x6e, // "run"
    0x00, 0, // func index 0
  ]);
  const codeSection = section(10, [
    1, // 1 body
    ...encodeULEB128(body.length),
    ...body,
  ]);

  const wasmBytes = new Uint8Array([
    0x00, 0x61, 0x73, 0x6d, // magic
    0x01, 0x00, 0x00, 0x00, // version
    ...typeSection,
    ...funcSection,
    ...exportSection,
    ...codeSection,
  ]);

  const mod = new WebAssembly.Module(wasmBytes);
  const instance = new WebAssembly.Instance(mod);
  return {
    wasmBytes,
    run: instance.exports.run,
  };
}
