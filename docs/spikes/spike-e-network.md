# Spike E — Network: user-space TCP/IP + relay; Direct Sockets (IWA)

**Deliverable:** `spikes/spike-e-network/` · **Results:** `benchmarks/results/spike-e-network-draft.json`

## What was built

- `src/packets.ts` — Ethernet/ARP/IPv4/ICMP/UDP/minimal TCP (checksums, ser/de)
- `src/stack.ts` — `MiniStack`: synchronous ARP, ICMP echo server, UDP demux,
  TCP active/passive open (SYN/SYN-ACK/ACK, data, FIN close)
- `src/relay.ts` — `wnx-relay` prototype: WebSocket session pairing by key,
  shared-token join auth (timing-safe compare), bidirectional byte forwarding
  (`guest`/`client` roles), `connectRelay()` client helper
- `src/dns.ts` — DNS wire-format codec (A/AAAA/CNAME, compression pointers)
- `src/direct-sockets.ts` — Direct Sockets (IWA) detection + capability matrix
- 11/11 tests (protocol, stack behavior, relay pairing/auth refusal)

## Measured (2× Xeon @ 2.60 GHz, Node 22)

Post-review hardening: DNS names reject cyclic/out-of-range compression
pointers (jump cap + per-pointer visited set + 255-byte expansion bound — the
previous decoder could loop forever on a malformed response); IPv4 packets
larger than 65,535 bytes are rejected at encode time instead of wrapping the
length field; `wnx-relay` enforces `maxBufferedBytes` (a non-draining peer is
disconnected instead of buffering unboundedly) and `stop()` terminates every
accepted socket, including ones that never joined a session.

| Metric | 2026-11-19 run 1 | 2026-11-19 run 2 (committed JSON) |
|---|---|---|
| UDP serialize+parse | 1.27M ops/s | 660k ops/s |
| IPv4 checksum | 11.4M ops/s | 7.3M ops/s |
| ICMP echo round trip (simulated wire) | ~69k/s | ~40k/s |
| wnx-relay localhost WebSocket round trip | ~12.9k msgs/s | ~4.5k msgs/s |

Run-to-run variance is large on the shared host; both runs confirm the same
order of magnitude and the architecture's viability. 16/16 tests.

## Notable bugs caught by tests

- TCP FIN re-entrancy (synchronous wire): a peer answering FIN mid-send
  re-entered the FIN branch → infinite recursion. Fixed by quiescing the
  connection (remove from table) **before** transmitting.
- RFC 1071 worked-example checksum assertion corrected (0x220d).
- Slave-side accept flow: replaced listener-in-SYN-RCVD hack with
  `initPassive` + `pendingAccepts` map fired on reaching `established`.

## Not measured (and why)

**Direct Sockets** (raw TCP/UDP incl. listen): Isolated Web App only; not
present in regular tabs/PWAs/Firefox/Safari; untestable in Node CI. Shipped as
feature detection + docs; real measurement happens in Phase 4 in an IWA build.
