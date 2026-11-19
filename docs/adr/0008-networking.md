# ADR-0008: Networking — user-space TCP/IP stack + relay; Direct Sockets in the IWA build

- **Status:** Accepted (Phase 0 codecs/relay model; throughput KPIs Phase 1)
- **Date:** 2026-11

## Context

Browsers offer no raw sockets and no NAT. The guest expects a Linux TCP/IP
worldview; inbound port forwards (`wnx forward 8080`) and outbound
connections must both work, with an offline story and explicit consent.

## Decision

1. **User-space TCP/IP stack in Wasm** (spike E → `host/net/`): IPv4/UDP/
   ICMP implemented and tested now; TCP connection tracking next. The guest
   taps it like a virtio-net backend; the host does not interpret payloads
   beyond framing.
2. **Relay tier:** outbound flows map to WebSocket (Phase 1) then WebRTC
   (Phase 4) sessions through `wnx-relay`; inbound forwards use the relay's
   explicit port-binding table. NAT-like mapping is explicit and auditable.
3. **Direct Sockets tier (IWA only):** `tcpServer`/`udpSocket`/`tcpClient`
   feature-detected; available only in the Isolated Web App build. Non-IWA
   builds degrade to the relay with a `wnx doctor` explanation
   (`DirectSocketPolicy` in spike E).
4. Fetch-only HTTP proxy rejected as too limited (alternatives row).

## Evidence (Phase 0)

- `network.test.ts` — 11 tests: RFC-1071 checksum vectors, IPv4 header
  validation, UDP pseudo-header checksum, ICMP echo round-trip, echo server,
  relay routing/stream reassembly/port allocation, IWA policy.
- Throughput rows `e1`/`e2` reserved (need guest image + browser).

## Consequences

- TLS: guest-side via its own certs (Phase 2); the relay sees ciphertext only
  when the guest tunnels TLS end-to-end (default for raw TCP forwards).
- Offline = local relay loopback + cached base image (KPI row in Phase 1).
