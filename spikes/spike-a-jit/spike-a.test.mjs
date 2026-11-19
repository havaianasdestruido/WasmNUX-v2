import test from "node:test";
import assert from "node:assert/strict";
import { Rv64Interpreter, addi, add, sub, bne, blt, ecall } from "./rv64i.mjs";
import { compileRv64ToWasm } from "./wasm-jit.mjs";
import { runSpikeA } from "./bench.mjs";

test("Spike A: RV64I interpreter and Wasm JIT produce identical results", () => {
  const program = [
    addi(10, 0, 0),   // x10 = 0
    addi(11, 0, 1),   // x11 = 1
    addi(12, 0, 11),  // x12 = 11
    add(10, 10, 11),  // x10 += x11
    addi(11, 11, 1),  // x11 += 1
    blt(11, 12, -8),  // if x11 < 11 goto loop
    ecall(),
  ];

  const interp = new Rv64Interpreter();
  interp.run(program);
  assert.equal(interp.regs[10], 55n);

  const jit = compileRv64ToWasm(program);
  const jitResult = jit.run();
  assert.equal(jitResult, 55n);
});

test("Spike A: sub and bne work in interpreter", () => {
  const program = [
    addi(10, 0, 10),
    addi(11, 0, 3),
    sub(10, 10, 11),
    addi(11, 11, -1),
    bne(11, 0, -8),
    ecall(),
  ];
  const interp = new Rv64Interpreter();
  interp.run(program);
  assert.equal(interp.regs[10], 4n); // 10 - 3 - 2 - 1 = 4
});

test("Spike A: JIT benchmark shows speedup over interpreter", () => {
  const res = runSpikeA();
  assert.equal(res.interpRes, res.jitRes);
  assert.ok(res.speedup > 1, `Expected JIT speedup > 1, got ${res.speedup}`);
});
