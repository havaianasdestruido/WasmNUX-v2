# ADR-0008: User-space networking and optional IWA Direct Sockets

**Status:** Accepted direction; IWA execution unverified.

**Decision.** Use virtio-net and a user-space Wasm stack with a packet/stream boundary to an optional WebSocket or WebRTC relay. Design the production relay as untrusted: encrypt end-to-end, scope capabilities, bound queues and make egress opt-in. Keep Direct Sockets as an explicit installed-IWA capability, not an assumed browser API or the only networking path.

**Alternatives.** A fetch proxy cannot implement general TCP/UDP semantics. Ordinary browser origins cannot open native TCP/UDP sockets. Native relay service use increases operational and privacy costs.

**Evidence and revisit.** The browser probe sends TCP traffic between two lwIP Wasm stacks over TUN and a loopback-only relay with no internet access or credentials. The IWA proxy/manifest and local echo fixtures are implemented and tested independently; a desktop IWA run remains required. Test real virtio integration, DNS, apt/TLS, retransmission, controlled egress and opt-in permissions before release. Do not deploy the fixture as a production relay.
