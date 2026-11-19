/**
 * Direct Sockets (Isolated Web Apps) — feature detection only.
 *
 * Direct Sockets let an Isolated Web App open raw TCP/UDP sockets, the only
 * web platform path to unmediated network egress. It is NOT available in
 * regular tabs, and cannot be tested in Node CI. See docs/spikes/spike-e-network.md.
 *
 * Spec: https://github.com/WICG/direct-sockets
 */
export interface DirectSocketsSupport {
  supported: boolean;
  reason: string;
  requiredContext: string;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type G = any;

export function directSocketsSupport(): DirectSocketsSupport {
  const g: G = globalThis as G;
  const requiredContext = 'Isolated Web App (IWA) context, Chrome/Edge with direct sockets enabled';
  if (typeof g.directTCPSocket === 'function' || typeof g.directTCPSocket === 'object') {
    return { supported: true, reason: 'directTCPSocket present', requiredContext };
  }
  if (typeof g.DirectTCPSocket === 'function') { // legacy naming seen in early builds
    return { supported: true, reason: 'DirectTCPSocket present', requiredContext };
  }
  const isNode = !!g.process?.versions?.node;
  return {
    supported: false,
    reason: isNode ? 'Node.js: Direct Sockets are a browser IWA API' : 'directTCPSocket missing: not an IWA context or API disabled',
    requiredContext,
  };
}

/** Capability matrix documentation for `wnx doctor`. */
export const DIRECT_SOCKETS_MATRIX = [
  { context: 'Regular browser tab/window', tcp: false, udp: false, note: 'Use wnx-relay (WebSocket/WebRTC) instead' },
  { context: 'PWA (installed)', tcp: false, udp: false, note: 'Same restrictions as tabs' },
  { context: 'Isolated Web App', tcp: true, udp: true, note: 'Needs IWA signing/permissions; raw egress incl. listen sockets' },
  { context: 'Node.js (wnx-relay host)', tcp: true, udp: true, note: 'Relay runs on Node with unrestricted sockets' },
] as const;
