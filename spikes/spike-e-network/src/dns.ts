/**
 * Minimal DNS wire-format codec (RFC 1035) — just enough for a DoH/DoT client
 * and for tests. No network I/O happens here.
 */
export const TYPE = { A: 1, AAAA: 28, CNAME: 5 } as const;
const CLASS_IN = 1;

export function encodeQuery(id: number, name: string, type: number): Uint8Array {
  const labels = name.split('.').filter(Boolean);
  const qname: number[] = [];
  for (const label of labels) {
    if (label.length > 63) throw new Error('label too long');
    qname.push(label.length, ...[...label].map(c => c.charCodeAt(0)));
  }
  qname.push(0);
  const out = new Uint8Array(12 + qname.length + 4);
  const dv = new DataView(out.buffer);
  dv.setUint16(0, id, false);
  dv.setUint16(2, 0x0100, false); // RD
  dv.setUint16(4, 1, false);      // QDCOUNT
  dv.setUint16(6, 0, false);      // ANCOUNT
  out.set(qname, 12);
  dv.setUint16(12 + qname.length, type, false);
  dv.setUint16(12 + qname.length + 2, CLASS_IN, false);
  return out;
}

export interface DnsAnswer { name: string; type: number; ttl: number; address?: string; cname?: string }
export interface DnsResponse { id: number; rcode: number; answers: DnsAnswer[] }

const MAX_NAME_BYTES = 255;   // RFC 1035 absolute limit (labels incl. length octets + root)
const MAX_JUMPS = 16;         // compression pointers may chain, but bounded

function readName(buf: Uint8Array, off: number): { name: string; next: number } {
  const labels: string[] = [];
  let jumped = false;
  let next = off;
  let total = 0;              // bytes of expanded name
  const seenOffsets = new Set<number>();
  let jumps = 0;
  for (;;) {
    if (off < 0 || off >= buf.length) throw new Error('DNS name pointer out of bounds');
    const len = buf[off]!;
    if (len === 0) { off += 1; if (!jumped) next = off; break; }
    if ((len & 0xc0) === 0xc0) {
      if (off + 1 >= buf.length) throw new Error('truncated DNS compression pointer');
      const ptr = ((len & 0x3f) << 8) | buf[off + 1]!;
      if (seenOffsets.has(ptr)) throw new Error('cyclic DNS compression pointer');
      seenOffsets.add(ptr);
      if (++jumps > MAX_JUMPS) throw new Error('too many DNS compression pointer jumps');
      // Forward/self references are syntactically legal but pathological; the
      // seenOffsets set + jump cap make them safe regardless.
      if (!jumped) next = off + 2;
      off = ptr;
      jumped = true;
      continue;
    }
    if ((len & 0xc0) !== 0) throw new Error('invalid DNS label length bits');
    if (off + 1 + len > buf.length) throw new Error('truncated DNS label');
    total += len + 1;
    if (total > MAX_NAME_BYTES) throw new Error('DNS name exceeds 255 bytes');
    labels.push(new TextDecoder().decode(buf.subarray(off + 1, off + 1 + len)));
    off += 1 + len;
    if (!jumped) next = off;
  }
  return { name: labels.join('.'), next };
}

export function parseResponse(buf: Uint8Array): DnsResponse {
  if (buf.length < 12) throw new Error('DNS message too short');
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const id = dv.getUint16(0, false);
  const flags = dv.getUint16(2, false);
  const rcode = flags & 0x000f;
  const qd = dv.getUint16(4, false);
  const an = dv.getUint16(6, false);
  let off = 12;
  for (let i = 0; i < qd; i++) {
    const { next } = readName(buf, off);
    off = next + 4; // QTYPE + QCLASS
  }
  const answers: DnsAnswer[] = [];
  for (let i = 0; i < an; i++) {
    const { name, next } = readName(buf, off);
    off = next;
    const type = dv.getUint16(off, false);
    const ttl = dv.getUint32(off + 4, false);
    const rdlen = dv.getUint16(off + 8, false);
    const rdata = off + 10;
    let address: string | undefined;
    let cname: string | undefined;
    if (type === TYPE.A && rdlen === 4) {
      address = [...buf.subarray(rdata, rdata + 4)].join('.');
    } else if (type === TYPE.AAAA && rdlen === 16) {
      const dv6 = new DataView(buf.buffer, buf.byteOffset + rdata, 16);
      const groups: string[] = [];
      for (let g = 0; g < 8; g++) groups.push(dv6.getUint16(g * 2, false).toString(16));
      address = groups.join(':');
    } else if (type === TYPE.CNAME) {
      cname = readName(buf, rdata).name;
    }
    answers.push(address !== undefined ? { name, type, ttl, address } : cname !== undefined ? { name, type, ttl, cname } : { name, type, ttl });
    off = rdata + rdlen;
  }
  return { id, rcode, answers };
}
