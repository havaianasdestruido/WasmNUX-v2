/**
 * Benchmark kernels (RV64 assembly, assembled from assembler.ts).
 * Guest-visible memory layout (set up by the host before run):
 *   0x1000: u64 n      (iteration count / word count)
 *   0x1008: u64 seed   (xorshift kernel)
 *   0x2000: source     (memcpy kernel)
 *   0x3000: destination(memcpy kernel)
 * The guest program lives at 0x0000.
 */
import { assemble, type AssembledProgram } from './assembler.js';

export interface Kernel {
  name: string;
  source: string;
  description: string;
  /** Bytes of guest memory (program + data). */
  memoryBytes: number;
  /** Write kernel inputs into guest memory (raw bytes, includes program space). */
  setup(mem: Uint8Array, programBytes: Uint8Array): void;
  /** Default iteration parameter(s). */
  defaultN: number;
}

const DATA = 0x1000;
const SRC = 0x2000;
const DST = 0x402000; // 0x2000 + 0x400000 (4 MiB after the src region, page-aligned)

const SUM_SQUARES = `
    lui   x5, 1
    ld    x6, 0(x5)     # n
    li    x7, 0         # sum
    li    x8, 1         # i
loop:
    mul   x9, x8, x8
    add   x7, x7, x9
    addi  x8, x8, 1
    bleu  x8, x6, loop
    mv    x10, x7
    ecall
`;

const XORSHIFT64 = `
    lui   x5, 1
    ld    x6, 0(x5)     # n
    ld    x7, 8(x5)     # seed (host always installs a non-zero seed)
    li    x8, 0         # i
    li    x9, 0         # acc
loop:
    slli  x10, x7, 13
    xor   x7, x7, x10
    srli  x10, x7, 7
    xor   x7, x7, x10
    slli  x10, x7, 17
    xor   x7, x7, x10
    add   x9, x9, x7
    addi  x8, x8, 1
    bltu  x8, x6, loop
    mv    x10, x9
    ecall
`;

const MEMCPY64 = `
    lui   x5, 2         # src 0x2000
    lui   x6, 0x402     # dst 0x402000
    lui   x7, 1         # input page 0x1000
    ld    x8, 0(x7)     # n words
    li    x9, 0         # i
loop:
    slli  x10, x9, 3
    add   x11, x5, x10
    ld    x12, 0(x11)
    add   x13, x6, x10
    sd    x12, 0(x13)
    addi  x9, x9, 1
    bltu  x9, x8, loop
    li    x10, 0
    ecall
`;

export const KERNELS: Kernel[] = [
  {
    name: 'sum_squares',
    description: 'sum of i^2 for i=1..n (RV64M mul, loop-carried dependency)',
    source: SUM_SQUARES,
    memoryBytes: 0x4000,
    defaultN: 3_000_000,
    setup(mem, _p) {
      const dv = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
      dv.setBigUint64(DATA, 3_000_000n, true);
    },
  },
  {
    name: 'xorshift64',
    description: 'xorshift64* PRNG accumulation, n rounds (shift/xor latency-bound)',
    source: XORSHIFT64,
    memoryBytes: 0x4000,
    defaultN: 5_000_000,
    setup(mem, _p) {
      const dv = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
      dv.setBigUint64(DATA, 5_000_000n, true);
      dv.setBigUint64(DATA + 8, 0x9e3779b97f4a7c15n, true);
    },
  },
  {
    name: 'memcpy64',
    description: 'copy n u64 words from 0x2000 to 0x3000 (memory-bound, ld/sd)',
    source: MEMCPY64,
    memoryBytes: 16 * 1024 * 1024,
    defaultN: 500_000, // words = 4 MB
    setup(mem, _p) {
      const dv = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
      dv.setBigUint64(DATA, 500_000n, true);
      for (let off = 0; off < 500_000 * 8; off += 8) {
        dv.setBigUint64(SRC + off, BigInt(off + 0x12345), true);
      }
    },
  },
];

export function buildKernel(k: Kernel): AssembledProgram {
  return assemble(k.source);
}

/** Fresh guest memory with program image + kernel inputs installed. */
export function instantiateKernelMemory(k: Kernel, program: Uint8Array): Uint8Array {
  const mem = new Uint8Array(k.memoryBytes);
  mem.set(program, 0);
  k.setup(mem, program);
  return mem;
}
