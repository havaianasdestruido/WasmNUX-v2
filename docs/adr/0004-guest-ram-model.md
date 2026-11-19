# ADR-0004: Guest RAM model — one shared, lazily reserved `WebAssembly.Memory`

- **Status:** Accepted (Phase 0), on measured evidence
- **Related:** ADR-0001, ADR-0002, ADR-0003
- **Evidence:** [`docs/spikes/spike-a-jit.md`](../spikes/spike-a-jit.md) §3.3, §4.2, §4.3

## Context

Guest RAM has to be simultaneously:

- addressable from generated Wasm at full speed (the translator's load/store
  path is the hottest code in the system);
- shareable across vCPU workers (Spike B) with real atomic RMW, because guest
  atomics and LR/SC must map onto something with hardware semantics;
- able to hold a Linux kernel plus a Debian userland, i.e. hundreds of MiB to
  GiB;
- cheap to create, because a cold start budget of <2 s to first prompt includes
  it.

Wasm offers `Memory32` (max 4 GiB, lazily reserved in V8), `Memory64` (64-bit
indexing), `shared: true` (backed by a `SharedArrayBuffer`, required for
atomics), and no guard pages or `mprotect` — so out-of-range guest accesses must
be handled either by an explicit bounds check in generated code or by letting
the access trap.

## Decision

**One `WebAssembly.Memory` per guest, `shared: true`, `initial: 1`,
`maximum: 65536` (4 GiB), laid out as a fixed map with guest RAM at `ramBase`
and an optional control page immediately after it. Guest addresses are
translated to memory offsets by subtracting `ramBase`, so both RV32 and RV64 fit
a 32-bit memory.**

Three sub-decisions, each measured:

1. **Memory64 is not used.** It _validates_ in Node 22 but does not run, even
   with `--experimental-wasm-memory64`; browser support is also narrower than
   memory32. Since guest RAM is below 4 GiB and `ramBase` subtraction makes the
   offset 32-bit, Memory64 buys nothing here. ROADMAP §3 listed it as
   "Memory64 where available" — this ADR removes it from the design.
2. **Reservation is free, so reserve the whole space.** `{initial: 1, maximum:
65536}` costs **0.007 ms** (private) and **0.006 ms** (shared); committing
   256 MiB costs 0.010 ms. V8 backs the reservation with a guard region and
   commits lazily. There is no reason to size guest RAM tightly up front, and
   doing so would block `grow()` later.
3. **The register file lives in the memory, in a control page — not in imported
   Wasm globals.** `regalloc: 'memory'` beat 33 imported mutable globals on
   every workload: 1.5× arith-loop, 1.5× memory-copy, 1.6× matrix, 1.1–1.3×
   elsewhere, and 2.4× on the exit-heavy device-poll case, where a memory
   register file needs almost no host sync. Imported mutable globals cost on
   both sides: Wasm reaches them through an import indirection, and the host
   reaches them through ~64 `WebAssembly.Global.value` property accesses per
   transition.

**Consequence of (3): bounds checks must be inline, not trapping.** Trapping
bounds are only sound when guest RAM is the _entire_ memory; with a control page
at the end, an out-of-range guest access would silently land in the control page
instead of faulting. The engine therefore rejects `bounds: 'trap'` together with
a control page. Measured cost of inline vs trapping bounds: **within ±5% on
every workload**, so the safety is free. Both remain supported and differentially
tested; `globals/trap` stays useful for a guest image that wants every byte of
RAM and no control page.

## Consequences

**Positive**

- Atomics and LR/SC map directly onto Wasm atomics with no host round trip:
  `i32.atomic.rmw*` verified against the real 0xfe opcode layout. The atomics
  workload reaches 14.9× the interpreter.
- One memory, imported by every region module and every vCPU worker, so SMP
  (Spike B) needs no marshalling.
- `sharedMemoryGrowable` is true, so ballooning (Phase 3) can `grow()` a live
  memory.
- A 4 GiB reservation means the guest's physical address space can be sparse and
  device MMIO can live at its QEMU-`virt` addresses (`0x0200_0000` CLINT,
  `0x0c00_0000` PLIC, `0x1000_0000` UART, …) without remapping.

**Negative / obligations**

- **No guard pages, so no free bounds checking.** Every load/store in generated
  code carries an inline compare-and-branch. That is the ±5% measured above, and
  it is also why a _slow_ pc (MMIO) has to be learned and the block split before
  it (ADR-0002) — otherwise generated code performs the access itself.
- **The control page is a second address range in the same memory.** The
  translator must never let guest code reach it. Today that is enforced by
  placing it above guest RAM and by inline bounds; it needs an explicit test that
  a guest store to the control-page offset traps rather than corrupting the
  register file.
- **4 GiB is a hard ceiling.** A guest wanting more physical RAM needs paging or
  multiple memories. Mitigations: ballooning, and the fact that a browser tab
  will not survive a multi-GiB guest anyway (ROADMAP §12, mobile caps).
- **`crossOriginIsolated` is required** for `shared: true` to be usable at all,
  which makes COOP/COEP a hard dependency of the whole product (ADR-0010). In
  Node it reports `null`; in a browser without the headers, shared memory
  construction throws.
- **Shared memory is committed more eagerly than private memory in browsers, and
  the 4 GiB shared figure above is a Node figure.** Probing it inside a renderer
  killed the page outright: the first CI browser run produced twenty minutes of
  silence because the capability probe binary-searched the shared maximum up to
  4 GiB and the renderer never came back. The probe is now bounded
  (`SHARED_PROBE_CEILING_BROWSER`, 256 MiB in a page against the full range in
  Node) and reports the ceiling alongside the result, so a capped number cannot
  be read as a limit. **The largest shared reservation a browser will grant is an
  open question**, and it is load-bearing: guest RAM has to be shared for SMP, so
  Spike B must measure it per engine, in a worker so a refusal cannot take the
  page down, and the engine must fall back to a smaller maximum derived from
  `navigator.deviceMemory`, reported via `wnx doctor`.
- **`ramBase` subtraction is a per-region constant.** It must be folded at
  translation time (it is), and any change to the mapping invalidates the code
  cache. The slow-pc set has the same dependency and is currently _not_
  invalidated on mapping changes — tracked as a follow-up.

## Evidence

| probe                                                      | result (Node 22 / V8)               |
| ---------------------------------------------------------- | ----------------------------------- |
| `threads`, `atomics`, `atomicWait`, `sharedMemoryGrowable` | all **yes**                         |
| `memory64`                                                 | validates, **does not run**         |
| reserve 4 GiB, `initial:1 maximum:65536`                   | **0.007 ms**                        |
| reserve 4 GiB, shared                                      | **0.006 ms** - Node only, see below |
| commit 256 MiB / shared 256 MiB                            | 0.010 ms / 0.007 ms                 |
| max reservable pages (private / shared)                    | 65536 / 65536                       |
| `i32.atomic.add` in Wasm                                   | 9.7 ns/op                           |
| `Atomics.add` / `compareExchange` from JS                  | 10.1 / 10.7 ns/op                   |
| plain Wasm store+load                                      | 0.29 ns/op                          |

An atomic RMW costs ≈33× a plain access — relevant to Spike B and to any
spinlock-heavy guest path.

## Follow-ups

- Make `CpuState.regs` an `Int32Array` **view** onto the control page, turning
  every host transition from ~64 property accesses into zero copies.
- Software TLB in the load/store path once the MMU exists (Phase 1), then
  re-measure: the inline-bounds result may not survive an address translation.
- Size the shared `maximum` from `navigator.deviceMemory` and report refusals.
- Measure the largest shared reservation per browser engine, in a worker.
- Invalidate the slow-pc set when guest mappings change.
- Test that guest writes to the control-page offset fault.
