# ADR-0008: Networking — user-space TCP/IP over a relay

- **Status:** Proposed (Phase 0) — Spike E confirms the transport choice
- **Related:** ADR-0005, ADR-0010, ADR-0013

## Context

`apt install`, `git clone`, `curl`, `ssh`, and containers all need real
networking from inside the guest. The browser gives no raw sockets to ordinary
pages: what exists is `fetch` (HTTP/HTTPS only, CORS-constrained), WebSocket
(TCP-framed but must terminate at a server we control), WebRTC data channels
(UDP-like, peer-to-peer, NAT-dependent), and Direct Sockets (real TCP/UDP, but
only in an **Isolated Web App** build, which is Chromium-only and requires a
signed, installed app).

Meanwhile the guest kernel expects a NIC. Presenting a real device model would
be both slow and pointless — ROADMAP §1 says paravirtual over emulated.

## Decision

- **`virtio-net` backed by a user-space TCP/IP stack compiled to Wasm**, running
  in a dedicated net worker. NAT, DHCP (served locally to the guest), DNS.
  The guest sees an ordinary Ethernet interface; the stack is ours, not the
  kernel's.
- **Egress through `wnx-relay`** — WebSocket by default, WebRTC data channel
  where it helps — self-hostable, with a hosted default so it works out of the
  box.
- **The relay is untrusted by design** (§10): tunnels are end-to-end encrypted,
  no plaintext credentials traverse it, and a hostile relay can cause an outage
  but not an interception.
- **DNS over HTTPS**, IPv6 supported end-to-end where the relay can carry it.
- **`apt` works over a CORS-friendly mirror or through the relay**, with a
  **shared package cache in OPFS** reused across instances — the same
  content-addressed chunk store ADR-0005 uses for the base image, so a second
  instance installs `build-essential` from local bytes.
- **Raw sockets (ICMP, UDP, `listen()`) exist only in the Isolated Web App
  build**, via Direct Sockets. Everywhere else they fail cleanly with a
  diagnosable error rather than silently misbehaving — `wnx doctor` reports
  which tier the current context is in.
- **Inbound**: guest ports exposed to other tabs/devices via relay/WebRTC
  (`wnx forward 8080`).
- **`virtio-vsock`** for host↔guest channels (agent control, bridges) so that
  `wnxd` traffic never competes with guest networking.

**Rejected: fetch-only HTTP proxy.** No raw sockets, no inbound, no
`ssh`/`git+ssh`, no listening services — it cannot satisfy Phase 4's exit
criteria. It remains the _implementation_ of HTTP egress inside the stack, not
the architecture.

**Rejected: relying on Direct Sockets as the primary path.** It is the best
transport where available, but it requires an installed, signed IWA on
Chromium; Tier-2/3 browsers (§11) would have no networking at all.

**Rejected: emulating a real NIC (e1000/rtl8139).** Slower, more code, and it
buys nothing: the guest cannot tell the difference except in throughput.

## Consequences

**Positive**

- One code path serves every browser tier; only the raw-socket tier is
  conditional, and that condition is detectable at runtime.
- A user-space stack in Wasm can use SIMD and threads for checksums and copies,
  and its performance is ours to tune rather than a kernel's.
- Self-hostable relay means the project does not become dependent on operating
  infrastructure it does not control.
- The shared package cache makes `apt` on a second instance nearly free.

**Negative / risks**

- **We own a TCP/IP stack**: congestion control, retransmission, window scaling,
  TLS termination choices, IPv6, and every edge case a Debian package can
  produce. That is a large, permanent surface. (Using an existing stack compiled
  to Wasm is strongly preferred to writing one — Spike E should evaluate
  candidates before this ADR is accepted.)
- **Latency and throughput are bounded by the relay hop.** `apt` of a large
  package through WebSocket → relay → internet will not match a native
  connection, and the KPI table has no network row yet — it needs one.
- **A hosted default relay is an operating cost and a trust question**, even
  end-to-end encrypted: it sees metadata. Documented, and the self-host path must
  be a single command.
- **NAT in the stack** means the guest's view of its own address is a lie;
  software that inspects its external IP (some license servers, some CLIs) will
  see the relay's. Needs to be documented.
- **WebRTC needs signalling**, which the relay provides, which reintroduces the
  relay as a rendezvous point for peers.

## What Spike E must produce

- Measured throughput and RTT for WebSocket vs WebRTC vs Direct Sockets (IWA),
  from the same host to the same endpoint.
- A shortlist of existing user-space TCP/IP stacks that compile to Wasm, with
  licence (ADR-0011) and API fit.
- `apt update && apt install build-essential git openssh-client` timed end to
  end, with and without a warm package cache.
