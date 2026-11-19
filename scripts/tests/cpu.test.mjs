import assert from 'node:assert/strict';
import test from 'node:test';
import {emitBlock, emitLoopRegion, makeInterpreter, workload} from '../../core/jit/rv64.mjs';
import {leb} from '../../core/jit/wasm.mjs';
import {Hart} from '../../core/cpu/atomics.mjs';
const op = (f7, f3, rd, rs, rt) => (f7<<25)|(rt<<20)|(rs<<15)|(f3<<12)|(rd<<7)|0x33;
const addi = (rd, rs, imm) => ((imm & 4095)<<20)|(rs<<15)|(rd<<7)|0x13;
const branch = (f3, rs, rt, offset) => ((offset & 4096)<<19)|((offset & 2016)<<20)|((offset & 30)<<7)|((offset & 2048)>>4)|(rt<<20)|(rs<<15)|(f3<<12)|0x63;
function compare(words, input, pc) {
  const mem = new WebAssembly.Memory({initial:1, maximum:1});
  const actual = new BigInt64Array(mem.buffer,0,32);
  const expected = BigInt64Array.from(input);
  actual.set(input);
  const fn = new WebAssembly.Instance(new WebAssembly.Module(emitBlock(words, pc)), {env:{mem}}).exports.run;
  const result = fn();
  assert.equal(result, makeInterpreter(words, pc)(expected));
  assert.deepEqual(actual, expected);
  return {next:result, registers:actual};
}
test('LEB boundaries and validation', () => {
  assert.deepEqual(leb(127, true), [255,0]);
  assert.deepEqual(leb(-65, true), [191,127]);
  assert.deepEqual(leb(128), [128,1]);
  assert.throws(() => leb(-1), RangeError);
});
test('known RV64 branches, x0, two’s complement wrap and negative immediate', () => {
  const input = new BigInt64Array(32);
  input[0] = 25n; input[1] = (1n<<63n)-1n;
  const words = Uint32Array.of(addi(0,1,5), addi(1,1,1), addi(2,0,-2048), branch(0,0,0,-8));
  const {next, registers} = compare(words, input, 4096);
  assert.equal(next,4100); assert.equal(registers[0],25n); assert.equal(registers[1],-(1n<<63n)); assert.equal(registers[2],-2048n);
  assert.equal(compare(workload, BigInt64Array.of(0n, 0n, 3n, 17n, ...Array(28).fill(0n)), 0).next, 0);
  assert.equal(compare(workload, BigInt64Array.of(0n, 1n, 3n, 17n, ...Array(28).fill(0n)), 0).next, 20);
});
test('seeded differential arithmetic blocks', () => {
  let seed = 111;
  const random = () => { seed ^= seed<<13; seed ^= seed>>>17; seed ^= seed<<5; return seed>>>0; };
  for (let n=0;n<128;n++) {
    const words = Uint32Array.from({length:24}, () => {
      const rd = random()%32, rs = random()%32, rt = random()%32;
      return [addi(rd,rs,(random()%4096)-2048),op(0,0,rd,rs,rt),op(0x20,0,rd,rs,rt),op(1,0,rd,rs,rt),op(0,4,rd,rs,rt)][random()%5];
    });
    compare(words, BigInt64Array.from({length:32}, () => BigInt(random())<<32n | BigInt(random())), 0);
  }
});
test('reject unknown, misplaced and misaligned instructions', () => {
  assert.throws(() => emitBlock(Uint32Array.of(0)), /unsupported/);
  assert.throws(() => emitBlock(Uint32Array.of(branch(1,1,0,2))), /unsupported/);
  assert.throws(() => emitBlock(Uint32Array.of(branch(0,0,0,0), addi(1,1,1))), /misplaced/);
});
test('Wasm SC rejects ABA, wrong address and reused reservations', () => {
  const mem = new WebAssembly.Memory({initial:1,maximum:1,shared:true});
  const a = new Hart(mem), b = new Hart(mem);
  assert.equal(a.lr(0),0); b.amoAdd(0,2); b.amoAdd(0,-2);
  assert.equal(a.sc(0,7),1);
  a.lr(0); assert.equal(a.sc(4,6),1); assert.equal(a.sc(0,7),1);
  a.lr(4); assert.equal(a.sc(4,0x7fffffff),0); assert.equal(a.sc(4,9),1);
  assert.equal(b.amoAdd(4,1),0x7fffffff); assert.equal(a.read(4),-0x80000000);
  assert.throws(() => a.lr(2), RangeError); assert.throws(() => a.read(32768), RangeError);
});

test('loop region respects fuel, preserves state on a side exit, and matches the interpreter', () => {
  const mem = new WebAssembly.Memory({initial:1,maximum:1});
  const r = new BigInt64Array(mem.buffer,0,32);
  const reference = new BigInt64Array(32);
  for (const state of [r,reference]) state.set([0n,17n,3n,19n]);
  const ir = makeInterpreter(workload,1024);
  const fn = new WebAssembly.Instance(new WebAssembly.Module(emitLoopRegion(workload,1024)), {env:{mem}}).exports.run;
  assert.equal(fn(0),1024); assert.deepEqual(r,reference);
  assert.equal(fn(5),1024);
  for (let i=0;i<5;i++) assert.equal(ir(reference),1024);
  assert.deepEqual(r,reference);
  assert.equal(fn(20),1044);
  for (let i=0;i<12;i++) assert.equal(ir(reference),i===11 ? 1044 : 1024);
  assert.deepEqual(r,reference);
  assert.throws(() => emitLoopRegion(Uint32Array.of(addi(1,1,1))), /self-edge/);
});
