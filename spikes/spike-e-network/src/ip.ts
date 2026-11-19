/**
 * Spike E — minimal user-space network codecs + echo stack (ADR-0008).
 *
 * Scope for Phase 0: RFC 1071 checksum, IPv4/UDP/ICMPv4 build+parse, and an
 * ICMP echo responder — the pieces the relay/NAT path must handle first.
 * TCP and the WebSocket/WebRTC relay framing live in `relay.ts`.
 */

export function checksum16(bytes: Uint8Array, initial = 0): number {
  let sum = initial;
  let i = 0;
  for (; i + 1 < bytes.length; i += 2) {
    sum += (bytes[i]! << 8) | bytes[i + 1]!;
  }
  if (i < bytes.length) sum += bytes[i]! << 8;
  while (sum > 0xffff) sum = (sum & 0xffff) + (sum >>> 16);
  return (~sum) & 0xffff;
}

export interface Ipv4Packet {
  src: Uint8Array;   // 4 bytes
  dst: Uint8Array;
  protocol: number;  // 1 = ICMP, 17 = UDP
  payload: Uint8Array;
}

export function ipToBytes(ip: string): Uint8Array {
  const parts = ip.split(".").map((p) => Number(p));
  if (parts.length !== 4 || parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255)) {
    throw new Error(`bad IPv4: ${ip}`);
  }
  return Uint8Array.from(parts);
}

export function bytesToIp(b: Uint8Array): string {
  return `${b[0]}.${b[1]}.${b[2]}.${b[3]}`;
}

export function buildIpv4(pkt: Ipv4Packet, ttl = 64, identification = 0): Uint8Array {
  const total = 20 + pkt.payload.length;
  const out = new Uint8Array(total);
  const v = new DataView(out.buffer);
  out[0] = 0x45; // v4, IHL 5
  out[1] = 0x00; // DSCP
  v.setUint16(2, total, false);
  v.setUint16(4, identification, false);
  v.setUint16(6, 0, false); // flags/fragment
  out[8] = ttl;
  out[9] = pkt.protocol;
  out.set(pkt.src, 12);
  out.set(pkt.dst, 16);
  const csum = checksum16(out.subarray(0, 20));
  v.setUint16(10, csum, false);
  out.set(pkt.payload, 20);
  return out;
}

export function parseIpv4(bytes: Uint8Array): Ipv4Packet & { ttl: number; headerChecksumOk: boolean } {
  if (bytes.length < 20) throw new Error("short IPv4");
  if ((bytes[0]! >> 4) !== 4) throw new Error("not IPv4");
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const ihl = (bytes[0]! & 0xf) * 4;
  const total = v.getUint16(2, false);
  return {
    src: bytes.subarray(12, 16),
    dst: bytes.subarray(16, 20),
    protocol: bytes[9]!,
    ttl: bytes[8]!,
    payload: bytes.subarray(ihl, total),
    headerChecksumOk: checksum16(bytes.subarray(0, ihl)) === 0,
  };
}

export interface UdpDatagram {
  srcPort: number;
  dstPort: number;
  payload: Uint8Array;
}

export function buildUdp(d: UdpDatagram, srcIp: Uint8Array, dstIp: Uint8Array): Uint8Array {
  const out = new Uint8Array(8 + d.payload.length);
  const v = new DataView(out.buffer);
  v.setUint16(0, d.srcPort, false);
  v.setUint16(2, d.dstPort, false);
  v.setUint16(4, out.length, false);
  out.set(d.payload, 8);
  // pseudo-header checksum
  const pseudo = new Uint8Array(12 + out.length);
  pseudo.set(srcIp, 0);
  pseudo.set(dstIp, 4);
  pseudo[8] = 0;
  pseudo[9] = 17;
  const pv = new DataView(pseudo.buffer);
  pv.setUint16(10, out.length, false);
  pseudo.set(out, 12);
  const c = checksum16(pseudo);
  v.setUint16(6, c === 0 ? 0xffff : c, false);
  return out;
}

export function parseUdp(bytes: Uint8Array): UdpDatagram & { checksumOk: (src: Uint8Array, dst: Uint8Array) => boolean } {
  if (bytes.length < 8) throw new Error("short UDP");
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const srcPort = v.getUint16(0, false);
  const dstPort = v.getUint16(2, false);
  const len = v.getUint16(4, false);
  const ck = v.getUint16(6, false);
  const payload = bytes.subarray(8, len);
  return {
    srcPort, dstPort, payload,
    checksumOk: (src, dst) => {
      const pseudo = new Uint8Array(12 + len);
      pseudo.set(src.subarray(0, 4), 0);
      pseudo.set(dst.subarray(0, 4), 4);
      pseudo[9] = 17;
      new DataView(pseudo.buffer).setUint16(10, len, false);
      pseudo.set(bytes.subarray(0, len), 12);
      if (ck === 0) return true; // IPv4 UDP checksum optional
      return checksum16(pseudo) === 0;
    },
  };
}

export function buildIcmpEcho(id: number, seq: number, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(8 + data.length);
  const v = new DataView(out.buffer);
  out[0] = 8; // echo request
  out[1] = 0;
  v.setUint16(4, 0, false); // checksum placeholder
  v.setUint16(6, id, false);
  v.setUint16(8 - 2, seq, false); // seq at offset 6? — no: id@4, seq@6 → fix below
  // layout: type(0) code(1) cksum(2) id(4) seq(6) data(8)
  v.setUint16(4, id, false);
  v.setUint16(6, seq, false);
  out.set(data, 8);
  const c = checksum16(out);
  v.setUint16(2, c, false);
  return out;
}

export function parseIcmpEcho(bytes: Uint8Array): { type: number; id: number; seq: number; data: Uint8Array; checksumOk: boolean } {
  if (bytes.length < 8) throw new Error("short ICMP");
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return {
    type: bytes[0]!,
    id: v.getUint16(4, false),
    seq: v.getUint16(6, false),
    data: bytes.subarray(8),
    checksumOk: checksum16(bytes) === 0,
  };
}

/**
 * Host that answers ICMP echo requests and UDP echo (port 7) — the "does the
 * relay path actually move packets" probe of spike E.
 */
export class EchoStack {
  readonly icmpReplies: Uint8Array[] = [];
  readonly udpReplies: Uint8Array[] = [];

  constructor(readonly localIp: Uint8Array) {}

  handle(raw: Uint8Array): void {
    const ip = parseIpv4(raw);
    if (ip.protocol === 1) {
      const icmp = parseIcmpEcho(ip.payload);
      if (icmp.type === 8 && icmp.checksumOk) {
        const reply = buildIcmpEcho(icmp.id, icmp.seq, icmp.data);
        reply[0] = 0; // echo reply — reuse builder then patch type+checksum
        const v = new DataView(reply.buffer);
        v.setUint16(2, 0, false);
        v.setUint16(2, checksum16(reply), false);
        this.icmpReplies.push(buildIpv4({
          src: this.localIp,
          dst: ip.src,
          protocol: 1,
          payload: reply,
        }));
      }
    } else if (ip.protocol === 17) {
      const udp = parseUdp(ip.payload);
      if (udp.dstPort === 7) {
        const resp = buildUdp(
          { srcPort: 7, dstPort: udp.srcPort, payload: udp.payload },
          this.localIp,
          ip.src,
        );
        this.udpReplies.push(buildIpv4({
          src: this.localIp,
          dst: ip.src,
          protocol: 17,
          payload: resp,
        }));
      }
    }
  }
}
