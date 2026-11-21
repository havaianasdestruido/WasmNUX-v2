/**
 * Minimal ELF32 loader.
 *
 * Benchmarks that come from a real toolchain (CoreMark, Dhrystone, a
 * self-compiled `gcc`) arrive as ELF images; hand-written spike kernels come
 * from our own assembler as flat binaries. Supporting both means the benchmark
 * harness does not care which produced an image.
 *
 * Only what a statically linked RV32 image needs: the ELF32 little-endian
 * header, program headers, PT_LOAD segments and the entry point. No
 * relocations (we link at a fixed base), no sections, no dynamic linking.
 */

export const ELF_MAGIC = 0x464c457f; // "\x7fELF" little-endian
export const PT_LOAD = 1;

export interface ElfImage {
  entry: number;
  /** Segments in load order. */
  segments: Array<{ vaddr: number; bytes: Uint8Array; fileSize: number; memSize: number; flags: number }>;
  /** Lowest and highest virtual address touched. */
  lo: number;
  hi: number;
}

export class ElfError extends Error {}

export function isElf(bytes: Uint8Array): boolean {
  return (
    bytes.length >= 4 && bytes[0] === 0x7f && bytes[1] === 0x45 && bytes[2] === 0x4c && bytes[3] === 0x46
  );
}

export function parseElf32(bytes: Uint8Array): ElfImage {
  if (!isElf(bytes)) throw new ElfError('not an ELF file');
  if (bytes.length < 52) throw new ElfError('truncated ELF header');
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes[4] !== 1) throw new ElfError('not ELF32 (EI_CLASS != ELFCLASS32)');
  if (bytes[5] !== 1) throw new ElfError('not little-endian (EI_DATA != ELFDATA2LSB)');
  const machine = dv.getUint16(18, true);
  if (machine !== 243) throw new ElfError(`unsupported e_machine ${machine} (expected EM_RISCV)`);
  if (bytes[6] !== 1 || dv.getUint32(20, true) !== 1) throw new ElfError('unsupported ELF version');
  if (dv.getUint16(16, true) !== 2) throw new ElfError('only static ET_EXEC ELF images are supported');
  if (dv.getUint32(36, true) !== 0) throw new ElfError('ELF ISA/ABI flags are unsupported by RV32IMA');
  if (dv.getUint16(40, true) !== 52) throw new ElfError('invalid ELF header size');
  const entry = dv.getUint32(24, true) >>> 0;
  const phoff = dv.getUint32(28, true);
  const phentsize = dv.getUint16(42, true);
  const phnum = dv.getUint16(44, true);
  if (phentsize !== 32) throw new ElfError(`unexpected e_phentsize ${phentsize}`);

  if (phoff < 52 || phoff + phnum * phentsize > bytes.length)
    throw new ElfError('program headers out of range');
  const segments: ElfImage['segments'] = [];
  let lo = 0xffffffff;
  let hi = 0;
  for (let i = 0; i < phnum; i++) {
    const off = phoff + i * phentsize;
    if (off + phentsize > bytes.length) throw new ElfError('program header out of range');
    const type = dv.getUint32(off, true);
    if (type === 2 || type === 3) throw new ElfError('dynamic ELF loading is not supported');
    if (type !== PT_LOAD) continue;
    const fileOffset = dv.getUint32(off + 4, true);
    const vaddr = dv.getUint32(off + 8, true) >>> 0;
    const fileSize = dv.getUint32(off + 16, true);
    const memSize = dv.getUint32(off + 20, true);
    const flags = dv.getUint32(off + 24, true);
    const alignment = dv.getUint32(off + 28, true);
    if (
      alignment > 1 &&
      ((alignment & (alignment - 1)) !== 0 || vaddr % alignment !== fileOffset % alignment)
    )
      throw new ElfError('invalid PT_LOAD alignment');
    if (vaddr + memSize > 0x100000000) throw new ElfError('PT_LOAD exceeds RV32 address space');
    if (fileOffset + fileSize > bytes.length) throw new ElfError(`PT_LOAD ${i} extends past end of file`);
    if (memSize < fileSize) throw new ElfError(`PT_LOAD ${i} has p_memsz < p_filesz`);
    segments.push({
      vaddr,
      bytes: bytes.subarray(fileOffset, fileOffset + fileSize),
      fileSize,
      memSize,
      flags,
    });
    lo = Math.min(lo, vaddr);
    hi = Math.max(hi, vaddr + memSize);
  }
  if (!segments.length) throw new ElfError('no PT_LOAD segments');
  if (
    entry % 4 !== 0 ||
    !segments.some(
      (seg) => (seg.flags & 1) !== 0 && entry >= seg.vaddr && entry + 4 <= seg.vaddr + seg.memSize,
    )
  )
    throw new ElfError('entry is not a word-aligned executable address');
  return { entry, segments, lo, hi };
}
