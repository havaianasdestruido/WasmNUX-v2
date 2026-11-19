/**
 * A small, dependency-free WebAssembly binary encoder.
 *
 * Spike A (JIT feasibility) needs to *emit* Wasm at runtime from guest code, so
 * the encoder is part of the product, not the tooling: the same module builder
 * is used by the terminal/display spikes and by the feature probes that back
 * ADR-0004 (shared memory, atomics, SIMD, Memory64).
 *
 * Everything is validated by `core/test/wasm-encoder.test.ts`, which instantiates
 * the emitted modules and checks their behaviour - a wrong opcode byte shows up
 * as a validation error rather than silently miscompiled guest code.
 */

export type ValType = 'i32' | 'i64' | 'f32' | 'f64' | 'v128' | 'funcref' | 'externref';

export const VALTYPE: Record<ValType, number> = {
  i32: 0x7f,
  i64: 0x7e,
  f32: 0x7d,
  f64: 0x7c,
  v128: 0x7b,
  funcref: 0x70,
  externref: 0x6f,
};

const BLOCKTYPE_VOID = 0x40;

/** Growable byte buffer with LEB128 helpers. */
export class Buf {
  private data: Uint8Array<ArrayBuffer>;
  length = 0;

  constructor(capacity = 1024) {
    this.data = new Uint8Array(capacity);
  }

  private ensure(n: number): void {
    if (this.length + n <= this.data.length) return;
    let cap = this.data.length * 2;
    while (cap < this.length + n) cap *= 2;
    const next = new Uint8Array(cap);
    next.set(this.data.subarray(0, this.length));
    this.data = next;
  }

  u8(v: number): this {
    this.ensure(1);
    this.data[this.length++] = v & 0xff;
    return this;
  }

  bytes(src: Uint8Array | number[]): this {
    const n = src.length;
    this.ensure(n);
    this.data.set(src as Uint8Array, this.length);
    this.length += n;
    return this;
  }

  uleb(v: number): this {
    let n = v >>> 0;
    this.ensure(5);
    for (;;) {
      const byte = n & 0x7f;
      n >>>= 7;
      if (n === 0) {
        this.data[this.length++] = byte;
        return this;
      }
      this.data[this.length++] = byte | 0x80;
    }
  }

  sleb(v: number): this {
    let n = v | 0;
    this.ensure(5);
    for (;;) {
      const byte = n & 0x7f;
      n >>= 7;
      const sign = byte & 0x40;
      if ((n === 0 && !sign) || (n === -1 && sign)) {
        this.data[this.length++] = byte;
        return this;
      }
      this.data[this.length++] = byte | 0x80;
    }
  }

  sleb64(v: bigint): this {
    let n = BigInt.asIntN(64, v);
    this.ensure(10);
    for (;;) {
      const byte = Number(BigInt.asUintN(7, n));
      n >>= 7n;
      const sign = byte & 0x40;
      if ((n === 0n && !sign) || (n === -1n && sign)) {
        this.data[this.length++] = byte;
        return this;
      }
      this.data[this.length++] = byte | 0x80;
    }
  }

  f32(v: number): this {
    this.ensure(4);
    new DataView(this.data.buffer, this.data.byteOffset, this.data.byteLength).setFloat32(
      this.length,
      v,
      true,
    );
    this.length += 4;
    return this;
  }

  f64(v: number): this {
    this.ensure(8);
    new DataView(this.data.buffer, this.data.byteOffset, this.data.byteLength).setFloat64(
      this.length,
      v,
      true,
    );
    this.length += 8;
    return this;
  }

  name(s: string): this {
    const enc = new TextEncoder().encode(s);
    this.uleb(enc.length);
    return this.bytes(enc);
  }

  finish(): Uint8Array<ArrayBuffer> {
    return this.data.slice(0, this.length);
  }
}

// ---------------------------------------------------------------------------
// Opcodes
// ---------------------------------------------------------------------------

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
  br_table: 0x0e,
  return: 0x0f,
  call: 0x10,
  call_indirect: 0x11,
  return_call: 0x12,
  return_call_indirect: 0x13,
  drop: 0x1a,
  select: 0x1b,
  local_get: 0x20,
  local_set: 0x21,
  local_tee: 0x22,
  global_get: 0x23,
  global_set: 0x24,
  i32_load: 0x28,
  i64_load: 0x29,
  f32_load: 0x2a,
  f64_load: 0x2b,
  i32_load8_s: 0x2c,
  i32_load8_u: 0x2d,
  i32_load16_s: 0x2e,
  i32_load16_u: 0x2f,
  i64_load8_s: 0x30,
  i64_load16_s: 0x32,
  i64_load32_s: 0x34,
  i32_store: 0x36,
  i64_store: 0x37,
  f32_store: 0x38,
  f64_store: 0x39,
  i32_store8: 0x3a,
  i32_store16: 0x3b,
  memory_size: 0x3f,
  memory_grow: 0x40,
  i32_const: 0x41,
  i64_const: 0x42,
  f32_const: 0x43,
  f64_const: 0x44,
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
  i32_clz: 0x67,
  i32_ctz: 0x68,
  i32_popcnt: 0x69,
  i32_add: 0x6a,
  i32_sub: 0x6b,
  i32_mul: 0x6c,
  i32_div_s: 0x6d,
  i32_div_u: 0x6e,
  i32_rem_s: 0x6f,
  i32_rem_u: 0x70,
  i32_and: 0x71,
  i32_or: 0x72,
  i32_xor: 0x73,
  i32_shl: 0x74,
  i32_shr_s: 0x75,
  i32_shr_u: 0x76,
  i32_rotl: 0x77,
  i32_rotr: 0x78,
  i64_clz: 0x79,
  i64_ctz: 0x7a,
  i64_popcnt: 0x7b,
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

/**
 * 0xfe-prefixed atomics (threads proposal).
 *
 * The RMW opcodes come in groups of seven:
 *   +0 i32.rmw.OP  +1 i64.rmw.OP  +2 i32.rmw8.OP_u  +3 i32.rmw16.OP_u
 *   +4 i64.rmw8.OP_u  +5 i64.rmw16.OP_u  +6 i64.rmw32.OP_u
 * with group bases add=0x1e sub=0x25 and=0x2c or=0x33 xor=0x3a xchg=0x41
 * cmpxchg=0x48. `core/test/wasm-encoder.test.ts` verifies each entry by
 * executing it, because a wrong byte here silently miscompiles guest atomics.
 */
export const ATOMIC = {
  notify: 0x00,
  wait32: 0x01,
  wait64: 0x02,
  fence: 0x03,
  i32_load: 0x10,
  i64_load: 0x11,
  i32_load8_u: 0x12,
  i32_load16_u: 0x13,
  i64_load8_u: 0x14,
  i64_load16_u: 0x15,
  i64_load32_u: 0x16,
  i32_store: 0x17,
  i64_store: 0x18,
  i32_store8: 0x19,
  i32_store16: 0x1a,
  i64_store8: 0x1b,
  i64_store16: 0x1c,
  i64_store32: 0x1d,
  i32_rmw_add: 0x1e,
  i64_rmw_add: 0x1f,
  i32_rmw8_add_u: 0x20,
  i32_rmw16_add_u: 0x21,
  i32_rmw_sub: 0x25,
  i64_rmw_sub: 0x26,
  i32_rmw8_sub_u: 0x27,
  i32_rmw16_sub_u: 0x28,
  i32_rmw_and: 0x2c,
  i64_rmw_and: 0x2d,
  i32_rmw8_and_u: 0x2e,
  i32_rmw16_and_u: 0x2f,
  i32_rmw_or: 0x33,
  i64_rmw_or: 0x34,
  i32_rmw8_or_u: 0x35,
  i32_rmw16_or_u: 0x36,
  i32_rmw_xor: 0x3a,
  i64_rmw_xor: 0x3b,
  i32_rmw8_xor_u: 0x3c,
  i32_rmw16_xor_u: 0x3d,
  i32_rmw_xchg: 0x41,
  i64_rmw_xchg: 0x42,
  i32_rmw8_xchg_u: 0x43,
  i32_rmw16_xchg_u: 0x44,
  i32_rmw_cmpxchg: 0x48,
  i64_rmw_cmpxchg: 0x49,
  i32_rmw8_cmpxchg_u: 0x4a,
  i32_rmw16_cmpxchg_u: 0x4b,
} as const;

/**
 * 0xfd-prefixed SIMD ops used by the software display path (Spike D) and by the
 * device models. Values verified against V8 in `core/test/wasm-encoder.test.ts`.
 */
export const SIMD = {
  v128_load: 0x00,
  v128_load8x8_s: 0x01,
  v128_load8x8_u: 0x02,
  v128_load16x4_s: 0x03,
  v128_load32x2_s: 0x05,
  v128_load8_splat: 0x07,
  v128_load32_splat: 0x09,
  v128_load64_splat: 0x0a,
  v128_store: 0x0b,
  v128_const: 0x0c,
  i8x16_shuffle: 0x0d,
  i8x16_swizzle: 0x0e,
  i8x16_splat: 0x0f,
  i16x8_splat: 0x10,
  i32x4_splat: 0x11,
  i64x2_splat: 0x12,
  f32x4_splat: 0x13,
  f64x2_splat: 0x14,
  v128_not: 0x4d,
  v128_and: 0x4e,
  v128_andnot: 0x4f,
  v128_or: 0x50,
  v128_xor: 0x51,
  v128_bitselect: 0x52,
  v128_any_true: 0x53,
  i8x16_add: 0x6e,
  i8x16_sub: 0x71,
  i16x8_add: 0x8e,
  i32x4_add: 0xae,
  i32x4_sub: 0xaf,
  i64x2_add: 0xce,
  f32x4_add: 0xe4,
  f64x2_add: 0xf0,
  i32x4_min_s: 0xb8,
  i32x4_max_s: 0xba,
} as const;

// ---------------------------------------------------------------------------
// Function body emitter
// ---------------------------------------------------------------------------

export class FuncEmitter {
  readonly body = new Buf(512);
  /** Declared local groups, in order. */
  private localGroups: Array<{ count: number; type: ValType }> = [];
  private localCount = 0;

  constructor(public readonly paramCount: number) {}

  /** Declare `count` locals of `type`; returns the index of the first one. */
  addLocals(count: number, type: ValType): number {
    const first = this.paramCount + this.localCount;
    this.localCount += count;
    const last = this.localGroups[this.localGroups.length - 1];
    if (last && last.type === type) last.count += count;
    else this.localGroups.push({ count, type });
    return first;
  }

  get localTotal(): number {
    return this.localCount;
  }

  private op(...bytes: number[]): this {
    for (const b of bytes) this.body.u8(b);
    return this;
  }

  // -- control ------------------------------------------------------------
  block(type: ValType | 'void' = 'void'): this {
    return this.op(OP.block, type === 'void' ? BLOCKTYPE_VOID : VALTYPE[type]);
  }
  loop(type: ValType | 'void' = 'void'): this {
    return this.op(OP.loop, type === 'void' ? BLOCKTYPE_VOID : VALTYPE[type]);
  }
  if(type: ValType | 'void' = 'void'): this {
    return this.op(OP.if, type === 'void' ? BLOCKTYPE_VOID : VALTYPE[type]);
  }
  else(): this {
    return this.op(OP.else);
  }
  end(): this {
    return this.op(OP.end);
  }
  br(depth: number): this {
    return this.op(OP.br).brUleb(depth);
  }
  brIf(depth: number): this {
    return this.op(OP.br_if).brUleb(depth);
  }
  brTable(targets: number[], defaultTarget: number): this {
    this.op(OP.br_table).brUleb(targets.length);
    for (const t of targets) this.brUleb(t);
    return this.brUleb(defaultTarget);
  }
  ret(): this {
    return this.op(OP.return);
  }
  call(funcIndex: number): this {
    return this.op(OP.call).brUleb(funcIndex);
  }
  callIndirect(typeIndex: number, tableIndex = 0): this {
    return this.op(OP.call_indirect).brUleb(typeIndex).brUleb(tableIndex);
  }
  /** Tail call: does not grow the Wasm stack. Used for region chaining (ADR-0003). */
  returnCall(funcIndex: number): this {
    return this.op(OP.return_call).brUleb(funcIndex);
  }
  returnCallIndirect(typeIndex: number, tableIndex = 0): this {
    return this.op(OP.return_call_indirect).brUleb(typeIndex).brUleb(tableIndex);
  }
  unreachable(): this {
    return this.op(OP.unreachable);
  }
  nop(): this {
    return this.op(OP.nop);
  }
  drop(): this {
    return this.op(OP.drop);
  }
  select(): this {
    return this.op(OP.select);
  }

  private brUleb(v: number): this {
    this.body.uleb(v);
    return this;
  }

  // -- variables ----------------------------------------------------------
  localGet(i: number): this {
    return this.op(OP.local_get).brUleb(i);
  }
  localSet(i: number): this {
    return this.op(OP.local_set).brUleb(i);
  }
  localTee(i: number): this {
    return this.op(OP.local_tee).brUleb(i);
  }
  globalGet(i: number): this {
    return this.op(OP.global_get).brUleb(i);
  }
  globalSet(i: number): this {
    return this.op(OP.global_set).brUleb(i);
  }

  // -- constants ----------------------------------------------------------
  i32(v: number): this {
    this.op(OP.i32_const);
    this.body.sleb(v | 0);
    return this;
  }
  i64(v: bigint): this {
    this.op(OP.i64_const);
    this.body.sleb64(v);
    return this;
  }
  f32(v: number): this {
    return this.op(OP.f32_const).f32Raw(v);
  }
  private f32Raw(v: number): this {
    this.body.f32(v);
    return this;
  }
  f64(v: number): this {
    this.op(OP.f64_const);
    this.body.f64(v);
    return this;
  }

  // -- memory -------------------------------------------------------------
  /** `align` is log2 of the natural alignment. */
  load(opcode: number, offset: number, align: number): this {
    this.op(opcode);
    this.body.uleb(align);
    this.body.uleb(offset >>> 0);
    return this;
  }
  store(opcode: number, offset: number, align: number): this {
    return this.load(opcode, offset, align);
  }
  i32Load(offset = 0, align = 2): this {
    return this.load(OP.i32_load, offset, align);
  }
  i32Load8u(offset = 0, align = 0): this {
    return this.load(OP.i32_load8_u, offset, align);
  }
  i32Load8s(offset = 0, align = 0): this {
    return this.load(OP.i32_load8_s, offset, align);
  }
  i32Load16u(offset = 0, align = 1): this {
    return this.load(OP.i32_load16_u, offset, align);
  }
  i32Load16s(offset = 0, align = 1): this {
    return this.load(OP.i32_load16_s, offset, align);
  }
  i64Load(offset = 0, align = 3): this {
    return this.load(OP.i64_load, offset, align);
  }
  i32Store(offset = 0, align = 2): this {
    return this.store(OP.i32_store, offset, align);
  }
  i32Store8(offset = 0, align = 0): this {
    return this.store(OP.i32_store8, offset, align);
  }
  i32Store16(offset = 0, align = 1): this {
    return this.store(OP.i32_store16, offset, align);
  }
  i64Store(offset = 0, align = 3): this {
    return this.store(OP.i64_store, offset, align);
  }
  /** 0xfc-prefixed bulk-memory ops (memory.copy / memory.fill). */
  memoryCopy(dstMem = 0, srcMem = 0): this {
    this.op(0xfc);
    this.body.uleb(0x0a);
    this.body.u8(dstMem);
    this.body.u8(srcMem);
    return this;
  }
  memoryFill(mem = 0): this {
    this.op(0xfc);
    this.body.uleb(0x0b);
    this.body.u8(mem);
    return this;
  }
  memorySize(mem = 0): this {
    return this.op(OP.memory_size).brUleb(mem);
  }
  memoryGrow(mem = 0): this {
    return this.op(OP.memory_grow).brUleb(mem);
  }

  // -- i32 arithmetic -----------------------------------------------------
  i32Eqz(): this {
    return this.op(OP.i32_eqz);
  }
  i32Eq(): this {
    return this.op(OP.i32_eq);
  }
  i32Ne(): this {
    return this.op(OP.i32_ne);
  }
  i32LtS(): this {
    return this.op(OP.i32_lt_s);
  }
  i32LtU(): this {
    return this.op(OP.i32_lt_u);
  }
  i32GtS(): this {
    return this.op(OP.i32_gt_s);
  }
  i32GtU(): this {
    return this.op(OP.i32_gt_u);
  }
  i32LeS(): this {
    return this.op(OP.i32_le_s);
  }
  i32LeU(): this {
    return this.op(OP.i32_le_u);
  }
  i32GeS(): this {
    return this.op(OP.i32_ge_s);
  }
  i32GeU(): this {
    return this.op(OP.i32_ge_u);
  }
  i32Add(): this {
    return this.op(OP.i32_add);
  }
  i32Sub(): this {
    return this.op(OP.i32_sub);
  }
  i32Mul(): this {
    return this.op(OP.i32_mul);
  }
  i32DivS(): this {
    return this.op(OP.i32_div_s);
  }
  i32DivU(): this {
    return this.op(OP.i32_div_u);
  }
  i32RemS(): this {
    return this.op(OP.i32_rem_s);
  }
  i32RemU(): this {
    return this.op(OP.i32_rem_u);
  }
  i32And(): this {
    return this.op(OP.i32_and);
  }
  i32Or(): this {
    return this.op(OP.i32_or);
  }
  i32Xor(): this {
    return this.op(OP.i32_xor);
  }
  i32Shl(): this {
    return this.op(OP.i32_shl);
  }
  i32ShrS(): this {
    return this.op(OP.i32_shr_s);
  }
  i32ShrU(): this {
    return this.op(OP.i32_shr_u);
  }
  i32Rotl(): this {
    return this.op(OP.i32_rotl);
  }
  i32Rotr(): this {
    return this.op(OP.i32_rotr);
  }
  i32Clz(): this {
    return this.op(OP.i32_clz);
  }
  i32Ctz(): this {
    return this.op(OP.i32_ctz);
  }
  i32Popcnt(): this {
    return this.op(OP.i32_popcnt);
  }

  // -- i64 arithmetic (used for MULH / cycle counters) --------------------
  i64Add(): this {
    return this.op(OP.i64_add);
  }
  i64Sub(): this {
    return this.op(OP.i64_sub);
  }
  i64Mul(): this {
    return this.op(OP.i64_mul);
  }
  i64DivS(): this {
    return this.op(OP.i64_div_s);
  }
  i64DivU(): this {
    return this.op(OP.i64_div_u);
  }
  i64RemS(): this {
    return this.op(OP.i64_rem_s);
  }
  i64RemU(): this {
    return this.op(OP.i64_rem_u);
  }
  i64And(): this {
    return this.op(OP.i64_and);
  }
  i64Or(): this {
    return this.op(OP.i64_or);
  }
  i64Xor(): this {
    return this.op(OP.i64_xor);
  }
  i64Shl(): this {
    return this.op(OP.i64_shl);
  }
  i64ShrS(): this {
    return this.op(OP.i64_shr_s);
  }
  i64ShrU(): this {
    return this.op(OP.i64_shr_u);
  }
  i64Eqz(): this {
    return this.op(OP.i64_eqz);
  }
  i64Eq(): this {
    return this.op(OP.i64_eq);
  }
  i64Ne(): this {
    return this.op(OP.i64_ne);
  }
  i64LtS(): this {
    return this.op(OP.i64_lt_s);
  }
  i64LtU(): this {
    return this.op(OP.i64_lt_u);
  }
  i64ExtendI32S(): this {
    return this.op(OP.i64_extend_i32_s);
  }
  i64ExtendI32U(): this {
    return this.op(OP.i64_extend_i32_u);
  }
  i32WrapI64(): this {
    return this.op(OP.i32_wrap_i64);
  }

  // -- atomics ------------------------------------------------------------
  private atomic(sub: number, offset: number, align: number): this {
    this.op(0xfe, sub);
    this.body.uleb(align);
    this.body.uleb(offset >>> 0);
    return this;
  }
  atomicFence(): this {
    this.op(0xfe, ATOMIC.fence);
    this.body.u8(0x00);
    return this;
  }
  i32AtomicLoad(offset = 0, align = 2): this {
    return this.atomic(ATOMIC.i32_load, offset, align);
  }
  i32AtomicLoad8u(offset = 0, align = 0): this {
    return this.atomic(ATOMIC.i32_load8_u, offset, align);
  }
  i32AtomicLoad16u(offset = 0, align = 1): this {
    return this.atomic(ATOMIC.i32_load16_u, offset, align);
  }
  i32AtomicStore(offset = 0, align = 2): this {
    return this.atomic(ATOMIC.i32_store, offset, align);
  }
  i32AtomicStore8(offset = 0, align = 0): this {
    return this.atomic(ATOMIC.i32_store8, offset, align);
  }
  i32AtomicStore16(offset = 0, align = 1): this {
    return this.atomic(ATOMIC.i32_store16, offset, align);
  }
  i32AtomicAdd(offset = 0, align = 2): this {
    return this.atomic(ATOMIC.i32_rmw_add, offset, align);
  }
  i32AtomicSub(offset = 0, align = 2): this {
    return this.atomic(ATOMIC.i32_rmw_sub, offset, align);
  }
  i32AtomicAnd(offset = 0, align = 2): this {
    return this.atomic(ATOMIC.i32_rmw_and, offset, align);
  }
  i32AtomicOr(offset = 0, align = 2): this {
    return this.atomic(ATOMIC.i32_rmw_or, offset, align);
  }
  i32AtomicXor(offset = 0, align = 2): this {
    return this.atomic(ATOMIC.i32_rmw_xor, offset, align);
  }
  i32AtomicXchg(offset = 0, align = 2): this {
    return this.atomic(ATOMIC.i32_rmw_xchg, offset, align);
  }
  i32AtomicCmpxchg(offset = 0, align = 2): this {
    return this.atomic(ATOMIC.i32_rmw_cmpxchg, offset, align);
  }
  i32AtomicRmw8AddU(offset = 0, align = 0): this {
    return this.atomic(ATOMIC.i32_rmw8_add_u, offset, align);
  }
  i32AtomicRmw16AddU(offset = 0, align = 1): this {
    return this.atomic(ATOMIC.i32_rmw16_add_u, offset, align);
  }
  /** addr, expected, timeout(ms) -> i32 status */
  memoryAtomicWait32(offset = 0, align = 2): this {
    return this.atomic(ATOMIC.wait32, offset, align);
  }
  /** addr, count -> i32 woken */
  memoryAtomicNotify(offset = 0, align = 2): this {
    return this.atomic(ATOMIC.notify, offset, align);
  }

  // -- SIMD ---------------------------------------------------------------
  private simd(sub: number): this {
    return this.op(0xfd).simdSub(sub);
  }
  private simdSub(sub: number): this {
    this.body.uleb(sub);
    return this;
  }
  v128Load(offset = 0, align = 4): this {
    this.op(0xfd);
    this.body.uleb(SIMD.v128_load);
    this.body.uleb(align);
    this.body.uleb(offset >>> 0);
    return this;
  }
  v128Store(offset = 0, align = 4): this {
    this.op(0xfd);
    this.body.uleb(SIMD.v128_store);
    this.body.uleb(align);
    this.body.uleb(offset >>> 0);
    return this;
  }
  v128Const(bytes: Uint8Array): this {
    this.op(0xfd);
    this.body.uleb(SIMD.v128_const);
    this.body.bytes(bytes);
    return this;
  }
  i8x16Splat(): this {
    return this.simd(SIMD.i8x16_splat);
  }
  i32x4Splat(): this {
    return this.simd(SIMD.i32x4_splat);
  }
  i32x4Add(): this {
    return this.simd(SIMD.i32x4_add);
  }
  i8x16Add(): this {
    return this.simd(SIMD.i8x16_add);
  }
  v128And(): this {
    return this.simd(SIMD.v128_and);
  }
  v128Or(): this {
    return this.simd(SIMD.v128_or);
  }
  v128Xor(): this {
    return this.simd(SIMD.v128_xor);
  }
  v128Bitselect(): this {
    return this.simd(SIMD.v128_bitselect);
  }
  i8x16Shuffle(lanes: number[]): this {
    this.op(0xfd);
    this.body.uleb(SIMD.i8x16_shuffle);
    for (const l of lanes) this.body.u8(l);
    return this;
  }
  /** Escape hatch for opcodes not modelled above. */
  raw(...bytes: number[]): this {
    return this.op(...bytes);
  }

  finish(): Uint8Array<ArrayBuffer> {
    const out = new Buf(this.body.length + 16);
    out.uleb(this.localGroups.length);
    for (const g of this.localGroups) {
      out.uleb(g.count);
      out.u8(VALTYPE[g.type]);
    }
    out.bytes(this.body.finish());
    out.u8(OP.end);
    return out.finish();
  }
}

// ---------------------------------------------------------------------------
// Module builder
// ---------------------------------------------------------------------------

export type ImportKind = 'func' | 'table' | 'mem' | 'global' | 'tag';

interface FuncDecl {
  name: string;
  typeIndex: number;
  emitter: FuncEmitter;
  importCount: number;
}

export interface MemoryOptions {
  min: number;
  max?: number;
  shared?: boolean;
  index64?: boolean;
}

export class WasmModuleBuilder {
  private types: Array<{ params: ValType[]; results: ValType[] }> = [];
  private imports: Array<{ module: string; name: string; kind: ImportKind; index: number }> = [];
  private importedGlobals: Array<{ type: ValType; mutable: boolean }> = [];
  private funcs: FuncDecl[] = [];
  private globals: Array<{ type: ValType; mutable: boolean; init: Uint8Array<ArrayBuffer> }> = [];
  private exports: Array<{ name: string; kind: ImportKind; index: number }> = [];
  private datas: Array<{ offsetExpr: Uint8Array<ArrayBuffer>; bytes: Uint8Array }> = [];
  private memory: MemoryOptions | null = null;
  private importedMemory = false;
  private startFunc: number | null = null;

  addType(params: ValType[], results: ValType[]): number {
    const existing = this.types.findIndex(
      (t) => t.params.join() === params.join() && t.results.join() === results.join(),
    );
    if (existing >= 0) return existing;
    this.types.push({ params, results });
    return this.types.length - 1;
  }

  private importCount(kind: ImportKind): number {
    return this.imports.filter((i) => i.kind === kind).length;
  }

  importFunc(module: string, name: string, params: ValType[], results: ValType[]): number {
    const typeIndex = this.addType(params, results);
    const index = this.importCount('func');
    this.imports.push({ module, name, kind: 'func', index: typeIndex });
    return index;
  }

  /** Import a funcref table. Region modules dispatch through it with `return_call_indirect`. */
  importTable(module: string, name: string, min: number, max?: number): number {
    const index = this.importCount('table');
    this.imports.push({ module, name, kind: 'table', index: min });
    this.importedTableMax = max;
    return index;
  }

  private importedTableMax: number | undefined;

  importMemory(module: string, name: string, opts: MemoryOptions): number {
    if (this.memory || this.importedMemory) throw new Error('module already has a memory');
    this.importedMemory = true;
    this.memory = opts;
    this.imports.push({ module, name, kind: 'mem', index: -1 });
    return 0;
  }

  importGlobal(module: string, name: string, type: ValType, mutable: boolean): number {
    const index = this.importCount('global');
    this.imports.push({ module, name, kind: 'global', index: mutable ? 1 : 0 });
    // stash the type in a parallel structure by reusing `globals` is not possible
    // for imports, so keep it in the import entry via a side table:
    this.importedGlobals.push({ type, mutable });
    return index;
  }

  addMemory(opts: MemoryOptions): void {
    if (this.memory || this.importedMemory) throw new Error('module already has a memory');
    this.memory = opts;
  }

  addGlobal(type: ValType, mutable: boolean, init: (e: FuncEmitter) => void): number {
    const e = new FuncEmitter(0);
    init(e);
    this.globals.push({ type, mutable, init: e.body.finish() });
    return this.importCount('global') + this.globals.length - 1;
  }

  addFunc(name: string, params: ValType[], results: ValType[]): FuncEmitter {
    const typeIndex = this.addType(params, results);
    const emitter = new FuncEmitter(params.length);
    this.funcs.push({ name, typeIndex, emitter, importCount: this.importCount('func') });
    return emitter;
  }

  funcIndexByName(name: string): number {
    const f = this.funcs.find((x) => x.name === name);
    if (!f) throw new Error(`no such function: ${name}`);
    return f.importCount + this.funcs.indexOf(f);
  }

  exportFunc(name: string, funcIndex: number): this {
    this.exports.push({ name, kind: 'func', index: funcIndex });
    return this;
  }

  exportMemory(name: string): this {
    this.exports.push({ name, kind: 'mem', index: 0 });
    return this;
  }

  exportGlobal(name: string, globalIndex: number): this {
    this.exports.push({ name, kind: 'global', index: globalIndex });
    return this;
  }

  addData(bytes: Uint8Array, offsetExpr: (e: FuncEmitter) => void): void {
    const e = new FuncEmitter(0);
    offsetExpr(e);
    e.end();
    this.datas.push({ offsetExpr: e.body.finish(), bytes });
  }

  setStart(funcIndex: number): void {
    this.startFunc = funcIndex;
  }

  /** Emit the module bytes. Sections are written in spec-mandated id order. */
  build(): Uint8Array<ArrayBuffer> {
    const out = new Buf(4096);
    out.u8(0x00).u8(0x61).u8(0x73).u8(0x6d); // \0asm
    out.u8(0x01).u8(0x00).u8(0x00).u8(0x00); // version 1

    // 1: types
    if (this.types.length) {
      const sec = new Buf();
      sec.uleb(this.types.length);
      for (const t of this.types) {
        sec.u8(0x60);
        sec.uleb(t.params.length);
        for (const p of t.params) sec.u8(VALTYPE[p]);
        sec.uleb(t.results.length);
        for (const r of t.results) sec.u8(VALTYPE[r]);
      }
      writeSection(out, 1, sec.finish());
    }

    // 2: imports
    if (this.imports.length) {
      const sec = new Buf();
      sec.uleb(this.imports.length);
      let globalIdx = 0;
      for (const imp of this.imports) {
        sec.name(imp.module);
        sec.name(imp.name);
        switch (imp.kind) {
          case 'func':
            sec.u8(0x00);
            sec.uleb(imp.index);
            break;
          case 'mem': {
            sec.u8(0x02);
            writeMemoryType(sec, this.memory!);
            break;
          }
          case 'table': {
            sec.u8(0x01);
            sec.u8(0x70); // funcref
            const hasMax = this.importedTableMax !== undefined;
            sec.u8(hasMax ? 0x01 : 0x00);
            sec.uleb(imp.index);
            if (hasMax) sec.uleb(this.importedTableMax!);
            break;
          }
          case 'global': {
            const g = this.importedGlobals[globalIdx++]!;
            sec.u8(0x03);
            sec.u8(VALTYPE[g.type]);
            sec.u8(g.mutable ? 0x01 : 0x00);
            break;
          }
          default:
            throw new Error(`unsupported import kind ${imp.kind}`);
        }
      }
      writeSection(out, 2, sec.finish());
    }

    // 3: functions
    if (this.funcs.length) {
      const sec = new Buf();
      sec.uleb(this.funcs.length);
      for (const f of this.funcs) sec.uleb(f.typeIndex);
      writeSection(out, 3, sec.finish());
    }

    // 5: memory (only when declared in-module rather than imported)
    if (this.memory && !this.importedMemory) {
      const sec = new Buf();
      sec.uleb(1);
      writeMemoryType(sec, this.memory);
      writeSection(out, 5, sec.finish());
    }

    // 6: globals
    if (this.globals.length) {
      const sec = new Buf();
      sec.uleb(this.globals.length);
      for (const g of this.globals) {
        sec.u8(VALTYPE[g.type]);
        sec.u8(g.mutable ? 0x01 : 0x00);
        sec.bytes(g.init);
        sec.u8(OP.end);
      }
      writeSection(out, 6, sec.finish());
    }

    // 7: exports
    if (this.exports.length) {
      const sec = new Buf();
      sec.uleb(this.exports.length);
      for (const e of this.exports) {
        sec.name(e.name);
        sec.u8(e.kind === 'func' ? 0x00 : e.kind === 'mem' ? 0x02 : e.kind === 'global' ? 0x03 : 0x01);
        sec.uleb(e.index);
      }
      writeSection(out, 7, sec.finish());
    }

    // 8: start
    if (this.startFunc !== null) {
      const sec = new Buf();
      sec.uleb(this.startFunc);
      writeSection(out, 8, sec.finish());
    }

    // 10: code
    if (this.funcs.length) {
      const sec = new Buf();
      sec.uleb(this.funcs.length);
      for (const f of this.funcs) {
        const body = f.emitter.finish();
        sec.uleb(body.length);
        sec.bytes(body);
      }
      writeSection(out, 10, sec.finish());
    }

    // 11: data
    if (this.datas.length) {
      const sec = new Buf();
      sec.uleb(this.datas.length);
      for (const d of this.datas) {
        sec.uleb(0x00);
        sec.bytes(d.offsetExpr as Uint8Array);
        sec.uleb(d.bytes.length);
        sec.bytes(d.bytes);
      }
      writeSection(out, 11, sec.finish());
    }

    return out.finish();
  }
}

function writeMemoryType(sec: Buf, m: MemoryOptions): void {
  let flags = 0;
  if (m.max !== undefined) flags |= 0x01;
  if (m.shared) flags |= 0x02;
  if (m.index64) flags |= 0x04;
  sec.u8(flags);
  sec.uleb(Number(m.min));
  if (m.max !== undefined) sec.uleb(Number(m.max));
}

function writeSection(out: Buf, id: number, payload: Uint8Array<ArrayBuffer>): void {
  out.u8(id);
  out.uleb(payload.length);
  out.bytes(payload);
}

/** Convenience: build + compile, surfacing validation errors with context. */
export async function compileModule(
  bytes: Uint8Array<ArrayBuffer>,
  imports?: WebAssembly.Imports,
): Promise<WebAssembly.Instance> {
  const mod = await WebAssembly.compile(bytes);
  return WebAssembly.instantiate(mod, imports ?? {});
}

/** Synchronous compile+instantiate (used by the JIT hot path). */
export function compileModuleSync(
  bytes: Uint8Array<ArrayBuffer>,
  imports?: WebAssembly.Imports,
): WebAssembly.Instance {
  const mod = new WebAssembly.Module(bytes);
  return new WebAssembly.Instance(mod, imports ?? {});
}

/**
 * Create a funcref table.
 *
 * Portability note discovered while spiking region chaining (ADR-0003): the
 * descriptor's `element` field is spelled `'funcref'` by current browsers but
 * Node 22 still only accepts the older `'anyfunc'`. Everything that builds a
 * dispatch table goes through here so the difference is handled once.
 */
export function createFuncTable(min: number, max?: number): WebAssembly.Table {
  const base = { initial: min, ...(max !== undefined ? { maximum: max } : {}) };
  try {
    return new WebAssembly.Table({ ...base, element: 'funcref' } as unknown as WebAssembly.TableDescriptor);
  } catch {
    return new WebAssembly.Table({ ...base, element: 'anyfunc' } as unknown as WebAssembly.TableDescriptor);
  }
}
