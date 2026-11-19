# WasmNUX Roadmap

> A complete Debian Linux system running inside a browser tab. One fullscreen terminal, a WebGPU-accelerated display, a persistent disk, and real hardware access through Chromium's Web APIs. A VM that needs no install and starts instantly.

---

## TL;DR

- **What:** full-system emulator (JIT → WebAssembly) booting stock **Debian stable** (currently 13 "trixie") in a browser tab.
- **UI:** none. A fullscreen terminal. GUI sessions (X11/Wayland, any WM/DE) switch in on the same canvas, like VT switching.
- **Speed:** tiered JIT, multi-vCPU via Web Workers + shared memory, paravirtual (virtio) devices, snapshot-based instant resume, persisted JIT code cache.
- **Persistence:** OPFS-backed copy-on-write disk, snapshots, export/import. Close the tab, come back, nothing is lost.
- **GPU:** WebGPU for display and 3D/compute acceleration; software rendering (SIMD + threads) as fallback.
- **VNC:** built-in viewer, guest VNC server support, and an optional relay to expose the session to native VNC clients.
- **Hardware:** WebUSB, WebHID, WebSerial, WebBluetooth, File System Access, MIDI, Gamepad, audio, camera and more, exposed as real Linux devices.
- **Customization:** WM/DE installed by idempotent shell scripts (`scripts/utils/wm/install_*.sh`).
- **Path:** Phase 0 (spikes/ADRs) → v0.1 shell → v0.2 terminal + persistence → v0.3 performance → v0.4 network/apt → v0.5 display/WM/VNC → v0.6 GPU → v0.7 device bridges → v0.8 apt compatibility → v1.0.

> **Reality check on "faster than a VM".** A browser cannot use hardware virtualization (VT-x/KVM), so raw CPU throughput will not beat a native hypervisor. WasmNUX aims to be faster where a browser can actually win: **start time** (snapshots + warm JIT cache), **in-browser competitors** (best-in-class emulator throughput), **I/O latency** (OPFS + virtio, no network-disk layers), **zero install**, and **direct host-GPU access** through WebGPU. Every target below is built around those axes, and Phase 0 exists to validate the numbers before they become promises.

---

## 1. Vision and principles

### Goals

1. **Absolute performance.** Performance budgets are release gates, not afterthoughts.
2. **Zero chrome.** The UI is a terminal. No toolbars, menus, tabs, or settings pages. Everything is configured from inside the guest (`wnx` CLI) or by files.
3. **Real Debian.** Unmodified Debian userland, `apt` works for the whole archive (for the chosen architecture, see ADR-0001).
4. **Persistent by default.** State survives reloads, crashes, and browser restarts. Data loss is a P0 bug.
5. **Real hardware access** through browser APIs, with explicit user consent per device.
6. **Hackable.** Window managers, desktops, kernels, and drivers are swappable via scripts, not forks.
7. **Embeddable.** Ship `@wasmnux/core` so other sites can host the VM.

### Non-goals (for now)

- Nested KVM or hardware passthrough that browsers don't expose.
- Windows/macOS guests.
- Replacing native hypervisors for heavy compute.
- Firefox/Safari feature parity (core VM works there with degraded device support, see §11).

### Engineering principles

- **No hot-path work on the main thread.** Main thread = input + permissions only.
- **Zero-copy where possible.** SharedArrayBuffer rings (lock-free SPSC) between workers. No `postMessage` on hot paths.
- **Paravirtual over emulated.** virtio everywhere. Never emulate a real NIC/GPU/disk controller when a virtio device exists.
- **Measure first.** Every perf claim has a benchmark in CI. Regressions fail the build.
- **Stock where possible.** Prefer the unmodified Debian kernel/userland. Divergence must be justified by an ADR and a benchmark.

---

## 2. Architecture overview

```
 Browser tab (cross-origin isolated, fullscreen PWA)
 |
 |  [Main thread]               [Display worker]
 |   keyboard/pointer input      OffscreenCanvas + WebGPU
 |   permission prompts          terminal renderer + guest scanout
 |         |                            ^
 |         v     SAB rings / Atomics    |
 |  [vCPU workers x N]  <---- shared guest RAM (SharedArrayBuffer)
 |   tiered JIT: guest ISA -> WebAssembly
 |         |                |                 |
 |         v                v                 v
 |  [Storage worker]   [Net worker]     [Device bridge]
 |   OPFS COW disk      user-space       WebUSB / WebHID / WebSerial /
 |   snapshots          TCP/IP + relay   WebBluetooth / File System Access / ...
 |
 Guest: Debian + wnxd agent (virtio devices everywhere)
```

**Components**

| Component | Language | Notes |
|---|---|---|
| Emulator core (CPU, MMU, JIT, devices) | Rust → Wasm (`no_std`-style, SIMD + threads) | Hot path; no allocations in the run loop |
| Host glue (workers, bridges, UI shell) | TypeScript | Thin; delegates to core |
| Terminal renderer | Rust/WGSL + TS | WebGPU glyph atlas, damage tracking |
| Guest agent `wnxd` + CLI `wnx` | Rust (static musl/glibc) | Clipboard, resize, time sync, device attach, snapshot quiesce |
| Image builder | Shell + Rust | Reproducible Debian images, chunked + content-addressed |
| Relay (`wnx-relay`, optional, self-hostable) | Rust | Network egress, VNC export, WebRTC signaling |

---

## 3. Key decisions (ADRs to settle in Phase 0)

| ADR | Question | Leading option | Alternatives / trade-off |
|---|---|---|---|
| 0001 | **Guest ISA** | **riscv64** on a QEMU-`virt`-compatible machine: official Debian port, simplest ISA to JIT, stock Debian kernel boots | **amd64**: max package coverage, far heavier JIT (flags, segmentation, x87, SSE/AVX). **arm64**: full archive, moderate JIT complexity. Shared JIT infra keeps the door open for a second backend. |
| 0002 | Execution strategy | Tiered: interpreter → baseline block JIT → optimizing region JIT (superblocks, loop opts) | Pure interpreter (too slow), single-tier JIT (slow warm-up) |
| 0003 | Wasm module granularity | Region-per-module with in-function `br_table` dispatch to amortize instantiation cost | One module per basic block (instantiate overhead dominates) |
| 0004 | Guest RAM model | Shared `WebAssembly.Memory` (threads), Memory64 where available; explicit TLB check in generated code (Wasm has no `mprotect`/guard pages) | Memory32 only (4 GB ceiling) |
| 0005 | Disk layout | ext4 rootfs on virtio-blk, lazy chunked base image + OPFS COW overlay | overlayfs over EROFS base (complicates base upgrades; Debian upgrades go through `apt dist-upgrade` instead) |
| 0006 | Kernel | Stock Debian kernel as compat default; tuned `wasmnux` kernel (trimmed, tickless, paravirt) shipped from a signed WasmNUX apt repo | Custom-only (breaks `apt` kernel management) |
| 0007 | GPU acceleration path | Spike four paths: (A) virgl-style GL, (B) Venus/Vulkan serialization, (C) custom virtio-gpu context carrying WebGPU-shaped command streams via a Mesa driver, (D) lavapipe/llvmpipe with Wasm SIMD + threads as fallback | WebGPU is a *subset* of Vulkan, so some features need emulation or are unsupported |
| 0008 | Networking | User-space TCP/IP stack in Wasm + relay (WebSocket/WebRTC); Direct Sockets in an Isolated Web App build as the raw-socket tier | Fetch-only HTTP proxy (too limited) |
| 0009 | Terminal | Custom WebGPU renderer (Canvas2D/WebGL fallback); xterm.js only as bootstrap | xterm.js long-term (DOM/Canvas perf ceiling) |
| 0010 | Hosting/headers | COOP/COEP headers; `coi-serviceworker` fallback for static hosts that can't set headers | Headers-only |
| 0011 | License | Core permissive (MIT/Apache-2.0); GPL components isolated (kernel, etc.) | Copyleft core |
| 0012 | Debian tracking | Track **stable**; testing/sid via script; release upgrades happen inside the guest | Rolling images |

---

## 4. Performance budget and KPIs

> Targets are **proposals**. Phase 0 calibrates them against real measurements and the numbers become CI gates.

| Area | Metric | Target | Stretch |
|---|---|---|---|
| Startup | Resume from snapshot (warm cache) | ≤ 500 ms to usable prompt | ≤ 250 ms |
| Startup | Cold boot, no snapshot, warm cache | ≤ 5 s to login | ≤ 3 s |
| Startup | First visit, bytes before first prompt | ≤ 30 MB (rest lazy-fetched) | ≤ 15 MB |
| CPU | Single-thread throughput vs QEMU-TCG on same host | ≥ 50% | ≥ 75% |
| CPU | Throughput vs best existing in-browser emulator | ≥ 3× | ≥ 5× |
| SMP | Scaling on parallel workloads (`make -j`, up to 8 vCPUs) | ≥ 0.8× per core | ≥ 0.9× |
| Disk | Sequential read / write (with flush) | ≥ 300 / 100 MB/s | ≥ 1 GB/s / 300 MB/s |
| Disk | 4 KiB random read IOPS | ≥ 50k | ≥ 150k |
| Terminal | Keystroke → pixel latency | ≤ 1 frame | ≤ 8 ms |
| Terminal | Throughput (`cat` of large file) | saturates display, never blocks vCPU | n/a |
| GUI | Desktop compositing | 60 FPS at 1080p | 120 FPS |
| GUI | Input → photon latency | ≤ 2 frames | ≤ 1 frame |
| Memory | Idle guest host-side footprint | ≤ 200 MB | ≤ 128 MB |
| Snapshots | Idle snapshot size (compressed) | ≤ 50 MB | ≤ 25 MB |
| Reliability | Data loss on tab kill / power loss (fault-injection suite) | 0 corrupted filesystems | n/a |

---

## 5. Phases

Effort sizing: **S** ≈ weeks, **M** ≈ 1-2 months, **L** ≈ 3+ months (single focused developer; parallelizable across contributors).

### Phase 0: Foundations, spikes, and decisions · *M*

**Goal:** kill the biggest risks before building the real thing.

See the [Phase 0 evidence and exit decision](docs/phase-0.md) for measurements and open validation gates.

- [x] Monorepo, CI skeleton, license (ADR-0011), contribution docs
- [x] Benchmark harness (CoreMark, Dhrystone, `sysbench`, `fio`, self-compiling `gcc`, boot-time probes), results tracked per commit
- [x] **Spike A: JIT feasibility.** Translate hot blocks of the candidate ISA(s) to Wasm; measure vs interpreter and vs an existing in-browser emulator baseline
- [x] **Spike B: SMP.** N vCPU workers on shared memory; guest atomics (LR/SC, AMO) ↔ Wasm atomics; memory-model validation; `Atomics.wait` for idle (no spin)
- [ ] **Spike C: Storage.** OPFS sync-access-handle block device, chunk-size sweep, Storage Buckets durability, eviction behavior *(block device and origin-clear simulation implemented; automatic eviction and durability still unverified)*
- [ ] **Spike D: Display + GPU.** WebGPU scanout cost; the four GPU paths from ADR-0007 compared on conformance and speed *(scanout probe implemented; guest GPU paths not provisioned)*
- [ ] **Spike E: Network.** User-space stack + relay; Direct Sockets in an Isolated Web App *(relay measured; installed IWA run still required)*
- [x] **Spike F: Terminal.** WebGPU glyph-atlas renderer, ligatures/IME/wide chars
- [x] Write ADR-0001 … 0012

**Exit criteria:** measured numbers for every KPI row, written ADRs, explicit go/no-go on the JIT design.

---

### Phase 1: "Hello, shell" (v0.1) · *L*

**Goal:** boot Debian to a login prompt, correctly, even if slowly.

- [ ] Emulator core: CPU interpreter tier (correctness first), privilege modes, CSRs, MMU (page walker + software TLB), interrupts/timers, SBI
- [ ] Machine model compatible with QEMU `virt` so **stock Debian kernels boot unmodified**
- [ ] virtio devices: console, blk, rng, net (stub), vsock
- [ ] Direct kernel boot (kernel + initrd), no firmware/bootloader on the boot path
- [ ] Minimal Debian `minbase` rootfs, then full `apt` bootstrap
- [ ] Temporary terminal (xterm.js) wired to the virtio console
- [ ] Conformance: `riscv-tests`, `riscv-arch-test` green in CI; Linux boot test in headless Chromium

**Exit criteria:** `apt --version` and `gcc hello.c` work inside the tab. Boot is correct on every CI run.

---

### Phase 2: Fullscreen terminal and persistence (v0.2) · *L*

**Goal:** the product feels like a product: one terminal, nothing else, and nothing is ever lost.

**Terminal / UI**
- [ ] WebGPU terminal renderer in the display worker (OffscreenCanvas), true color, damage tracking, GPU glyph atlas
- [ ] Canvas2D/WebGL fallback renderer
- [ ] Unicode: wide chars, emoji, combining marks, bidi basics, IME, optional ligatures
- [ ] Scrollback ring buffer, selection, clipboard (Async Clipboard API), bracketed paste
- [ ] Inline graphics (Kitty graphics protocol / Sixel)
- [ ] **Built-in multiplexer**: splits and multiple PTYs rendered by the terminal itself (multi-tasking in the UI, no extra chrome)
- [ ] PWA install, fullscreen on first interaction, **Keyboard Lock** so `Ctrl+W`, `Ctrl+T`, `Esc`, etc. reach the guest
- [ ] Zero visible UI; errors and prompts (permission requests, quota warnings) appear as terminal text

**Persistence**
- [ ] Block layer: read-only content-addressed base image + **per-instance COW overlay in OPFS** (sparse chunks, optional zstd)
- [ ] `navigator.storage.persist()`, quota monitoring, low-space warnings surfaced in the terminal
- [ ] Crash consistency: journaled overlay metadata, correct `fsync`/flush semantics end-to-end (guest → virtio-blk → OPFS)
- [ ] Discard/TRIM support so deleted data frees browser storage
- [ ] Multi-tab safety: single-writer lock via Web Locks, graceful "instance in use" handling
- [ ] Multiple named instances per origin
- [ ] Export / import (`.wnx` archive), integrity checksums
- [ ] Fault-injection test suite (kill worker/tab mid-write, simulated quota errors)

**Image pipeline**
- [ ] Reproducible Debian image build (`scripts/image/build_base.sh`, debootstrap `minbase` + curated package set)
- [ ] Chunking, hashing, compression, range-request lazy fetch, service-worker cache, signed manifest

**Exit criteria:** close tab → reopen → files and installed packages intact. Kill-tab-mid-write fuzzing leaves a clean filesystem. First prompt within the first-visit byte budget.

---

### Phase 3: Performance pass (v0.3) · *L*

**Goal:** hit the KPI table. This phase is where the project earns its name.

- [ ] **Tiered JIT** per ADR-0002/0003: baseline block translator → optimizing regions (superblocks, constant propagation, register-to-Wasm-local allocation, dead-flag elimination, fast-path memory access with inline TLB probe)
- [ ] **Persistent JIT code cache** (compiled Wasm modules + hot-block profile stored in IndexedDB/OPFS, validated by image hash) for warm starts
- [ ] **Multi-vCPU SMP** (1…`hardwareConcurrency − reserve`), dynamic vCPU hot-plug (`wnx cpu set N`)
- [ ] Idle handling: `WFI` → `Atomics.wait`, tickless guest, no timer spin; dedicated timer worker to dodge main-thread timer clamping
- [ ] Lock-free SPSC rings for all device queues; batched interrupts / event-idx suppression
- [ ] Wasm SIMD for device models (memcpy, blit, checksum, compression)
- [ ] **Snapshots**: full CPU + RAM + device state, compressed, dirty-page tracking, incremental; instant resume
- [ ] **Tuned `wasmnux` kernel** (trimmed config, tickless, paravirt clock, `zram`/`zswap`), published from the WasmNUX apt repo
- [ ] Memory ballooning (`virtio-balloon`) to return RAM to the browser
- [ ] Background-tab strategy: keep workers alive and unthrottled where the browser allows (Web Locks, audio keep-alive, wake lock); document the remaining limits
- [ ] Perf dashboard + CI regression gates (fail PRs that regress KPIs beyond threshold)

**Exit criteria:** all "Target" KPIs met; published benchmark methodology and results.

---

### Phase 4: Networking and apt (v0.4) · *M*

**Goal:** the guest can reach the internet and `apt` just works.

- [ ] `virtio-net` backed by a user-space TCP/IP stack in Wasm (NAT, DHCP, DNS)
- [ ] Egress via `wnx-relay` (WebSocket/WebRTC), bring-your-own relay or hosted default
- [ ] DNS over HTTPS, IPv6
- [ ] `apt` over CORS-friendly mirror or relay; **shared package cache** persisted in OPFS and reused across instances
- [ ] Raw sockets (ICMP, UDP, listen) in the **Isolated Web App** build via Direct Sockets
- [ ] Inbound: expose guest ports to other tabs/devices via relay/WebRTC (`wnx forward 8080`)
- [ ] `virtio-vsock` for host↔guest channels (agent, bridges)
- [ ] Optional VPN integrations (WireGuard-in-guest over relay)

**Exit criteria:** `apt update && apt install build-essential git openssh-client` from a fresh instance; `git clone`, `curl`, `ssh` work; containers (`podman`/`docker`) work because the guest has a real kernel.

---

### Phase 5: Display, VNC, and WM/DE (v0.5) · *L*

**Goal:** a graphical desktop that is one keystroke away from the terminal, installable with one script.

**Display**
- [ ] `virtio-gpu` 2D + `virtio-input` (keyboard, mouse, touch, tablet, absolute pointer)
- [ ] Scanout presented via WebGPU in the display worker (no main-thread involvement)
- [ ] Dynamic guest resize (agent + DRM mode set), HiDPI scaling, fullscreen, Pointer Lock
- [ ] **TTY ↔ GUI switcher** on the same canvas (VT-style `Ctrl+Alt+F1…F7` through Keyboard Lock)
- [ ] Software-rendered baseline: Mesa llvmpipe with Wasm SIMD + threads
- [ ] Audio: `virtio-snd` → AudioWorklet (low-latency), mic via `getUserMedia`
- [ ] Clipboard + drag-and-drop bridge, notifications bridge (`notify-send` → Notifications API)

**WM/DE scripts** (see §8): X11 and Wayland bases, then desktops and tiling WMs, all idempotent shell scripts under `scripts/utils/wm/`.

**VNC**
- [ ] **Built-in RFB viewer** rendering into the same WebGPU canvas (ZRLE/Tight, optional H.264 via WebCodecs); gives detachable/reattachable GUI sessions (tmux-style, for desktops)
- [ ] Guest VNC server setup scripts (`scripts/utils/vnc/install_tigervnc.sh`, `install_wayvnc.sh`)
- [ ] **VNC out:** `wnx vnc share` exposes the session to native VNC clients through `wnx-relay` (TCP/5900 on the relay side, WebRTC/WebSocket to the tab), with one-time passwords and optional read-only mode
- [ ] **VNC in:** `wnx vnc connect host:port` to view remote servers through the relay

**Exit criteria:** `scripts/utils/wm/install_xfce.sh` (and i3, sway, KDE, GNOME) → desktop at 60 FPS / 1080p with software rendering on reference hardware; VNC works in all three directions.

---

### Phase 6: GPU acceleration, WebGPU (v0.6) · *L*

**Goal:** real 3D and compute from the host GPU, with graceful fallback.

- [ ] Implement the path chosen in ADR-0007 (GL/Vulkan → WebGPU), including shader translation (GLSL/SPIR-V → WGSL via Naga/Tint-class tooling)
- [ ] Feature-gap matrix (WebGPU ⊂ Vulkan) published; unsupported features fall back to software with a clear log line
- [ ] Zero-copy render targets: guest framebuffer = GPU texture where possible
- [ ] Guest-side Mesa driver/packaging via the WasmNUX apt repo; `scripts/utils/gpu/install_webgpu_mesa.sh`
- [ ] Compute: Vulkan compute / OpenCL-style workloads mapped to WebGPU compute
- [ ] Conformance: `glxinfo`, `vulkaninfo`, `vkcube`, `glmark2`, Mesa/dEQP subsets, Firefox/Chromium WebGL inside the guest
- [ ] Multi-GPU adapter selection, power preference (`wnx gpu`)
- [ ] Hardware video decode/encode via WebCodecs (virtio-video)

**Exit criteria:** `glmark2` and `vkcube` accelerated at target FPS; a desktop compositor and a browser in the guest run on the GPU path; fallback verified on a machine with WebGPU disabled.

---

### Phase 7: Device bridges (v0.7) · *L*

**Goal:** browser hardware APIs show up as ordinary Linux devices. Full table in §6.

- [ ] **Device Bridge** framework on the host (consent UX, persistence of grants, re-attach on boot via `getDevices()` where supported) + guest `wnxd` (hotplug, udev rules)
- [ ] **WebUSB** → virtual xHCI controller; devices appear in `lsusb`/libusb/usbfs (`adb`, `fastboot`, `dfu-util`, `avrdude`, `flashrom`)
- [ ] **WebHID** → virtual HID (`/dev/hidraw*`, report descriptors passed through)
- [ ] **WebSerial** → `/dev/ttyACM*` / `ttyUSB*` with baud rate and DTR/RTS control lines (flashing microcontrollers: `esptool`, `arduino-cli`, `picocom`)
- [ ] **WebBluetooth** → virtual BLE (GATT-client) stack exposed to BlueZ
- [ ] **File System Access API** → `virtio-fs` mount of user-picked host directories (`wnx mount host ~/Projects /mnt/projects`), handles persisted in IndexedDB, re-permission flow
- [ ] Web MIDI → ALSA rawmidi/seq
- [ ] Gamepad API → evdev/joydev; haptics where supported
- [ ] Camera/mic (`getUserMedia`) → V4L2 / ALSA
- [ ] Clipboard, Pointer/Keyboard Lock, Wake Lock, Window Management (multi-monitor)
- [ ] Extras: Web NFC, sensors/geolocation (IIO/`gpsd`), WebTransport, Local Font Access, File Handling / Launch Handler (open files in WasmNUX)
- [ ] `wnx attach|detach|list` CLI. The Enter keypress doubles as the **user activation** that browsers require before showing device choosers

**Exit criteria:** flash a microcontroller over WebSerial and a bootloader over WebUSB from inside the guest; mount a host folder read/write; use a gamepad and a MIDI keyboard in guest apps.

---

### Phase 8: "Every apt app" compatibility (v0.8) · *L*

**Goal:** turn "full apt support" into a measured, public number.

- [ ] Compatibility harness: install and smoke-test packages across the archive (`apt-get install`, `--version`/`--help`, `autopkgtest` where available, `piuparts` for install/remove hygiene)
- [ ] GUI harness: launch under Xvfb/Wayland, screenshot diff, crash detection
- [ ] **Compatibility tiers per package:** (1) installs, (2) runs, (3) autopkgtest passes, (4) GUI renders
- [ ] Public dashboard with per-package status and regressions
- [ ] Kernel/firmware/bootloader packages handled via `equivs` stubs and apt pinning (`linux-image-*`, `grub-*`, `firmware-*`); documented exclusions list
- [ ] systemd compatibility pass (stock units boot clean; masked-by-default list; optional fast-init profile)
- [ ] Foreign-arch opt-in: x86-64 binary translation inside the guest (e.g. box64 / qemu-user via `binfmt_misc`) for amd64-only software, with documented performance cost
- [ ] Upstream bug reports/patches for Debian packages that fail on the guest ISA
- [ ] Release upgrades tested: `apt dist-upgrade` stable → next stable inside the guest

**Exit criteria:** published compatibility ≥ agreed threshold (proposal: **≥ 99% tier-1, ≥ 95% tier-2** of packages for the guest architecture, with every exclusion documented).

---

### Phase 9: Hardening and 1.0 · *M*

- [ ] Security review + threat-model sign-off (§10), external audit if feasible
- [ ] Signed image/update pipeline (minisign/sigstore), SRI for all assets, reproducible builds verified in CI
- [ ] Accessibility: screen-reader mode for the terminal (accessible text layer on demand), high-contrast themes, keyboard-only flows
- [ ] i18n / keyboard layouts / IME across guest and host
- [ ] Stable and nightly channels; in-place base upgrades that preserve user state
- [ ] Docs site, `@wasmnux/core` embedding API, examples (embed in a docs site, CI sandbox, teaching lab)
- [ ] Telemetry: **none by default**; opt-in local-only perf reports
- [ ] 1.0 perf report: every KPI row, reproducible

---

### Post-1.0 ideas

- amd64 (and/or arm64) first-class backend on the shared JIT infrastructure
- Live migration/sync of instances between devices (encrypted, via relay)
- Cluster mode: many tabs/devices as one SMP/NUMA-like system
- RDP/SPICE, Wayland-native remote (waypipe)
- WebNN/WebGPU ML acceleration surfaced as `/dev` nodes
- Record/replay debugging; time-travel snapshots
- Reproducible "environments as URLs" (shareable pre-built instances)
- Android/iOS-friendly input modes and PWAs

---

## 6. Web API driver matrix

| Browser API | Guest-visible interface | Mechanism | Caveats |
|---|---|---|---|
| **WebUSB** | USB device (`lsusb`, libusb, usbfs) | Virtual xHCI controller backed by `USBDevice` transfers | Chromium blocks *protected interface classes* (HID, mass storage, audio, video, etc.) and some vendor IDs; use WebHID / File System Access for those |
| **WebHID** | `/dev/hidraw*`, HID input | Virtual HID device with report-descriptor passthrough | Blocklist of sensitive HID usages (e.g. FIDO); needs user gesture + chooser |
| **WebSerial** | `/dev/ttyACM*`, `/dev/ttyUSB*` | virtio-console or emulated CDC-ACM/16550 with control-line mapping | Baud/flow-control fidelity; permission prompt per port (re-attach via `getPorts()`) |
| **WebBluetooth** | BlueZ (BLE GATT client) | Virtual BLE controller shim → `bluetoothd` | **GATT-client only**, no raw HCI, no classic Bluetooth; scanning limited by the API |
| **File System Access** | `virtiofs` mounts (`/mnt/host/*`) | `FileSystemDirectoryHandle` + persisted handles | Re-permission after browser restart; Chromium-only; symlinks/permissions emulated |
| **OPFS** | Root disk / package cache | Sync access handles in a dedicated worker | Subject to quota/eviction → request persistent storage |
| **WebGPU** | DRM/Vulkan/GL (via ADR-0007 path) | Virtual GPU context → WebGPU command encoder | Feature subset of Vulkan; availability varies by OS/GPU; software fallback |
| **WebCodecs** | V4L2 / video accel | virtio-video | Codec support varies |
| **Web Audio / AudioWorklet** | ALSA/PipeWire/PulseAudio | virtio-snd | Autoplay policy: needs user activation |
| **getUserMedia** | `/dev/video*`, ALSA capture | V4L2 emulation + audio capture | Permission prompt; resolution/format negotiation |
| **Web MIDI** | ALSA rawmidi/seq | MIDI port bridge | SysEx needs explicit permission |
| **Gamepad API** | `/dev/input/js*`, evdev | virtio-input | Polling-based; mapping differs per pad |
| **Clipboard API** | Guest clipboard (X11/Wayland) | `wnxd` clipboard agent | Needs user activation / focus |
| **Keyboard Lock / Pointer Lock** | Full keyboard capture, relative mouse | Direct host APIs | Keyboard Lock requires fullscreen |
| **Window Management** | Multi-monitor layout | Display worker per screen | Permission prompt |
| **Screen Wake Lock** | Prevents sleep during long jobs | Host API tied to guest activity | Visible document only |
| **Web NFC** | NFC reader node | Bridge shim | Android Chrome only |
| **Generic Sensor / Geolocation** | IIO / `gpsd` | Bridge shim | Mostly mobile |
| **Direct Sockets** | Raw TCP/UDP/listen sockets | Net worker (IWA build) | **Isolated Web App only** |
| **WebTransport / WebRTC** | Relay + P2P for network and VNC | Net worker | Needs signaling/relay |

**Rules for every bridge**

1. Explicit user consent per device, persisted per instance, revocable from inside the guest.
2. No ambient access: a device is invisible to the guest until attached.
3. Feature-detect and degrade: absent API → clear message from `wnx`, never a crash.
4. Each bridge ships a guest-side test (`scripts/tests/devices/`) and a host-side mock for CI.

---

## 7. Repository layout (proposed)

```
wasmnux/
├── ROADMAP.md
├── core/                     # Rust emulator core (CPU, MMU, JIT, devices)
│   ├── cpu/ jit/ mmu/ devices/ snapshot/
├── host/                     # TypeScript host runtime (workers, bridges, UI shell)
│   ├── workers/ bridges/ terminal/ display/ storage/ net/
├── guest/                    # wnxd agent, wnx CLI, kernel configs, packaging
├── relay/                    # wnx-relay (network, VNC export, signaling)
├── image/                    # image build + chunking tools
├── scripts/
│   ├── image/                # build_base.sh, chunk_image.sh, sign_manifest.sh
│   ├── lib/                  # common.sh (logging, apt helpers, idempotency)
│   ├── tests/                # compat harness, device tests, screenshot tests
│   └── utils/
│       ├── wm/               # window managers / desktops (see §8)
│       ├── vnc/              # install_tigervnc.sh, install_wayvnc.sh, start_vnc.sh
│       ├── gpu/              # install_webgpu_mesa.sh, test_gpu.sh
│       ├── net/              # set_relay.sh, install_vpn.sh
│       ├── dev/              # install_toolchains.sh (build-essential, rust, node, ...)
│       ├── perf/             # tune.sh (zram, sysctl, governor)
│       └── apt/              # switch_suite.sh (stable/testing/sid), pin_kernel.sh
├── benchmarks/               # CI benchmark suite + baselines
├── docs/                     # ADRs, architecture, API, compatibility dashboard
└── web/                      # PWA shell, service worker, coi-serviceworker fallback
```

---

## 8. WM/DE scripts

Window managers and desktops are **not baked into the image**. They are installed by scripts, so the base stays small and the choice stays yours.

```
scripts/utils/wm/
├── install_x11.sh            # Xorg + modesetting driver, xinit, fonts, base session plumbing
├── install_wayland.sh        # wlroots stack, seatd, xdg-desktop-portal, Xwayland
├── install_i3.sh
├── install_openbox.sh
├── install_sway.sh
├── install_xfce.sh
├── install_lxqt.sh
├── install_kde.sh
├── install_gnome.sh
├── install_mate.sh
├── install_hyprland.sh       # requires the accelerated GPU path (Phase 6)
├── set_default_session.sh    # which session starts on TTY↔GUI switch
└── uninstall_*.sh            # clean removal, one per installer
```

**Script conventions**

- `#!/usr/bin/env bash`, `set -euo pipefail`, source `scripts/lib/common.sh`
- **Idempotent**: safe to run twice; detects what is already installed
- Non-interactive (`DEBIAN_FRONTEND=noninteractive`), `--dry-run`, `--no-recommends`, `--yes`
- Package lists live in `packages/*.list`, not inline
- Composable: `install_xfce.sh` calls `install_x11.sh` itself
- Each script has a CI test: install in a fresh instance, start the session headless, screenshot, assert
- Usage from the guest: `wnx session install xfce` (thin wrapper) or run the script directly

---

## 9. Testing, CI, and compatibility

| Layer | What | How |
|---|---|---|
| CPU correctness | ISA conformance, JIT vs interpreter equivalence | `riscv-tests`, `riscv-arch-test`, differential fuzzing against QEMU as oracle, random instruction streams |
| System | Boot, reboot, snapshot/restore, SMP stress | Headless Chromium (Playwright) with WebGPU/threads flags; boot loop with soak tests |
| Storage | Crash consistency, quota exhaustion, multi-tab | Fault injection; kill workers mid-write; filesystem `fsck` after each run |
| Performance | KPI table | Per-commit benchmarks, regression gates, public dashboard |
| Devices | Each bridge | Mocked browser APIs in CI, real hardware lab for releases |
| Graphics | GL/Vulkan conformance, desktop sessions | `glmark2`, `vkcube`, dEQP subsets, screenshot diffs |
| Compatibility | "Every apt app" | Tiered harness from Phase 8, public dashboard |
| Scripts | `scripts/utils/**` | Fresh-instance install tests, shellcheck, idempotency re-run |

---

## 10. Security model

- **The VM is the sandbox boundary.** The guest runs inside Wasm + Web Worker isolation. Treat the guest as untrusted.
- **Cross-origin isolation** (COOP/COEP) is required for threads; it also provides Spectre mitigations. Static hosts without header control use the service-worker fallback.
- **Strict CSP**, SRI on all shipped assets, signed image manifests, reproducible builds.
- **Device bridges are capability-based:** nothing is reachable until the user attaches it; grants are per instance and revocable.
- **Relay is untrusted by design:** end-to-end encrypted tunnels, no plaintext credentials; self-hostable.
- **Storage:** per-instance encryption at rest (optional, passphrase-derived key via WebCrypto); export archives are authenticated.
- **Supply chain:** pinned toolchains, locked dependencies, SBOM per release.

---

## 11. Browser support tiers

| Tier | Browsers | Experience |
|---|---|---|
| **1: Full** | Chromium-based (Chrome, Edge, Brave, ...) on desktop | Everything: WebGPU, device bridges, File System Access, Keyboard Lock, PWA, Isolated Web App build |
| **2: Core** | Firefox, Safari (desktop) | VM, terminal, persistence (OPFS), software rendering, networking via relay; no WebUSB/HID/Serial/Bluetooth, limited FS access |
| **3: Light** | Mobile browsers | VM + terminal with reduced memory/vCPU caps; touch-first input; device APIs where available (e.g. Web NFC on Android) |

Every feature is **capability-detected at runtime** and reported by `wnx doctor`.

---

## 12. Risks

| Risk | Impact | Mitigation |
|---|---|---|
| JIT-to-Wasm overhead (module instantiation, no direct jumps, no guard pages) | Misses perf targets | Phase 0 spike, region compilation, persistent code cache, tiering; keep interpreter fallback |
| Guest ISA vs package coverage (ADR-0001) | "Every apt app" not literally true on riscv64 | Measure coverage in Phase 0; publish exclusions; foreign-arch translation opt-in; amd64/arm64 backend on the shared JIT |
| Browser throttling of background tabs | Long jobs slow down | Worker-based vCPUs, Web Locks/audio/wake-lock strategies, document limits |
| Storage eviction / quota | Data loss | `persist()`, quota UI in terminal, export/backup nudges, Storage Buckets durability |
| WebGPU gaps vs Vulkan/GL | Some apps can't accelerate | Feature matrix + software fallback, upstream spec feedback |
| Web API restrictions (protected USB classes, BLE GATT only, user activation) | Not every device works | Document per-API limits clearly; route to the right API (HID/Serial/FSA) |
| Memory ceilings (Wasm 4 GB without Memory64, mobile limits) | Big guests fail | Memory64 where available, ballooning, per-device caps |
| Cross-origin isolation friction for embedders | Adoption | Service-worker fallback, clear embed docs, IWA path |
| Relay cost/trust | Network UX | Self-hostable relay, E2E encryption, direct-socket tier |
| Licensing (GPL kernel, Mesa, firmware) | Distribution blockers | ADR-0011; isolate GPL components; clear NOTICE files |
| Scope creep | Never shipping | Phase exit criteria are hard gates; post-1.0 list is parking, not backlog |

---

## 13. Milestone summary

| Version | Phase | Headline |
|---|---|---|
| - | 0 | Decisions made, numbers measured |
| **v0.1** | 1 | Debian boots to a shell |
| **v0.2** | 2 | Fullscreen terminal + persistent disk |
| **v0.3** | 3 | Performance targets hit; snapshots; SMP |
| **v0.4** | 4 | Internet + `apt install` anything |
| **v0.5** | 5 | GUI sessions, WM/DE scripts, VNC |
| **v0.6** | 6 | WebGPU-accelerated 3D and compute |
| **v0.7** | 7 | USB/HID/Serial/Bluetooth/File System bridges |
| **v0.8** | 8 | Measured "every apt app" compatibility |
| **v1.0** | 9 | Secure, accessible, documented, stable |
