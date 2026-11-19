/**
 * Minimal WebAssembly binary encoder (MVP + i64 subset) for the Phase 0 JIT
 * spike. Hand-rolled on purpose: it keeps the spike dependency-free and makes
 * the emitted module shape (ADR-0003: region-per-module) explicit.
 */

// LEB128 ---------------------------------------------------------------

export function uleb(n: number): number[] {
  const out: number[] = [];
  let v = n >>> 0;
  do {
    let byte = v & 0x7f;
    v >>>= 7;
    if (v !== 0) byte |= 0x80;
    out.push(byte);
  } while (v !== 0);
  return out;
}

export function sleb(n: bigint): number[] {
  const out: number[] = [];
  let v = n;
  for (;;) {
    const byte = Number(v & 0x7fn);
    v >>= 7n;
    const signBit = (byte & 0x40) !== 0;
    if ((v === 0n && !signBit) || (v === -1n && signBit)) {
      out.push(byte);
      break;
    }
    out.push(byte | 0x80);
  }
  return out;
}

export function f32le(v: number): number[] {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setFloat32(0, v, true);
  return [...b];
}

export function f64le(v: number): number[] {
  const b = new Uint8Array(8);
  new DataView(b.buffer).setFloat64(0, v, true);
  return [...b];
}

// Value types -----------------------------------------------------------

export const I32 = 0x7f;
export const I64 = 0x7e;
export const F32 = 0x7d;
export const F64 = 0x7c;

// Sections --------------------------------------------------------------

export const SEC_TYPE = 1;
export const SEC_IMPORT = 2;
export const SEC_FUNCTION = 3;
export const SEC_TABLE = 4;
export const SEC_MEMORY = 5;
export const SEC_GLOBAL = 6;
export const SEC_EXPORT = 7;
export const SEC_START = 8;
export const SEC_ELEMENT = 9;
export const SEC_CODE = 10;
export const SEC_DATA = 11;
export const SEC_DATACOUNT = 12;

export interface Limits {
  min: number;
  max?: number;
  shared?: boolean;
}

export function section(id: number, payload: number[]): number[] {
  return [id, ...uleb(payload.length), ...payload];
}

export function vec(items: number[][]): number[] {
  const flat = items.flat();
  return [...uleb(items.length), ...flat];
}

/** functype: 0x60, params, results */
export function funcType(params: number[], results: number[]): number[] {
  return [0x60, ...uleb(params.length), ...params, ...uleb(results.length), ...results];
}

export function encodeLimits(l: Limits): number[] {
  if (l.shared) return [0x03, ...uleb(l.min), ...uleb(l.max ?? l.min)];
  if (l.max !== undefined) return [0x02, ...uleb(l.min), ...uleb(l.max)];
  return [0x00, ...uleb(l.min)];
}

export function name(s: string): number[] {
  const bytes = [...new TextEncoder().encode(s)];
  return [...uleb(bytes.length), ...bytes];
}

/** Encode an arbitrary module from pre-built section payloads (in order). */
export function module(...sections: number[][]): Uint8Array {
  return Uint8Array.from([
    0x00, 0x61, 0x73, 0x6d, // \0asm
    0x01, 0x00, 0x00, 0x00, // version 1
    ...sections.flat(),
  ]);
}

// Opcodes (the subset the block compiler emits) -------------------------

export const OP = {
  unreachable: 0x00,
  nop: 0x01,
  block: 0x02,
  loop: 0x03,
  if: 0x04,
  else: 0x05,
  end: 0x0b,
  br: 0x0c,
  br_if: 0x0d,
  return: 0x0f,
  call: 0x10,
  drop: 0x1a,
  select: 0x1b,

  local_get: 0x20,
  local_set: 0x21,
  local_tee: 0x22,
  global_get: 0x23,
  global_set: 0x24,

  i32_load: 0x28,
  i64_load: 0x29,
  i32_load8_s: 0x2c,
  i32_load8_u: 0x2d,
  i32_load16_s: 0x2e,
  i32_load16_u: 0x2f,
  i64_load8_s: 0x30,
  i64_load8_u: 0x31,
  i64_load16_s: 0x32,
  i64_load16_u: 0x33,
  i64_load32_s: 0x34,
  i64_load32_u: 0x35,
  i32_store: 0x36,
  i64_store: 0x37,
  i32_store8: 0x3a,
  i32_store16: 0x3b,
  i64_store8: 0x3c,
  i64_store16: 0x3d,
  i64_store32: 0x3e,

  i32_const: 0x41,
  i64_const: 0x42,

  i32_eqz: 0x45,
  i32_eq: 0x46,
  i32_ne: 0x47,
  i32_lt_s: 0x48,
  i32_lt_u: 0x49,
  i32_gt_s: 0x4a,
  i32_gt_u: 0x4b,
  i32_le_s: 0x4c,
  i32_le_u: 0x4d,
  i32_ge_s: 0x4e,
  i32_ge_u: 0x4f,

  i64_eqz: 0x50,
  i64_eq: 0x51,
  i64_ne: 0x52,
  i64_lt_s: 0x53,
  i64_lt_u: 0x54,
  i64_gt_s: 0x55,
  i64_gt_u: 0x56,
  i64_le_s: 0x57,
  i64_le_u: 0x58,
  i64_ge_s: 0x59,
  i64_ge_u: 0x5a,

  i32_add: 0x6a,
  i32_sub: 0x6b,
  i32_mul: 0x6c,
  i32_and: 0x71,
  i32_or: 0x72,
  i32_xor: 0x73,
  i32_shl: 0x74,
  i32_shr_s: 0x75,
  i32_shr_u: 0x76,

  i64_add: 0x7c,
  i64_sub: 0x7d,
  i64_mul: 0x7e,
  i64_div_s: 0x7f,
  i64_div_u: 0x80,
  i64_rem_s: 0x81,
  i64_rem_u: 0x82,
  i64_and: 0x83,
  i64_or: 0x84,
  i64_xor: 0x85,
  i64_shl: 0x86,
  i64_shr_s: 0x87,
  i64_shr_u: 0x88,

  i32_wrap_i64: 0xa7,
  i64_extend_i32_s: 0xac,
  i64_extend_i32_u: 0xad,
} as const;

/** memarg: alignment exponent, offset */
export function memarg(align: number, offset = 0): number[] {
  return [...uleb(align), ...uleb(offset)];
}
