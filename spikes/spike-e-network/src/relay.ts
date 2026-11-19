/**
 * wnx-relay (prototype): pairs a guest-side connection and a client-side
 * connection by session key and forwards opaque bytes both ways. Framing is
 * WebSocket binary messages. A per-session shared token guards joins.
 *
 * This validates the relay architecture (session pairing, auth handshake,
 * byte forwarding). Production concerns (TLS termination strategy, rate
 * limits, DoH, ACLs, metrics) are Phase 4.
 *
 * Protocol (first message, JSON text):
 *   {"t":"join","session":"<key>","role":"guest"|"client","token":"<shared>"}
 * Server replies {"t":"ok"} or {"t":"error","reason":...}.
 * Binary frames after join are forwarded to the peer verbatim.
 */
import { WebSocketServer, WebSocket } from 'ws';
import type { AddressInfo } from 'node:net';
import { createHash, timingSafeEqual } from 'node:crypto';

export interface RelayOptions {
  /** Pre-shared token required to join a session. */
  token?: string | undefined;
  /** Maximum buffered bytes per connection before the peer is killed. */
  maxBufferedBytes?: number;
}

interface Session {
  guest?: WebSocket;
  client?: WebSocket;
}

function tokenOk(provided: string | undefined, expected: string | undefined): boolean {
  if (!expected) return true;
  if (!provided) return false;
  const a = createHash('sha256').update(provided).digest();
  const b = createHash('sha256').update(expected).digest();
  return timingSafeEqual(a, b);
}

export class RelayServer {
  private wss: WebSocketServer | null = null;
  private readonly sessions = new Map<string, Session>();
  private readonly opts: RelayOptions;

  constructor(opts: RelayOptions = {}) {
    this.opts = opts;
  }

  /** Start on the given port (0 = ephemeral). Resolves with the bound port. */
  start(port: number): Promise<number> {
    return new Promise((resolve, reject) => {
      this.wss = new WebSocketServer({ port }, () => {
        const addr = this.wss!.address() as AddressInfo;
        resolve(addr.port);
      });
      this.wss.on('error', reject);
      this.wss.on('connection', ws => this.handleConnection(ws));
    });
  }

  stop(): Promise<void> {
    return new Promise(resolve => {
      if (!this.wss) return resolve();
      for (const session of this.sessions.values()) {
        session.guest?.terminate();
        session.client?.terminate();
      }
      this.sessions.clear();
      this.wss.close(() => resolve());
    });
  }

  private handleConnection(ws: WebSocket): void {
    let joined: { session: string; role: 'guest' | 'client' } | null = null;
    let peer: WebSocket | null = null;

    ws.on('message', (data: Buffer, isBinary: boolean) => {
      if (!joined) {
        if (isBinary) return this.reject(ws, 'first message must be a JSON join frame');
        let msg: { t?: string; session?: string; role?: string; token?: string };
        try { msg = JSON.parse(data.toString('utf8')); } catch { return this.reject(ws, 'bad JSON'); }
        if (msg.t !== 'join' || !msg.session || (msg.role !== 'guest' && msg.role !== 'client')) {
          return this.reject(ws, 'expected {t:"join",session,role:"guest"|"client",token}');
        }
        if (!tokenOk(msg.token, this.opts.token)) return this.reject(ws, 'bad token');
        const key = msg.session.slice(0, 128);
        const session = this.sessions.get(key) ?? {};
        if (session[msg.role]) return this.reject(ws, `session already has a ${msg.role}`);
        session[msg.role] = ws;
        this.sessions.set(key, session);
        joined = { session: key, role: msg.role };
        ws.send(JSON.stringify({ t: 'ok', paired: !!(session.guest && session.client) }));
        peer = msg.role === 'guest' ? session.client ?? null : session.guest ?? null;
        // Notify the first-joined side if the second just arrived.
        if (peer && (ws as WebSocket).readyState === WebSocket.OPEN) {
          peer.send(JSON.stringify({ t: 'peer-joined' }));
        }
        return;
      }
      // Forwarding phase: resolve the peer lazily (it may have joined after us).
      const session = this.sessions.get(joined.session);
      peer = joined.role === 'guest' ? session?.client ?? null : session?.guest ?? null;
      if (peer && peer.readyState === WebSocket.OPEN) {
        peer.send(data, { binary: true });
      }
    });

    ws.on('close', () => {
      if (!joined) return;
      const session = this.sessions.get(joined.session);
      if (session) {
        const other = joined.role === 'guest' ? session.client : session.guest;
        other?.send(JSON.stringify({ t: 'peer-left' }));
        delete session[joined.role];
        if (!session.guest && !session.client) this.sessions.delete(joined.session);
      }
    });
  }

  private reject(ws: WebSocket, reason: string): void {
    ws.send(JSON.stringify({ t: 'error', reason }));
    ws.close(4001, reason);
  }
}

export interface RelayConnection {
  send(data: Uint8Array): void;
  onData: ((data: Uint8Array) => void) | null;
  onClose: (() => void) | null;
  close(): void;
}

/** Client-side helper mirroring the server protocol. */
export function connectRelay(url: string, session: string, role: 'guest' | 'client', token?: string): Promise<RelayConnection> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const conn: RelayConnection = {
      send: (data) => ws.send(data, { binary: true }),
      onData: null,
      onClose: null,
      close: () => ws.close(),
    };
    let settled = false;
    ws.on('open', () => {
      ws.send(JSON.stringify({ t: 'join', session, role, token }));
    });
    ws.on('message', (data: Buffer, isBinary: boolean) => {
      if (!isBinary) {
        let msg: { t?: string } = {};
        try { msg = JSON.parse(data.toString('utf8')); } catch { return; }
        if (msg.t === 'ok' && !settled) { settled = true; resolve(conn); return; }
        if (msg.t === 'error' && !settled) { settled = true; reject(new Error('relay join refused')); return; }
        return; // peer-joined etc. — informational for now
      }
      conn.onData?.(new Uint8Array(data));
    });
    ws.on('error', err => { if (!settled) { settled = true; reject(err); } });
    ws.on('close', () => conn.onClose?.());
  });
}
