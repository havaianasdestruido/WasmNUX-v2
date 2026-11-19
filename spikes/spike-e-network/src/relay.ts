/**
 * Spike E — relay core (ADR-0008: "user-space TCP/IP stack in Wasm + relay").
 *
 * The real `wnx-relay` (Phase 4) speaks WebSocket/WebRTC to the tab; here we
 * model the pieces whose design Phase 0 must validate:
 *  - datagram routing between named peers (UDP/NAT behaviour),
 *  - stream framing: large payloads split into frames, reassembled in order,
 *  - port allocation for inbound forwards (`wnx forward 8080`).
 *
 * Transport-outrageously small on purpose: no sockets in Phase 0 CI; the
 * browser harness swaps in real WebSockets behind `RelayTransport`.
 */

export interface RelayFrame {
  kind: "datagram" | "stream";
  streamId?: number;
  seq?: number;
  fin?: boolean;
  payload: Uint8Array;
}

export type RelayHandler = (from: string, frame: RelayFrame) => void;

export class RelayServer {
  private handlers = new Map<string, RelayHandler>();
  private portBindings = new Map<number, string>(); // host port → peer id
  private nextPort = 49152;
  routed = 0;
  dropped = 0;

  register(peerId: string, handler: RelayHandler): void {
    this.handlers.set(peerId, handler);
  }

  unregister(peerId: string): void {
    this.handlers.delete(peerId);
    for (const [port, owner] of this.portBindings) {
      if (owner === peerId) this.portBindings.delete(port);
    }
  }

  send(from: string, to: string, frame: RelayFrame): boolean {
    const h = this.handlers.get(to);
    if (!h) { this.dropped++; return false; }
    this.routed++;
    h(from, frame);
    return true;
  }

  /** Bind an inbound-forward port for a peer (wnx forward). */
  bindPort(peerId: string, preferred?: number): number {
    if (preferred !== undefined) {
      const owner = this.portBindings.get(preferred);
      if (owner && owner !== peerId) throw new Error(`port ${preferred} already bound by ${owner}`);
      this.portBindings.set(preferred, peerId);
      return preferred;
    }
    while (this.portBindings.has(this.nextPort)) this.nextPort++;
    const port = this.nextPort++;
    this.portBindings.set(port, peerId);
    return port;
  }

  resolvePort(port: number): string | null {
    return this.portBindings.get(port) ?? null;
  }

  stats() {
    return { routed: this.routed, dropped: this.dropped, peers: this.handlers.size };
  }
}

/** Reassemble a `stream` frame sequence; out-of-order → error (TCP-lite). */
export class StreamReassembler {
  private parts: Uint8Array[] = [];
  private expected = 0;
  completed: Uint8Array | null = null;

  push(frame: RelayFrame): Uint8Array | null {
    if ((frame.seq ?? 0) !== this.expected) {
      throw new Error(`out-of-order frame: got ${frame.seq}, want ${this.expected}`);
    }
    this.parts.push(frame.payload);
    this.expected++;
    if (frame.fin) {
      const total = this.parts.reduce((n, p) => n + p.length, 0);
      const out = new Uint8Array(total);
      let off = 0;
      for (const p of this.parts) { out.set(p, off); off += p.length; }
      this.completed = out;
      return out;
    }
    return null;
  }
}

/** Split a payload into `mtu`-sized frames (ordered, fin on last). */
export function splitStream(payload: Uint8Array, mtu: number): RelayFrame[] {
  if (mtu < 1) throw new Error("mtu must be ≥ 1");
  const frames: RelayFrame[] = [];
  for (let off = 0, seq = 0; off < payload.length; off += mtu, seq++) {
    const end = Math.min(off + mtu, payload.length);
    frames.push({
      kind: "stream",
      seq,
      fin: end === payload.length,
      payload: payload.subarray(off, end),
    });
  }
  if (frames.length === 0) {
    frames.push({ kind: "stream", seq: 0, fin: true, payload: new Uint8Array(0) });
  }
  return frames;
}

/** Allocation policy for Direct Sockets (IWA) port mappings (spike notes). */
export class DirectSocketPolicy {
  /**
   * Direct Sockets are Isolated-Web-App-only (ROADMAP §6). The IWA build
   * opts into `tcpServer`/`udpSocket`/`tcpClient`; non-IWA builds feature-detect
   * and report via `wnx doctor`. This policy object exists so the net worker
   * can be unit-tested without the browser: it only ever opens what the
   * build declares it may open.
   */
  constructor(readonly isIsolatedWebApp: boolean) {}

  canListenTcp(): boolean { return this.isIsolatedWebApp; }
  canUdp(): boolean { return this.isIsolatedWebApp; }
  canOutboundTcp(): boolean { return this.isIsolatedWebApp; }
  degradeReason(): string | null {
    return this.isIsolatedWebApp
      ? null
      : "Direct Sockets require an Isolated Web App build — using wnx-relay (WebSocket) instead";
  }
}
