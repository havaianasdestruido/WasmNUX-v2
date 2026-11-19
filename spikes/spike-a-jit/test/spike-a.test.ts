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

test('assembler: negative lui positions the upper immediate in one shift', () => {
  const { bytes } = assemble('lui x5, -1\n');
  assert.equal(new DataView(bytes.buffer).getUint32(0, true) >>> 0, 0xfffff2b7);
});

test('assembler: lui out-of-range upper immediate is rejected', () => {
  assert.throws(() => assemble('lui x5, 0x80000\n'), /20-bit range/);
});

test('assembler: branch offset beyond 4 KiB is rejected, not wrapped', () => {
  // 8192/4 = 2048 instructions of padding: offset out of B range
  const padding = Array.from({ length: 2048 }, () => 'addi x0, x0, 0').join('\n');
  const src = `loop:\n${padding}\n    beq x0, x0, loop\n`;
  assert.throws(() => assemble(src), /B-immediate range/);
});

test('JIT: divisor zero yields RISC-V-defined results, not a trap', async () => {
  const setup = (mem: Uint8Array) => {
    const dv = new DataView(mem.buffer);
    dv.setBigUint64(0x1000, 12345n, true);
  };
  const load = 'lui x5, 1\nld x11, 0(x5)\n';
  const srcDiv = load + 'li x12, 0\ndiv x10, x11, x12\necall\n';
  assert.equal(await runJit(srcDiv, setup), BigInt.asIntN(64, -1n));
  const srcRem = load + 'li x12, 0\nrem x10, x11, x12\necall\n';
  assert.equal(await runJit(srcRem, setup), 12345n);
  const srcDivU = load + 'li x12, 0\ndivu x10, x11, x12\necall\n';
  assert.equal(await runJit(srcDivU, setup), BigInt.asIntN(64, -1n)); // all ones, signed i64
  const srcRemU = load + 'li x12, 0\nremu x10, x11, x12\necall\n';
  assert.equal(await runJit(srcRemU, setup), 12345n);
  assert.equal(runInterpreter(srcDiv, setup).a0, BigInt.asIntN(64, -1n));
});

test('JIT: INT64_MIN / -1 yields INT64_MIN (div) and 0 (rem), no trap', async () => {
  const setup = (mem: Uint8Array) => {
    const dv = new DataView(mem.buffer);
    dv.setBigUint64(0x1000, -(1n << 63n), true);
    dv.setBigUint64(0x1008, -1n, true);
  };
  const load = 'lui x5, 1\nld x11, 0(x5)\nld x12, 8(x5)\n';
  assert.equal(await runJit(load + 'div x10, x11, x12\necall\n', setup), -(1n << 63n));
  assert.equal(await runJit(load + 'rem x10, x11, x12\necall\n', setup), 0n);
  assert.equal(runInterpreter(load + 'div x10, x11, x12\necall\n', setup).a0, -(1n << 63n));
});

test('JIT: interpreter and JIT agree on div/rem edge cases', async () => {
  const setup = (mem: Uint8Array) => {
    const dv = new DataView(mem.buffer);
    dv.setBigUint64(0x1000, 12345n, true);
    dv.setBigUint64(0x1008, -(1n << 63n), true);
    dv.setBigUint64(0x1010, -1n, true);
    dv.setBigUint64(0x1018, 0n, true);
  };
  const ld = (reg: string, off: number) => `lui x5, 1\nld ${reg}, ${off}(x5)\n`;
  const cases: Array<[string, string]> = [
    ['div-by-zero', ld('x11', 0) + 'li x12, 0\ndiv x10, x11, x12\necall\n'],
    ['rem-by-zero', ld('x11', 0) + 'li x12, 0\nrem x10, x11, x12\necall\n'],
    ['divu-by-zero', ld('x11', 0) + 'li x12, 0\ndivu x10, x11, x12\necall\n'],
    ['remu-by-zero', ld('x11', 0) + 'li x12, 0\nremu x10, x11, x12\necall\n'],
    ['div-overflow', ld('x11', 8) + ld('x12', 16) + 'div x10, x11, x12\necall\n'],
    ['rem-overflow', ld('x11', 8) + ld('x12', 16) + 'rem x10, x11, x12\necall\n'],
    ['div-normal', 'li x11, 100\nli x12, 7\ndiv x10, x11, x12\necall\n'],
    ['rem-normal', 'li x11, 100\nli x12, 7\nrem x10, x11, x12\necall\n'],
    ['divu-normal', 'li x11, 100\nli x12, 7\ndivu x10, x11, x12\necall\n'],
    ['remu-normal', 'li x11, 100\nli x12, 7\nremu x10, x11, x12\necall\n'],
  ];
  for (const [name, src] of cases) {
    const interp = runInterpreter(src!, setup);
    const jit = await runJit(src!, setup);
    assert.equal(jit, interp.a0, `case ${name}: JIT ${jit} != interpreter ${interp.a0}`);
  }
});

test('JIT: effective address with high 32 bits nonzero traps, does not wrap', async () => {
  // ld x11, 0(x5) gives x11 = 0x0000_0001_0000_0000; ld x10, 0(x11) must trap,
  // not alias guest RAM offset 0.
  const setup = (mem: Uint8Array) => {
    new DataView(mem.buffer).setBigUint64(0x1000, 1n << 32n, true);
  };
  const src = 'lui x5, 1\nld x11, 0(x5)\nld x10, 0(x11)\necall\n';
  await assert.rejects(runJit(src, setup));
});
