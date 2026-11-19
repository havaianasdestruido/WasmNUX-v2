/**
 * Packet (de)serialization for the spike user-space TCP/IP stack.
 * All multi-byte integers are big-endian (network order).
 */

export function checksum16(data: Uint8Array): number {
  let sum = 0;
  for (let i = 0; i + 1 < data.length; i += 2) {
    sum += (data[i]! << 8) | data[i + 1]!;
  }
  if (data.length % 2) sum += data[data.length - 1]! << 8;
  while (sum >> 16) sum = (sum & 0xffff) + (sum >> 16);
  return (~sum) & 0xffff;
}

export const ETHERTYPE = { ARP: 0x0806, IPv4: 0x0800 } as const;
export const IPPROTO = { ICMP: 1, TCP: 6, UDP: 17 } as const;
export const BROADCAST_MAC = new Uint8Array([0xff, 0xff, 0xff, 0xff, 0xff, 0xff]);

export function macBytes(mac: string): Uint8Array {
  const parts = mac.split(':').map(p => parseInt(p, 16));
  if (parts.length !== 6 || parts.some(p => Number.isNaN(p) || p < 0 || p > 255)) {
    throw new Error(`bad MAC: ${mac}`);
  }
  return new Uint8Array(parts);
}

export function macToString(mac: Uint8Array): string {
  return [...mac.subarray(0, 6)].map(b => b.toString(16).padStart(2, '0')).join(':');
}

export function ipBytes(ip: string): Uint8Array {
  const parts = ip.split('.').map(p => Number(p));
  if (parts.length !== 4 || parts.some(p => !Number.isInteger(p) || p < 0 || p > 255)) {
    throw new Error(`bad IPv4: ${ip}`);
  }
  return new Uint8Array(parts);
}

export function ipToString(ip: Uint8Array): string {
  return [...ip.subarray(0, 4)].join('.');
}

// ---------- Ethernet ----------
export interface EthernetFrame { dst: Uint8Array; src: Uint8Array; ethertype: number; payload: Uint8Array }
export function buildEthernet(dst: Uint8Array, src: Uint8Array, ethertype: number, payload: Uint8Array): Uint8Array {
  const out = new Uint8Array(14 + payload.length);
  out.set(dst, 0); out.set(src, 6);
  out[12] = (ethertype >> 8) & 0xff; out[13] = ethertype & 0xff;
  out.set(payload, 14);
  return out;
}
export function parseEthernet(frame: Uint8Array): EthernetFrame | null {
  if (frame.length < 14) return null;
  return {
    dst: frame.slice(0, 6),
    src: frame.slice(6, 12),
    ethertype: (frame[12]! << 8) | frame[13]!,
    payload: frame.slice(14),
  };
}

// ---------- ARP ----------
export interface ArpPacket { oper: 1 | 2; sha: Uint8Array; spa: Uint8Array; tha: Uint8Array; tpa: Uint8Array }
export function buildArp(p: ArpPacket): Uint8Array {
  const out = new Uint8Array(28);
  const dv = new DataView(out.buffer);
  dv.setUint16(0, 1, false);       // htype ethernet
  dv.setUint16(2, 0x0800, false);  // ptype IPv4
  out[4] = 6; out[5] = 4;          // hlen plen
  dv.setUint16(6, p.oper, false);
  out.set(p.sha, 8); out.set(p.spa, 14); out.set(p.tha, 18); out.set(p.tpa, 24);
  return out;
}
export function parseArp(data: Uint8Array): ArpPacket | null {
  if (data.length < 28) return null;
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  if (dv.getUint16(0, false) !== 1 || dv.getUint16(2, false) !== 0x0800) return null;
  const oper = dv.getUint16(6, false);
  if (oper !== 1 && oper !== 2) return null;
  return {
    oper,
    sha: data.slice(8, 14), spa: data.slice(14, 18),
    tha: data.slice(18, 24), tpa: data.slice(24, 28),
  };
}

// ---------- IPv4 ----------
export interface Ipv4Packet { src: Uint8Array; dst: Uint8Array; protocol: number; ttl: number; id: number; payload: Uint8Array }
export function buildIpv4(p: Ipv4Packet): Uint8Array {
  const total = 20 + p.payload.length;
  const out = new Uint8Array(total);
  const dv = new DataView(out.buffer);
  out[0] = 0x45; out[1] = 0;
  dv.setUint16(2, total, false);
  dv.setUint16(4, p.id & 0xffff, false);
  dv.setUint16(6, 0x4000, false); // don't fragment
  out[8] = p.ttl; out[9] = p.protocol;
  dv.setUint16(10, 0, false);
  out.set(p.src, 12); out.set(p.dst, 16);
  dv.setUint16(10, checksum16(out), false);
  out.set(p.payload, 20);
  return out;
}
export function parseIpv4(data: Uint8Array): Ipv4Packet | null {
  if (data.length < 20) return null;
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  if ((data[0]! >> 4) !== 4) return null;
  const ihl = (data[0]! & 0x0f) * 4;
  if (ihl < 20 || ihl > data.length) return null;
  const total = dv.getUint16(2, false);
  if (total > data.length) return null;
  const hdr = data.subarray(0, ihl);
  if (checksum16(hdr) !== 0) return null; // header checksum must sum to zero
  return {
    src: data.slice(12, 16),
    dst: data.slice(16, 20),
    protocol: data[9]!,
    ttl: data[8]!,
    id: dv.getUint16(4, false),
    payload: data.slice(ihl, total),
  };
}

// ---------- ICMP ----------
export interface IcmpPacket { type: number; code: number; id: number; seq: number; payload: Uint8Array }
export function buildIcmp(p: IcmpPacket): Uint8Array {
  const out = new Uint8Array(8 + p.payload.length);
  const dv = new DataView(out.buffer);
  out[0] = p.type; out[1] = p.code;
  dv.setUint16(2, 0, false);
  dv.setUint16(4, p.id, false);
  dv.setUint16(6, p.seq, false);
  out.set(p.payload, 8);
  dv.setUint16(2, checksum16(out), false);
  return out;
}
export function parseIcmp(data: Uint8Array): IcmpPacket | null {
  if (data.length < 8) return null;
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  if (checksum16(data) !== 0) return null;
  return { type: data[0]!, code: data[1]!, id: dv.getUint16(4, false), seq: dv.getUint16(6, false), payload: data.slice(8) };
}

// ---------- UDP ----------
export interface UdpPacket { srcPort: number; dstPort: number; src: Uint8Array; dst: Uint8Array; payload: Uint8Array }
export function buildUdp(p: Omit<UdpPacket, 'src' | 'dst'>, src: Uint8Array, dst: Uint8Array): Uint8Array {
  const len = 8 + p.payload.length;
  const out = new Uint8Array(len);
  const dv = new DataView(out.buffer);
  dv.setUint16(0, p.srcPort, false);
  dv.setUint16(2, p.dstPort, false);
  dv.setUint16(4, len, false);
  dv.setUint16(6, 0, false); // checksum optional in IPv4; 0 = none
  out.set(p.payload, 8);
  return out;
}
export function parseUdp(data: Uint8Array): { srcPort: number; dstPort: number; payload: Uint8Array } | null {
  if (data.length < 8) return null;
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const len = dv.getUint16(4, false);
  if (len < 8 || len > data.length) return null;
  return { srcPort: dv.getUint16(0, false), dstPort: dv.getUint16(2, false), payload: data.slice(8, len) };
}

// ---------- TCP (minimal, no options, no retransmission) ----------
export const TCP_FLAG = { FIN: 0x01, SYN: 0x02, RST: 0x04, PSH: 0x08, ACK: 0x10 } as const;
export interface TcpSegment {
  srcPort: number; dstPort: number; seq: number; ack: number;
  flags: number; window: number; payload: Uint8Array;
}
export function buildTcp(s: TcpSegment, srcIp: Uint8Array, dstIp: Uint8Array): Uint8Array {
  const len = 20 + s.payload.length;
  const out = new Uint8Array(len);
  const dv = new DataView(out.buffer);
  dv.setUint16(0, s.srcPort, false);
  dv.setUint16(2, s.dstPort, false);
  dv.setUint32(4, s.seq >>> 0, false);
  dv.setUint32(8, s.ack >>> 0, false);
  out[12] = 0x50; // data offset 5 (20 B)
  out[13] = s.flags & 0x3f;
  dv.setUint16(14, s.window, false);
  dv.setUint16(16, 0, false);
  dv.setUint16(18, 0, false);
  out.set(s.payload, 20);
  // pseudo-header checksum
  const pseudo = new Uint8Array(12 + len);
  pseudo.set(srcIp, 0); pseudo.set(dstIp, 4);
  pseudo[8] = 0; pseudo[9] = IPPROTO.TCP;
  pseudo[10] = (len >> 8) & 0xff; pseudo[11] = len & 0xff;
  pseudo.set(out, 12);
  dv.setUint16(16, checksum16(pseudo), false);
  return out;
}
export function parseTcp(data: Uint8Array, srcIp: Uint8Array, dstIp: Uint8Array): TcpSegment | null {
  if (data.length < 20) return null;
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const offset = (data[12]! >> 4) * 4;
  if (offset < 20 || offset > data.length) return null;
  const len = data.length;
  const pseudo = new Uint8Array(12 + len);
  pseudo.set(srcIp, 0); pseudo.set(dstIp, 4);
  pseudo[8] = 0; pseudo[9] = IPPROTO.TCP;
  pseudo[10] = (len >> 8) & 0xff; pseudo[11] = len & 0xff;
  pseudo.set(data, 12);
  if (checksum16(pseudo) !== 0) return null;
  return {
    srcPort: dv.getUint16(0, false),
    dstPort: dv.getUint16(2, false),
    seq: dv.getUint32(4, false),
    ack: dv.getUint32(8, false),
    flags: data[13]!,
    window: dv.getUint16(14, false),
    payload: data.slice(offset),
  };
}
