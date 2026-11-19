import { performance } from "node:perf_hooks";
import { Rv64Interpreter, addi, add, blt, ecall } from "./rv64i.mjs";
import { compileRv64ToWasm } from "./wasm-jit.mjs";

export function buildLoopProgram(iterations = 1_000_000) {
  // x10 (a0) = accumulator = 0
  // x11 (a1) = counter = 0
  // x12 (a2) = limit
  // Build limit using addi in chunks of 2047 if needed, or simple loop
  const insns = [
    addi(10, 0, 0), // a0 = 0
    addi(11, 0, 0), // a1 = 0
    addi(12, 0, 1000), // a2 = 1000 (outer)
  ];
  // Actually for 1_000_000 in 12-bit imm, let's just use 1000 * 1000?
  // Simpler: pass small iterations for interpreter, or 2000 for both and scale,
  // or build 100_000 via shifts? We don't have slli in minimal subset yet.
  // Let's use 2000 iterations * 100 runs, or add 2000 in a loop.
  // With 2000 iterations: 3 insns per iter = 6000 insns.
  const limit = Math.min(iterations, 2000);
  insns[2] = addi(12, 0, limit);
  // loop:
  //   a0 = a0 + a1
  //   a1 = a1 + 1
  //   if (a1 < a2) goto loop (-8 bytes)
  insns.push(add(10, 10, 11));
  insns.push(addi(11, 11, 1));
  insns.push(blt(11, 12, -8));
  insns.push(ecall());
  return { insns, limit };
}

export function runSpikeA() {
  const { insns, limit } = buildLoopProgram(2000);
  const interp = new Rv64Interpreter();

  const rounds = 500;
  const t0 = performance.now();
  let interpRes = 0n;
  for (let r = 0; r < rounds; r++) {
    interp.run(insns);
    interpRes = interp.regs[10];
  }
  const interpMs = performance.now() - t0;
  const totalInsns = rounds * (3 + limit * 3);
  const interpMips = totalInsns / (interpMs * 1000);

  const tCompile0 = performance.now();
  const jit = compileRv64ToWasm(insns);
  const compileMs = performance.now() - tCompile0;

  // Warmup
  for (let r = 0; r < 50; r++) jit.run();

  const t1 = performance.now();
  let jitRes = 0n;
  for (let r = 0; r < rounds; r++) {
    jitRes = jit.run();
  }
  const jitMs = performance.now() - t1;
  const jitMips = totalInsns / (jitMs * 1000);

  return {
    interpRes: interpRes.toString(),
    jitRes: jitRes.toString(),
    interpMs: Number(interpMs.toFixed(3)),
    jitMs: Number(jitMs.toFixed(3)),
    compileMs: Number(compileMs.toFixed(3)),
    interpMips: Number(interpMips.toFixed(2)),
    jitMips: Number(jitMips.toFixed(2)),
    speedup: Number((interpMs / Math.max(jitMs, 0.001)).toFixed(2)),
    wasmBytes: jit.wasmBytes.length,
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  console.log("Spike A (RV64I -> Wasm JIT):", JSON.stringify(runSpikeA(), null, 2));
}
