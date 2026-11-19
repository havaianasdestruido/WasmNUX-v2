import {wasm} from '../jit/wasm.mjs';
const i32 = 0x7f, i64 = 0x7e;
const module = new WebAssembly.Module(wasm([
  {name:'load', params:[i32], results:[i64], code:[0x20,0,0xfe,0x11,3,0]},
  {name:'cas', params:[i32,i64,i64], results:[i64], code:[0x20,0,0x20,1,0x20,2,0xfe,0x49,3,0]},
], true));

// Prototype RV64 LR.W/SC.W/AMOADD.W. Each 32-bit guest word occupies an
// aligned 64-bit host slot (version | data). All writes must use this ABI.
// This is SC-strength, word-granular, and not a full RVWMO implementation.
export class Hart {
  #reservation;
  #wasm;
  constructor(mem) { this.#wasm = new WebAssembly.Instance(module, {env:{mem}}).exports; }
  #address(address) {
    if (!Number.isInteger(address) || address < 0 || address % 4 || address >= 32768) throw new RangeError('unaligned/unmapped atomic word');
    return address * 2;
  }
  read(address) { return Number(BigInt.asIntN(32, this.#wasm.load(this.#address(address)))); }
  lr(address) {
    const index = this.#address(address), word = this.#wasm.load(index);
    this.#reservation = {index, word};
    return Number(BigInt.asIntN(32, word));
  }
  sc(address, value) {
    const r = this.#reservation;
    this.#reservation = undefined;
    const index = this.#address(address);
    if (r?.index !== index) return 1;
    return this.#wasm.cas(index, r.word, next(r.word, value)) === r.word ? 0 : 1;
  }
  amoAdd(address, delta) {
    const index = this.#address(address);
    for (;;) {
      const word = this.#wasm.load(index);
      const value = Number(BigInt.asIntN(32, word));
      if (this.#wasm.cas(index, word, next(word, value + (delta | 0))) === word) return value;
    }
  }
}
const next = (word, value) => BigInt.asIntN(64, ((word >> 32n) + 1n << 32n) | BigInt(value >>> 0));

// SC store-buffering litmus keyed to one shared rendezvous counter. A worker
// that arrives first parks until its peer reaches the same phase.
export function storeBuffering(hart, control, id, rounds = 256) {
  const synchronize = phase => {
    const arrived = Atomics.add(control, 0, 1) + 1;
    if (arrived === phase) { Atomics.notify(control, 0); return; }
    for (let value = Atomics.load(control, 0); value < phase; value = Atomics.load(control, 0)) {
      if (Atomics.wait(control, 0, value, 5000) === 'timed-out') throw new Error('litmus barrier timed out');
    }
  };
  const own = 64 + id*4, peer = 64 + (id^1)*4;
  for (let trial = 0; trial < rounds; trial++) {
    hart.amoAdd(own, -hart.read(own));
    synchronize(4*trial + 2);
    hart.amoAdd(own, 1);
    Atomics.store(control, id + 1, hart.read(peer));
    synchronize(4*trial + 4);
    // The next trial's phase 1 precedes any write to results, so reading
    // either side's result after phase 2 sees this same coordinate.
    if (Atomics.load(control, 1) === 0 && Atomics.load(control, 2) === 0) throw new Error('forbidden SC store-buffering outcome');
  }
  return rounds;
}
