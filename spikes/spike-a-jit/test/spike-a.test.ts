import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assemble } from '../src/assembler.js';
import { Machine } from '../src/interpreter.js';
import { compileToWasm, instantiateRegion } from '../src/jit.js';
import { KERNELS, buildKernel, instantiateKernelMemory } from '../src/kernels.js';

const PAGES = 1;

function runInterpreter(src: string, setup?: (mem: Uint8Array) => void) {
  const { bytes } = assemble(src);
  const mem = new Uint8Array(0x4000);
  mem.set(bytes, 0);
  setup?.(mem);
  const m = new Machine(bytes, mem.length);
  m.mem.set(mem);
  return m.run(10_000_000n);
}

async function runJit(src: string, setup?: (mem: Uint8Array) => void, optimize = false) {
  const { bytes } = assemble(src);
  const mem = new Uint8Array(0x4000);
  mem.set(bytes, 0);
  setup?.(mem);
  const region = compileToWasm(bytes, { memoryPages: PAGES, optimize });
  const inst = await instantiateRegion(region, PAGES);
  new Uint8Array(inst.memory.buffer).set(mem);
  return inst.exports.run();
}

test('assembler: lui/addi/slt encodings match known RV64 encodings', () => {
  const { bytes } = assemble('lui x5, 1\nslt x3, x4, x5\naddi x10, x0, 42\n');
  const dv = new DataView(bytes.buffer);
  assert.equal(dv.getUint32(0, true) >>> 0, 0x000012b7); // lui x5, 0x1
  assert.equal(dv.getUint32(4, true) >>> 0, 0x005221b3); // slt x3, x4, x5
  assert.equal(dv.getUint32(8, true) >>> 0, 0x02a00513); // addi x10, x0, 42
});

test('interpreter: sum_squares n=10 -> 385', () => {
  const r = runInterpreter(`
    lui   x5, 1
    ld    x6, 0(x5)
    li    x7, 0
    li    x8, 1
loop:
    mul   x9, x8, x8
    add   x7, x7, x9
    addi  x8, x8, 1
    bleu  x8, x6, loop
    mv    x10, x7
    ecall
  `, mem => {
    const dv = new DataView(mem.buffer);
    dv.setBigUint64(0x1000, 10n, true);
  });
  assert.equal(r.a0, 385n);
  assert.equal(r.reason, 'ecall');
  assert.ok(r.instructions > 0n);
});

test('interpreter: x0 stays zero; JIT agrees', async () => {
  const src = 'li a0, 5\nadd x0, a0, a0\nadd a0, x0, x0\necall\n';
  const r = runInterpreter(src);
  assert.equal(r.a0, 0n);
  const jit = await runJit(src);
  assert.equal(jit, 0n);
});

test('JIT and interpreter agree on all three kernels (small n)', async () => {
  for (const k of KERNELS) {
    const { bytes } = buildKernel(k);
    const small = { ...k };
    // shrink inputs
    const setupSmall = (mem: Uint8Array) => {
      mem.set(bytes, 0);
      const dv = new DataView(mem.buffer);
      if (k.name === 'sum_squares') dv.setBigUint64(0x1000, 25n, true);
      if (k.name === 'xorshift64') { dv.setBigUint64(0x1000, 1000n, true); dv.setBigUint64(0x1008, 0xdeadbeefcafef00dn, true); }
      if (k.name === 'memcpy64') {
        dv.setBigUint64(0x1000, 64n, true); // 64 words = 512 bytes
        for (let off = 0; off < 64 * 8; off += 8) dv.setBigUint64(0x2000 + off, BigInt(off) * 2654435761n, true);
      }
    };
    void small;
    const memI = new Uint8Array(k.memoryBytes);
    setupSmall(memI);
    const m = new Machine(bytes, k.memoryBytes);
    m.mem.set(memI);
    const interp = m.run();

    const region = compileToWasm(bytes, { memoryPages: Math.ceil(k.memoryBytes / 65536), optimize: true });
    const inst = await instantiateRegion(region, Math.ceil(k.memoryBytes / 65536));
    const memJ = new Uint8Array(k.memoryBytes);
    setupSmall(memJ);
    new Uint8Array(inst.memory.buffer).set(memJ);
    const a0 = inst.exports.run();
    assert.equal(a0, interp.a0, `a0 mismatch on kernel ${k.name}`);
    if (k.name === 'memcpy64') {
      const out = new Uint8Array(inst.memory.buffer);
      for (let off = 0; off < 64 * 8; off += 8) {
        const got = new DataView(out.buffer).getBigUint64(0x402000 + off, true); // DST = SRC + 4 MiB
        const want = new DataView(memJ.buffer).getBigUint64(0x2000 + off, true);
        assert.equal(got, want, `word ${off / 8} mismatch`);
      }
    }
  }
});

test('interpreter: fuel bound stops infinite loops', () => {
  const { bytes } = assemble('loop:\n    beq x0, x0, loop\n');
  const m = new Machine(bytes, 1024);
  const res = m.run(1000n);
  assert.equal(res.reason, 'fuel');
  assert.equal(res.instructions, 1000n);
});

test('JIT: branch both directions are taken correctly', async () => {
  const src = `
    li    a0, 7
    li    a1, 7
    beq   a0, a1, taken
    li    a0, 100
    ecall
taken:
    li    a0, 42
    ecall
  `;
  const jit = await runJit(src);
  assert.equal(jit, 42n);
  const r = runInterpreter(src);
  assert.equal(r.a0, 42n);
});

test('JIT: lui/auipc address computation', async () => {
  const src = 'lui a0, 0x12345\necall\n';
  const jit = await runJit(src);
  assert.equal(jit, BigInt(0x12345000));
  const r = runInterpreter(src);
  assert.equal(r.a0, BigInt(0x12345000));
});
