# ADR-0008: Networking

- **Status:** Accepted
- **Date:** 2026-11-19

## Decision
Use a **user-space TCP/IP stack in Wasm + WebSocket/WebRTC relay (`wnx-relay`)** as the default, with **Direct Sockets** in an Isolated Web App (IWA) build as the raw-socket tier.

## Rationale
Spike E validated an SPSC `SharedArrayBuffer` packet ring at **887 MB/s** and automatic tier detection (`direct-sockets-iwa` vs `userspace-tcpip-relay`).
