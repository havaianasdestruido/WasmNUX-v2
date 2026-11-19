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

| Metric | Value |
|---|---|
| UDP serialize+parse | 1.27M ops/s |
| IPv4 checksum | 11.4M ops/s |
| ICMP echo round trip (simulated wire) | ~69k/s |
| wnx-relay localhost WebSocket round trip | ~12.9k msgs/s |

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
