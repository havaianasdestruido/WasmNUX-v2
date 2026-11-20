/**
 * `@wasmnux/host` — the browser-side runtime around `@wasmnux/core`.
 *
 * Empty on purpose in Phase 0. This is where the pieces ROADMAP §2 assigns to the
 * host will live, and each one is blocked on a spike rather than on typing:
 *
 * - `workers/vcpu.ts` — N vCPU workers over one shared `WebAssembly.Memory`
 *   (Spike B). The memory model that makes this possible is already measured:
 *   ADR-0004, `core/src/machine/memory.ts`.
 * - `workers/storage.ts` — the OPFS COW block device (Spike C, ADR-0005).
 * - `workers/display.ts` — scanout and the terminal renderer (Spikes D/F,
 *   ADR-0007, ADR-0009).
 * - `workers/net.ts` — virtio-net to the user-space stack (Spike E, ADR-0008).
 * - `bridges/` — capability-gated WebUSB/HID/Serial/Bluetooth/FSA (Phase 7).
 *
 * Two rules apply to everything written here, both from Phase 0 findings:
 * nothing on a hot path may `postMessage` (SAB rings only, ROADMAP §1), and the
 * main thread does input and permissions and nothing else.
 *
 * Until then, the only host-side code that exists is the dev server and demo page
 * under `web/`, which drive `@wasmnux/core` directly.
 */

export const HOST_PLACEHOLDER = true;
