/**
 * Scanout blit implementations for Spike D.
 * Guest framebuffer = RGBA8 byte array; "scanout" = copying it to the display
 * target (here: a second buffer standing in for the GPU upload path; the real
 * browser path uploads via queue.writeTexture, probed by webgpu-probe.ts).
 */
import binaryen from 'binaryen';

export interface BlitBenchmark {
  jsTypedArraySetMBs: number;
  wasmSimdMBs: number;
  jsManualMBs: number;
  frame1920x1080: { bytes: number; framesPerSecondJs: number };
}

const WASM_BLIT_WAT = 'wasmnux_blit';

/** Builds the Wasm-SIMD blit module: blit(dst, src, lenBytes), 16 B per iter + tail. */
export function buildSimdBlit(): Uint8Array<ArrayBuffer> {
  const b = new binaryen.Module();
  b.setFeatures(binaryen.Features.SIMD128 + binaryen.Features.BulkMemory + binaryen.Features.SignExt);
  b.setMemory(1024, 4096, 'mem', [], false, false, 'mem'); // 64 MiB initial; frame blits up to 4K UHD

  const i32 = binaryen.i32, v128 = binaryen.v128;
  // params: dst (0), src (1), len (2); locals: i (3)
  const ptr = (base: number, off: binaryen.ExpressionRef) => b.i32.add(b.local.get(base, i32), off);
  // vector loop: only complete 16-byte vectors; the final partial vector is
  // left to the scalar tail (no over-read/over-write past len)
  const loopBody = b.block('exit', [
    b.br_if('exit', b.i32.gt_s(b.i32.add(b.local.get(3, i32), b.i32.const(16)), b.local.get(2, i32))),
    b.v128.store(0, 16, ptr(0, b.local.get(3, i32)),
      b.v128.load(0, 16, ptr(1, b.local.get(3, i32)))),
    b.local.set(3, b.i32.add(b.local.get(3, i32), b.i32.const(16))),
    b.br('loop'),
  ]);
  const simdLoop = b.loop('loop', loopBody);
  // scalar tail: while (i < len) dst[i] = src[i]; i++
  const tailBody = b.block('tailExit', [
    b.br_if('tailExit', b.i32.ge_s(b.local.get(3, i32), b.local.get(2, i32))),
    b.i32.store8(0, 1, ptr(0, b.local.get(3, i32)), b.i32.load8_u(0, 1, ptr(1, b.local.get(3, i32)))),
    b.local.set(3, b.i32.add(b.local.get(3, i32), b.i32.const(1))),
    b.br('tailLoop'),
  ]);
  const tailLoop = b.loop('tailLoop', tailBody);
  const body = b.block(null, [
    b.local.set(3, b.i32.const(0)),
    simdLoop,
    tailLoop,
  ]);
  void v128;
  b.addFunction(WASM_BLIT_WAT, binaryen.createType([i32, i32, i32]), binaryen.none, [i32], body);
  b.addFunctionExport(WASM_BLIT_WAT, WASM_BLIT_WAT);
  const ok = Number(b.validate()) !== 0;
  if (!ok) throw new Error('simd blit module failed validation:\n' + b.emitText());
  return new Uint8Array(b.emitBinary());
}

export interface SimdBlit {
  blit(dst: number, src: number, len: number): void;
  memory: WebAssembly.Memory;
}

export async function instantiateSimdBlit(): Promise<SimdBlit> {
  const mod = await WebAssembly.compile(buildSimdBlit());
  const instance = await WebAssembly.instantiate(mod, {});
  const memory = (instance.exports as Record<string, unknown>)['mem'] as WebAssembly.Memory;
  return { blit: (instance.exports as Record<string, unknown>)[WASM_BLIT_WAT] as SimdBlit['blit'], memory };
}

/** Reference copy through TypedArray.set (the optimistic native path). */
export function jsTypedArraySet(dst: Uint8Array, src: Uint8Array): void { dst.set(src); }

/** Naive byte loop (the pessimistic path, and the one we're trying to beat). */
export function jsManual(dst: Uint8Array, src: Uint8Array): void {
  for (let i = 0; i < src.length; i++) dst[i] = src[i]!;
}
