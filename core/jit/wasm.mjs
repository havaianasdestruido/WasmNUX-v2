// Minimal binary encoder for the spike. Keep indices and immediates explicit.
export function leb(n, signed = false) {
  n = BigInt(n);
  if (!signed && n < 0n) throw new RangeError('negative unsigned LEB');
  const out = [];
  for (;;) {
    const byte = Number(n & 127n);
    n >>= 7n;
    if ((!signed && n === 0n) || (signed && ((n === 0n && !(byte & 64)) || (n === -1n && (byte & 64))))) {
      return [...out, byte];
    }
    out.push(byte | 128);
  }
}
const str = s => { const b = [...new TextEncoder().encode(s)]; return [...leb(b.length), ...b]; };
const section = (id, bytes) => [id, ...leb(bytes.length), ...bytes];
const vec = entries => [...leb(entries.length), ...entries.flat()];
export function wasm(functions, shared = false) {
  return new Uint8Array([
    0, 97, 115, 109, 1, 0, 0, 0,
    ...section(1, vec(functions.map(({params, results}) => [0x60, ...vec(params), ...vec(results)]))),
    ...section(2, vec([[...str('env'), ...str('mem'), 2, shared ? 3 : 1, 1, 1]])),
    ...section(3, vec(functions.map((_, i) => leb(i)))),
    ...section(7, vec(functions.map(({name}, i) => [...str(name), 0, ...leb(i)]))),
    ...section(10, vec(functions.map(({code}) => [...leb(code.length + 2), 0, ...code, 0x0b])))
  ]);
}
