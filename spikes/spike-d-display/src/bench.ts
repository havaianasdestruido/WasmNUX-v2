/**
 * Spike D benchmark: JS vs Wasm-SIMD scanout blit + frame budget math.
 * Usage: node dist/src/bench.js [--json out.json] [--quick]
 */
import { performance } from 'node:perf_hooks';
import { writeFileSync } from 'node:fs';
import os from 'node:os';
import { jsManual, jsTypedArraySet, instantiateSimdBlit } from './blit.js';

const W = 1920, H = 1080;
const BYTES = W * H * 4;

async function main(): Promise<void> {
  const quick = process.argv.includes('--quick');
  const jsonIdx = process.argv.indexOf('--json');
  const REPS = quick ? 5 : 30;

  const dst = new Uint8Array(BYTES);
  const src = new Uint8Array(BYTES);
  for (let i = 0; i < src.length; i += 4096) src[i] = (i * 131) & 0xff;

  // JS TypedArray.set
  let best = Infinity;
  for (let r = 0; r < REPS; r++) {
    const t0 = performance.now();
    jsTypedArraySet(dst, src);
    best = Math.min(best, performance.now() - t0);
  }
  const setMBs = BYTES / (best / 1000) / 1e6;

  // JS manual loop (sampled at small size, extrapolated)
  const small = 256 * 1024;
  const sdst = new Uint8Array(small), ssrc = src.subarray(0, small);
  let manualMs = Infinity;
  for (let r = 0; r < 3; r++) {
    const t0 = performance.now();
    jsManual(sdst, ssrc);
    manualMs = Math.min(manualMs, performance.now() - t0);
  }
  const manualMBs = small / (manualMs / 1000) / 1e6;

  // Wasm SIMD
  const simd = await instantiateSimdBlit();
  const mem = new Uint8Array(simd.memory.buffer);
  const srcOff = 0, dstOff = BYTES; // source at 0, dest right after
  mem.set(src, srcOff);
  let simdBest = Infinity;
  for (let r = 0; r < REPS; r++) {
    const t0 = performance.now();
    simd.blit(dstOff, srcOff, BYTES);
    simdBest = Math.min(simdBest, performance.now() - t0);
  }
  const simdMBs = BYTES / (simdBest / 1000) / 1e6;
  // verify
  const verify = Buffer.from(mem.buffer, dstOff, BYTES).equals(Buffer.from(src));

  const report = {
    benchmark: 'wasmnux-spike-d-display',
    version: 1,
    timestamp: new Date().toISOString(),
    host: { cpus: os.cpus().length, model: os.cpus()[0]?.model ?? 'unknown', platform: process.platform, release: os.release() },
    config: { width: W, height: H, frameBytes: BYTES, reps: REPS },
    blit: {
      typedArraySetMBs: setMBs,
      wasmSimdMBs: simdMBs,
      jsManualSampleMBs: manualMBs,
      typedArraySetFramesPerSecond1080p: 1000 / best,
      wasmSimdFramesPerSecond1080p: 1000 / simdBest,
      simdBlitVerified: verify,
    },
    note: 'In-browser numbers (WebGPU writeTexture upload MB/s) are measured by the probe at web/probe/webgpu-scanout.html; Node cannot reach WebGPU here.',
  };
  const json = JSON.stringify(report, null, 2);
  if (jsonIdx >= 0 && process.argv[jsonIdx + 1]) writeFileSync(process.argv[jsonIdx + 1]!, json);
  console.log(json);
}

main().catch(err => { console.error(err); process.exit(1); });
