/**
 * `@wasmnux/relay` — `wnx-relay`: network egress, framing and signalling.
 *
 * Empty on purpose in Phase 0; Spike E and ADR-0008 decide what it is. The
 * decisions that are already fixed and constrain any implementation here:
 *
 * - **The relay is untrusted** (ROADMAP §10, ADR-0008). Tunnels are
 *   end-to-end encrypted, no plaintext credential may traverse it, and a hostile
 *   relay must be able to cause an outage but not an interception.
 * - **It is self-hostable**, with a hosted default so the product works out of
 *   the box.
 * - **Transport is WebSocket by default, WebRTC data channel where it helps,
 *   Direct Sockets only in the Isolated Web App build** — Spike E measures the
 *   three before this becomes code.
 * - It carries more than egress: inbound port forwarding (`wnx forward 8080`),
 *   WebRTC signalling, and VNC export (Phase 5).
 *
 * ROADMAP §2 lists the relay as Rust. Nothing in Phase 0 measured that choice,
 * and a TypeScript relay would share framing code with `host/`; the decision is
 * deliberately left open until Spike E exists.
 */

export const RELAY_PLACEHOLDER = true;
