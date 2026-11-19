/**
 * Spike A benchmark: RV64 interpreter vs JIT-to-Wasm (raw and binaryen-O3).
 * Usage: node dist/src/bench.js [--json out.json]
 */
import { performance } from 'node:perf_hooks';
import { writeFileSync } from 'node:fs';
import os from 'node:os';
import { Machine } from './interpreter.js';
import { compileToWasm, instantiateRegion } from './jit.js';
import { KERNELS, buildKernel, instantiateKernelMemory } from './kernels.js';

interface KernelResult {
  kernel: string;
  description: string;
  instructions: number;
  interpreterMs: number;
  interpreterMIPS: number;
  jitRawMs: number;
  jitO3Ms: number;
  jitRawEffectiveMIPS: number;
  speedupRaw: number;
  speedupO3: number;
  wasmBytesRaw: number;
  wasmBytesO3: number;
  emitMsRaw: number;
  emitMsO3: number;
  instantiateMsRaw: number;
  instantiateMsO3: number;
  blocks: number;
  verifyMatch: boolean;
  a0Interpreter: string;
  a0Jit: string;
}

const JIT_REPS = 50;

async function benchKernel(name: string): Promise<KernelResult> {
  const k = KERNELS.find(x => x.name === name);
  if (!k) throw new Error(`unknown kernel ${name}`);
  const { bytes } = buildKernel(k);
  const memoryBytes = k.memoryBytes;
  const memoryPages = Math.max(1, Math.ceil(memoryBytes / 65536));

  // ---- Interpreter ----
  const memI = instantiateKernelMemory(k, bytes);
  const mach = new Machine(bytes, memoryBytes);
  mach.mem.set(memI);
  const t0 = performance.now();
  const interp = mach.run();
  const interpreterMs = performance.now() - t0;
  const instructions = Number(interp.instructions);

  // ---- JIT raw ----
  const raw = compileToWasm(bytes, { memoryPages, optimize: false });
  const instRaw = await instantiateRegion(raw, memoryPages);
  {
    const mem = instantiateKernelMemory(k, bytes);
    new Uint8Array(instRaw.memory.buffer).set(mem);
  }
  const t1 = performance.now();
  const a0Raw = instRaw.exports.run();
  instRaw.instantiateMilliseconds; // recorded below
  const jitRawFirst = performance.now() - t1;
  void jitRawFirst;
  // timed reps (memory rewritten each time for memcpy determinism)
  let jitRawMs = Infinity;
  for (let r = 0; r < JIT_REPS; r++) {
    const mem = instantiateKernelMemory(k, bytes);
    new Uint8Array(instRaw.memory.buffer).set(mem);
    const t = performance.now();
    instRaw.exports.run();
    const dt = performance.now() - t;
    if (dt < jitRawMs) jitRawMs = dt;
  }

  // ---- JIT O3 ----
  const o3 = compileToWasm(bytes, { memoryPages, optimize: true });
  const instO3 = await instantiateRegion(o3, memoryPages);
  {
    const mem = instantiateKernelMemory(k, bytes);
    new Uint8Array(instO3.memory.buffer).set(mem);
  }
  let jitO3Ms = Infinity;
  for (let r = 0; r < JIT_REPS; r++) {
    const mem = instantiateKernelMemory(k, bytes);
    new Uint8Array(instO3.memory.buffer).set(mem);
    const t = performance.now();
    instO3.exports.run();
    const dt = performance.now() - t;
    if (dt < jitO3Ms) jitO3Ms = dt;
  }
  const a0O3 = (() => {
    const mem = instantiateKernelMemory(k, bytes);
    new Uint8Array(instO3.memory.buffer).set(mem);
    return instO3.exports.run();
  })();

  const verifyMatch = a0Raw === interp.a0 && a0O3 === interp.a0;

  return {
    kernel: k.name,
    description: k.description,
    instructions,
    interpreterMs,
    interpreterMIPS: instructions / (interpreterMs / 1000) / 1e6,
    jitRawMs,
    jitO3Ms,
    jitRawEffectiveMIPS: instructions / (jitRawMs / 1000) / 1e6,
    speedupRaw: interpreterMs / jitRawMs,
    speedupO3: interpreterMs / jitO3Ms,
    wasmBytesRaw: raw.wasmBinary.length,
    wasmBytesO3: o3.wasmBinary.length,
    emitMsRaw: raw.emitMilliseconds,
    emitMsO3: o3.emitMilliseconds,
    instantiateMsRaw: instRaw.instantiateMilliseconds,
    instantiateMsO3: instO3.instantiateMilliseconds,
    blocks: raw.blockCount,
    verifyMatch,
    a0Interpreter: interp.a0.toString(),
    a0Jit: a0Raw.toString(),
  };
}

async function main(): Promise<void> {
  const jsonIdx = process.argv.indexOf('--json');
  const results: KernelResult[] = [];
  for (const k of KERNELS) {
    process.stderr.write(`benchmarking ${k.name}...\n`);
    results.push(await benchKernel(k.name));
  }
  const report = {
    benchmark: 'wasmnux-spike-a-jit',
    version: 1,
    timestamp: new Date().toISOString(),
    host: { cpus: os.cpus().length, model: os.cpus()[0]?.model ?? 'unknown', platform: process.platform, release: os.release() },
    note: 'Effective JIT MIPS uses the interpreter\'s dynamic instruction count for the same input. JIT time = best-of-%d runs.'.replace('%d', String(JIT_REPS)),
    results,
  };
  const json = JSON.stringify(report, null, 2);
  if (jsonIdx >= 0 && process.argv[jsonIdx + 1]) {
    writeFileSync(process.argv[jsonIdx + 1]!, json);
  }
  console.log(json);
}

main().catch(err => { console.error(err); process.exit(1); });
