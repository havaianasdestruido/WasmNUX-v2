/**
 * MiniStack — a minimal user-space IPv4 stack for the spike:
 * ARP resolution, ICMP echo server, UDP, and a no-options/no-retransmit TCP
 * sufficient for short request/response exchanges on a reliable in-memory wire.
 * NOT wire-compatible production code: the point is to prove the architecture
 * (packet path, ARP, port demux, TCP handshake) is cheap and testable.
 */
import {
  ETHERTYPE, IPPROTO, BROADCAST_MAC,
  buildArp, buildEthernet, buildIcmp, buildIpv4, buildTcp, buildUdp,
  ipBytes, ipToString, macBytes, macToString,
  parseArp, parseEthernet, parseIcmp, parseIpv4, parseTcp, parseUdp,
  TCP_FLAG,
} from './packets.js';

export class Wire {
  private endpoints = new Set<MiniStack>();
  attach(s: MiniStack): void { this.endpoints.add(s); }
  detach(s: MiniStack): void { this.endpoints.delete(s); }
  /** Broadcast-capable synchronous delivery (the wire is a shared medium). */
  send(from: MiniStack, frame: Uint8Array): void {
    const parsed = parseEthernet(frame);
    if (!parsed) return;
    for (const ep of this.endpoints) {
      if (ep === from) continue;
      if (isBcast(parsed.dst) || macEq(parsed.dst, ep.macBytes)) {
        ep.receive(frame);
      }
    }
  }
}

export function macEq(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}
export function isBcast(mac: Uint8Array): boolean { return macEq(mac, BROADCAST_MAC); }

export type UdpHandler = (payload: Uint8Array, srcIp: string, srcPort: number) => void;
export type TcpConnectionHandler = (conn: TcpConnection) => void;
export type TcpDataHandler = (conn: TcpConnection, data: Uint8Array) => void;
export type TcpCloseHandler = (conn: TcpConnection) => void;

let nextEphemeralPort = 40_000;
let nextInitialSeq = 0x1000_0000;

function allocEphemeral(): number {
  nextEphemeralPort = nextEphemeralPort >= 60_000 ? 40_000 : nextEphemeralPort + 1;
  return nextEphemeralPort;
}

export class TcpConnection {
  readonly localPort: number;
  readonly remotePort: number;
  readonly remoteIp: string;
  state: 'syn_sent' | 'syn_received' | 'established' | 'closed' = 'closed';
  onData: TcpDataHandler | null = null;
  onClose: TcpCloseHandler | null = null;
  private seq: number;
  private ack = 0;
  private readonly stack: MiniStack;

  constructor(stack: MiniStack, localPort: number, remoteIp: string, remotePort: number) {
    this.stack = stack;
    this.localPort = localPort;
    this.remoteIp = remoteIp;
    this.remotePort = remotePort;
    this.seq = (nextInitialSeq = (nextInitialSeq + 0x9e3779b9) >>> 0);
  }

  key(): string { return `${this.stack.ipString}:${this.localPort}->${this.remoteIp}:${this.remotePort}`; }
  keyReverse(): string { return `${this.remoteIp}:${this.remotePort}->${this.stack.ipString}:${this.localPort}`; }

  /** active open */
  connect(): void {
    this.state = 'syn_sent';
    this.stack.sendTcp(this, TCP_FLAG.SYN, new Uint8Array(0));
  }
  /** @internal passive open: adopt peer ISN, send SYN+ACK */
  initPassive(peerIsn: number): void {
    this.ack = (peerIsn + 1) >>> 0;
    this.state = 'syn_received';
    this.stack.sendTcp(this, TCP_FLAG.SYN | TCP_FLAG.ACK, new Uint8Array(0));
  }
  send(data: Uint8Array): void {
    if (this.state !== 'established') throw new Error(`send on connection in state ${this.state}`);
    this.stack.sendTcp(this, TCP_FLAG.ACK | TCP_FLAG.PSH, data);
  }
  close(): void {
    if (this.state === 'closed') return;
    this.state = 'closed';
    this.stack.removeConnection(this); // see FIN branch: quiesce before send
    this.stack.sendTcp(this, TCP_FLAG.FIN | TCP_FLAG.ACK, new Uint8Array(0));
    this.onClose?.(this);
  }

  /** @internal */ handleSegment(flags: number, seq: number, ack: number, payload: Uint8Array): void {
    const hasSyn = (flags & TCP_FLAG.SYN) !== 0;
    const hasAck = (flags & TCP_FLAG.ACK) !== 0;
    const hasFin = (flags & TCP_FLAG.FIN) !== 0;
    if (this.state === 'syn_sent' && hasSyn && hasAck) {
      this.ack = (seq + 1) >>> 0;
      this.seq = ack >>> 0; // our seq becomes their ack
      this.state = 'established';
      this.stack.sendTcp(this, TCP_FLAG.ACK, new Uint8Array(0));
      return;
    }
    if (this.state === 'syn_received' && hasAck) {
      this.state = 'established';
      return;
    }
    if (this.state === 'established' || this.state === 'syn_received') {
      if (payload.length > 0) {
        this.ack = (seq + payload.length) >>> 0;
        this.stack.sendTcp(this, TCP_FLAG.ACK, new Uint8Array(0)); // piggyback ACK
        this.onData?.(this, payload);
      }
      if (hasFin) {
        this.ack = (seq + payload.length + 1) >>> 0;
        // Close locally BEFORE transmitting: the wire is synchronous, and a
        // peer replying FIN mid-send must not re-enter this branch forever.
        this.state = 'closed';
        this.stack.removeConnection(this);
        this.stack.sendTcp(this, TCP_FLAG.FIN | TCP_FLAG.ACK, new Uint8Array(0));
        this.onClose?.(this);
      }
    }
  }
  /** @internal */ localSeqForSend(): number { return this.seq; }
  /** @internal */ ackForSend(): number { return this.ack; }
  /** @internal */ advanceSeq(n: number): void { this.seq = (this.seq + n) >>> 0; }
}

export class MiniStack {
  readonly ipString: string;
  readonly macString: string;
  readonly ipBytes: Uint8Array;
  readonly macBytes: Uint8Array;
  wire: Wire | null = null;
  private arpTable = new Map<string, Uint8Array>();
  private udpHandlers = new Map<number, UdpHandler>();
  private tcpListeners = new Map<number, TcpConnectionHandler>();
  private connections = new Map<string, TcpConnection>();
  private pendingAccepts = new Map<string, TcpConnectionHandler>();
  /** Hook: raw IPv4 packet tap (used by tests/sniffers). */
  onIpv4: ((src: string, protocol: number, payload: Uint8Array) => void) | null = null;

  constructor(opts: { ip: string; mac: string }) {
    this.ipString = opts.ip;
    this.macString = opts.mac;
    this.ipBytes = ipBytes(opts.ip);
    this.macBytes = macBytes(opts.mac);
  }

  attachTo(wire: Wire): this { this.wire = wire; wire.attach(this); return this; }

  // ---------- send paths ----------
  private sendEthernet(dstMac: Uint8Array, ethertype: number, payload: Uint8Array): void {
    if (!this.wire) throw new Error('stack not attached to a wire');
    this.wire.send(this, buildEthernet(dstMac, this.macBytes, ethertype, payload));
  }

  private resolveMac(ip: Uint8Array): Uint8Array {
    const key = ipToString(ip);
    const cached = this.arpTable.get(key);
    if (cached) return cached;
    // Synchronous ARP request/response on the shared wire.
    this.sendEthernet(BROADCAST_MAC, ETHERTYPE.ARP, buildArp({
      oper: 1, sha: this.macBytes, spa: this.ipBytes,
      tha: new Uint8Array(6), tpa: ip,
    }));
    return this.arpTable.get(key) ?? BROADCAST_MAC;
  }

  sendIpv4(dstIp: Uint8Array, protocol: number, payload: Uint8Array): void {
    const id = (Math.random() * 0xffff) >>> 0;
    const packet = buildIpv4({ src: this.ipBytes, dst: dstIp, protocol, ttl: 64, id, payload });
    this.sendEthernet(this.resolveMac(dstIp), ETHERTYPE.IPv4, packet);
  }

  ping(dstIp: string, id = 1, seq = 1): boolean {
    this.sendIcmpEcho(ipBytes(dstIp), id, seq);
    return true;
  }

  sendIcmpEcho(dstIp: Uint8Array, id: number, seq: number): void {
    this.sendIpv4(dstIp, IPPROTO.ICMP, buildIcmp({ type: 8, code: 0, id, seq, payload: new Uint8Array(32).fill(0x61) }));
  }

  sendUdp(dstIp: string, dstPort: number, payload: Uint8Array, srcPort = 0): number {
    const port = srcPort || allocEphemeral();
    const udp = buildUdp({ srcPort: port, dstPort, payload }, this.ipBytes, ipBytes(dstIp));
    this.sendIpv4(ipBytes(dstIp), IPPROTO.UDP, udp);
    return port;
  }

  udpListen(port: number, handler: UdpHandler): void { this.udpHandlers.set(port, handler); }

  tcpListen(port: number, onConnection: TcpConnectionHandler): void { this.tcpListeners.set(port, onConnection); }

  tcpConnect(dstIp: string, dstPort: number): TcpConnection {
    const localPort = allocEphemeral();
    const conn = new TcpConnection(this, localPort, dstIp, dstPort);
    this.connections.set(conn.key(), conn);
    conn.connect();
    return conn;
  }

  /** @internal */ sendTcp(conn: TcpConnection, flags: number, payload: Uint8Array): void {
    const segLen = payload.length + ((flags & TCP_FLAG.SYN) ? 1 : 0) + ((flags & TCP_FLAG.FIN) ? 1 : 0);
    const seg = buildTcp({
      srcPort: conn.localPort,
      dstPort: conn.remotePort,
      seq: conn.localSeqForSend(),
      ack: conn.ackForSend(),
      flags,
      window: 65535,
      payload,
    }, this.ipBytes, ipBytes(conn.remoteIp));
    conn.advanceSeq(segLen);
    this.sendIpv4(ipBytes(conn.remoteIp), IPPROTO.TCP, seg);
  }

  /** @internal */ removeConnection(conn: TcpConnection): void {
    this.connections.delete(conn.key());
  }


  // ---------- receive path ----------
  receive(frame: Uint8Array): void {
    const eth = parseEthernet(frame);
    if (!eth) return;
    if (eth.ethertype === ETHERTYPE.ARP) return this.handleArp(eth.payload, eth.src);
    if (eth.ethertype !== ETHERTYPE.IPv4) return;
    const ip = parseIpv4(eth.payload);
    if (!ip) return;
    const isUs = macEq(ip.dst, this.ipBytes) || ipToString(ip.dst) === '255.255.255.255' || macEq(eth.dst, this.macBytes);
    if (!isUs) return;
    // learn sender
    this.arpTable.set(ipToString(ip.src), eth.src);
    this.onIpv4?.(ipToString(ip.src), ip.protocol, ip.payload);
    switch (ip.protocol) {
      case IPPROTO.ICMP: return this.handleIcmp(ip, eth.src);
      case IPPROTO.UDP: return this.handleUdp(ip);
      case IPPROTO.TCP: return this.handleTcp(ip, eth.src);
      default: return;
    }
  }

  private handleArp(payload: Uint8Array, ethSrc: Uint8Array): void {
    const arp = parseArp(payload);
    if (!arp) return;
    this.arpTable.set(ipToString(arp.spa), arp.sha);
    if (arp.oper === 1 && macEq(arp.tpa, this.ipBytes)) {
      // reply unicast
      this.sendEthernet(arp.sha, ETHERTYPE.ARP, buildArp({
        oper: 2, sha: this.macBytes, spa: this.ipBytes, tha: arp.sha, tpa: arp.spa,
      }));
    }
  }

  private handleIcmp(ip: { src: Uint8Array; payload: Uint8Array }, _ethSrc: Uint8Array): void {
    const icmp = parseIcmp(ip.payload);
    if (!icmp) return;
    if (icmp.type === 8) { // echo request
      this.sendIpv4(ip.src, IPPROTO.ICMP, buildIcmp({ type: 0, code: 0, id: icmp.id, seq: icmp.seq, payload: icmp.payload }));
    }
  }

  private handleUdp(ip: { src: Uint8Array; payload: Uint8Array }): void {
    const udp = parseUdp(ip.payload);
    if (!udp) return;
    const handler = this.udpHandlers.get(udp.dstPort);
    handler?.(udp.payload, ipToString(ip.src), udp.srcPort);
  }

  private handleTcp(ip: { src: Uint8Array; dst: Uint8Array; payload: Uint8Array }, ethSrc: Uint8Array): void {
    void ethSrc;
    const seg = parseTcp(ip.payload, ip.src, ip.dst);
    if (!seg) return;
    const srcIp = ipToString(ip.src);
    // existing connection?
    const fwd = `${this.ipString}:${seg.dstPort}->${srcIp}:${seg.srcPort}`;
    let conn = this.connections.get(fwd);
    if (!conn) {
      // new inbound SYN?
      if ((seg.flags & TCP_FLAG.SYN) && !(seg.flags & TCP_FLAG.ACK)) {
        const listener = this.tcpListeners.get(seg.dstPort);
        if (!listener) return; // no listener: silently drop (would be RST in practice)
        conn = new TcpConnection(this, seg.dstPort, srcIp, seg.srcPort);
        this.connections.set(conn.key(), conn);
        this.pendingAccepts.set(conn.key(), listener);
        conn.initPassive(seg.seq);
      }
      return;
    }
    conn.handleSegment(seg.flags, seg.seq, seg.ack, seg.payload);
    if (conn.state === 'established') {
      const pending = this.pendingAccepts.get(fwd);
      if (pending) {
        this.pendingAccepts.delete(fwd);
        pending(conn);
      }
    }
  }
}
