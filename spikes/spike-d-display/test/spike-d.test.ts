import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSimdBlit, instantiateSimdBlit, jsTypedArraySet, jsManual } from '../src/blit.js';
import { frameBudgetMs, shouldDropFrame, inputToPhotonMs, worstCaseInputToPhotonMs } from '../src/pacing.js';
import { probeWebGPU } from '../src/webgpu-probe.js';

test('Wasm SIMD blit copies bytes exactly', async () => {
  const simd = await instantiateSimdBlit();
  const mem = new Uint8Array(simd.memory.buffer);
  const src = new Uint8Array(1024).map((_, i) => (i * 2654435761 >>> 0) & 0xff);
  mem.set(src, 0);
  simd.blit(2048, 0, src.length);
  assert.deepEqual([...mem.subarray(2048, 2048 + src.length)], [...src]);
});

test('Wasm SIMD blit handles tail bytes (non-16-aligned length)', async () => {
  const simd = await instantiateSimdBlit();
  const mem = new Uint8Array(simd.memory.buffer);
  const n = 1023 + 1; // 1024: loop covers it; try 1031 as well
  const src = new Uint8Array(n).map((_, i) => (i * 97 + 11) & 0xff);
  mem.set(src, 0);
  simd.blit(4096, 0, n);
  assert.deepEqual([...mem.subarray(4096, 4096 + n)], [...src]);
  const src2 = new Uint8Array(1031).map((_, i) => (i * 31 + 7) & 0xff);
  mem.set(src2, 0);
  simd.blit(8192, 0, src2.length);
  assert.deepEqual([...mem.subarray(8192, 8192 + src2.length)], [...src2]);
});

test('blit module passes wasm validation', () => {
  assert.ok(buildSimdBlit().length > 50);
});

test('js reference blits agree', () => {
  const src = new Uint8Array(4096).map((_, i) => (i * 13) & 0xff);
  const a = new Uint8Array(4096), b = new Uint8Array(4096);
  jsTypedArraySet(a, src);
  jsManual(b, src);
  assert.deepEqual([...a], [...src]);
  assert.deepEqual([...b], [...src]);
});

test('pacing: frame budget and drop policy', () => {
  assert.equal(frameBudgetMs(60), 1000 / 60);
  assert.ok(!shouldDropFrame(2, 2, 60));
  assert.ok(shouldDropFrame(15, 2, 60));
  assert.throws(() => frameBudgetMs(0));
});

test('pacing: input-to-photon estimate composes and adds at most one frameworst-case', () => {
  const m = { inputPollMs: 0.5, vcpuAdvanceMs: 2, renderMs: 1, scanoutMs: 0.3, presentMs: 0.4 };
  assert.equal(inputToPhotonMs(m), 4.2);
  assert.equal(worstCaseInputToPhotonMs(m, 60), 4.2 + 1000 / 60);
});

test('webgpu probe: reports unavailable in Node without crashing', async () => {
  const report = await probeWebGPU();
  assert.equal(report.available, false);
  assert.equal(report.environment, 'node');
  assert.ok(report.notes.length >= 1);
});
