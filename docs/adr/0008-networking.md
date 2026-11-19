# ADR-0008: Networking — user-space TCP/IP in Wasm + relay; Direct Sockets in an IWA build

## Status

accepted

## Date

2026-11-19

## Context

A browser tab cannot open raw TCP/UDP. WasmNUX networking therefore has tiers:

1. **User-space TCP/IP stack inside the guest (Wasm), egress via relay** —
   the guest runs a from-scratch minimal stack (spike E): ARP, IPv4, ICMP
   echo, UDP demux, TCP active/passive open (3-way handshake, FIN close).
   The relay (`wnx-relay`) pairs guest and client connections by session key
   over WebSocket (this spike) / WebTransport / WebRTC (Phase 4), forwarding
   opaque bytes. Self-hostable, untrusted-by-design (E2E encryption is Phase 4).
2. **Direct Sockets (Isolated Web App only)** — the only web-platform raw
   sockets API: IWA-signed app can `directTCPSocket`/`directUDPSocket`,
   including listen sockets. NOT available in regular tabs, PWAs, Firefox, or
   Safari; cannot be tested in CI/headless regular Chromium; detection shim
   ships in `spikes/spike-e-network/src/direct-sockets.ts` and `wnx doctor`
   reports it.
3. **Fetch/HTTP proxy** — rejected as too limited (no UDP, no arbitrary ports,
   HTTP semantics leak into the guest).

Spike E measured (`benchmarks/results/spike-e-network-draft.json`, 2× Xeon
2.6 GHz, Node 22):

- UDP serialize+parse: **1.27M ops/s**
- IPv4 header checksum: **11.4M ops/s**
- Simulated-wire ICMP echo round trip: **~69k/s**
- wnx-relay localhost WebSocket round trip: **~12.9k msgs/s** (0.077 µs-ish
  per hop amortized; dominated by ws framing — good enough for a relay tier)
- 11/11 unit tests: ARP tables, ICMP echo, UDP delivery, TCP handshake/data/
  FIN, DNS wire codec, relay pairing/auth, Direct Sockets detection

## Decision

- Ship a **user-space TCP/IP stack in Wasm** (not an lwIP port initially —
  the spike proves the shape; lwIP under the same interface is the fallback if
  TCP congestion control/timers grow teeth in Phase 4).
- **wnx-relay is the default egress path** (WebSocket now, WebTransport/WebRTC
  later), self-hostable, untrusted relay (E2E crypto in Phase 4).
- **Direct Sockets is an optional IWA-only tier**: built as a separate IWA
  artifact; feature-detected; never required for any core feature.
- DNS: DoH/DoT from the guest (the spike includes a wire-format DNS codec;
  the DoH client itself lands in Phase 4).
- No ICMP raw from browsers: ping works inside the simulated wire only.

## Consequences

- Relay latency (~ms to relay, vs µs direct) is the cost of tab-based egress;
  interactive use (apt, ssh) is unaffected, but high-rate UDP (QUIC, games)
  will feel it — documented as an expected gap vs native.
- wnx-relay is deployable infra we must operate or users self-host; keep it
  boring (one binary, env config) — it starts here as ~200 lines of Node/ws
  and may be reimplemented in Rust per the architecture table (Phase 4).
- Relay token pairing in this spike is a shared-token prototype; Phase 4 must
  add per-session keys, ACLs, rate limits, and DoH pinning before exposure to
  the public internet.
- IWA tier unlocks raw listen sockets (inbound connections) — future
  "host a server from the tab" feature; do not promise it before Direct
  Sockets ships broadly.
