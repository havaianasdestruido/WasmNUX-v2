# Phase 0 benchmarks

Run from the repository root after `npm ci`. Fixtures require Linux x86-64 and the tools listed in [CONTRIBUTING.md](../CONTRIBUTING.md).

```sh
npm run bench                                     # browser-results/<git SHA>.json
npm run bench -- browser-results/custom.json      # optional output path
npm run test:browser                              # correctness, not timing limits
```

CI uploads raw samples under `phase-zero-<git SHA>` (90-day retention); selected clean-source samples are archived under [`results/`](results/). Compare like-for-like browser versions, adapters, hardware and workloads. The browser suite runs serially on a fresh local origin. For a real GPU trial, set `CHROMIUM_PATH` to a full Chromium binary and run `WNX_HARDWARE_GPU=1 npm run bench`. If the compositor interop is unavailable, `graphics.scanout.destination` labels the `offscreen-texture` fallback; neither queue completion nor a texture copy is a presentation or input-to-photon measurement.

- **CPU:** 1 million iterations of a five-instruction arithmetic block in the interpreter, one-block JIT and bounded single-loop region; discard warm-up, record raw samples and compile+instantiate time. v86 runs the equivalent low-32-bit checksum in a freestanding i386 multiboot guest, with serial start/end markers. Its arithmetic width, register allocation, JIT, browser clock granularity and emulation boundary differ. This is not CoreMark, Debian, QEMU-TCG parity or a release-performance ratio.
- **SMP:** 1, 2 and 4 browser workers contend over shared Wasm memory, park via `Atomics.wait`, then run SC litmus checks. Worker duration excludes worker startup, and this is not `make -j` scaling.
- **OPFS:** four chunk sizes over an 8 MiB block device. Sequential write includes explicit flush; reopen/read includes opening handles; seeded 4 KiB reads use open handles. CDP origin clearing demonstrates data disappearance but is **not** automatic origin eviction. Quota override may not affect sync handles on some Chromium builds; `not-induced` is not a passing durability result.
- **Display/terminal:** queue-completion samples for uploading/copying 1080p; atlas samples plus GPU readback and deterministic raster controls. A real Chromium IME sequence asserts pre-edit does not escape as guest input and commit is delivered once.
- **Network:** separate lwIP Wasm stack instances connect through TUN and a two-peer WebSocket relay. TCP handshakes and a verified 16 KiB echo are measured; this is not egress, TLS, apt or a production relay.

## Debian workloads and boot probes

Run on a separately provisioned Debian guest, or an explicitly labeled native/QEMU-TCG control. Use the same pinned upstream CoreMark and Dhrystone source revisions and flags across targets, and build a clean GCC out-of-tree directory (`configure --enable-bootstrap`, default languages or explicitly record a subset). Record compiler flags, image digest, package versions and host profile alongside the JSON. `--disk-dir` should point to the test filesystem, not host `/tmp` or tmpfs. The harness creates a fresh scratch file there. A failed write prevents read benchmarks from reporting sparse-file numbers.

```sh
COMMIT=$(git rev-parse HEAD)                 # pass this exact value to the guest
python3 benchmarks/guest.py --commit "$COMMIT" --target QEMU-TCG \
  --jobs 1 --coremark /opt/probes/coremark --dhrystone /opt/probes/dhrystone \
  --gcc-build /opt/build/gcc-clean --disk-dir /var/tmp \
  --out "browser-results/$COMMIT-qemu-workloads.json"
```

Run `benchmarks/boot.py` on the host with an executable adapter that starts a VM, forwards the *guest* ready marker `WNX_LOGIN_READY` as its own output line, and has no buffered guest output. For `first-visit`, the adapter must also emit one `WNX_TRANSFER_BYTES=<integer>` line before readiness, using browser-level transfer accounting for all VM bootstrap traffic (including worker and range requests). Set up the correct browser profile, snapshot/cache state and network conditions for each trial in the adapter. The harness does not create VM state or a browser traffic meter by itself.

```sh
python3 benchmarks/boot.py --commit "$COMMIT" --target QEMU-TCG \
  --mode cold-warm-cache --samples 5 --out "browser-results/$COMMIT-qemu-boot.json" \
  -- /opt/probes/launch-debian-with-serial-readiness
```

## Graphics paths and Debian package coverage

Use the graphics matrix adapter contract once the guest and transports exist. Start from [`profiles/gpu-paths.json`](profiles/gpu-paths.json). Add a key for any provisioned path (`virgl`, `venus`, `webgpu-mesa`, `software`) with `configuration` (exact driver, VM, versions and workload), `argv` (command array), and optionally `timeout` (seconds). The adapter must output JSON with `conformance` (named test → boolean) and `frameTimesMs` (raw positive samples). Use `glmark2`/`vkcube` smoke tests and matched dEQP subsets within each advertised API, recording unsupported cases separately. Capture matched 1080p frame timing and report API and feature differences before drawing cross-path conclusions. Unconfigured paths are reported as `unavailable`.

```sh
python3 benchmarks/gpu_paths.py --commit "$COMMIT" --out "browser-results/$COMMIT-gpu-paths.json" benchmarks/profiles/gpu-paths.json
python3 benchmarks/coverage.py --commit "$COMMIT" --suite 'trixie @ <snapshot timestamp>' \
  --amd64 /path/amd64/Packages.xz --arm64 /path/arm64/Packages.xz \
  --riscv64 /path/riscv64/Packages.xz --out "browser-results/$COMMIT-coverage.json"
```

Supply the same suite, snapshot and components for each architecture, including `binary-all` inputs if separate. The coverage tool records archive index hashes and emits package-name exclusions versus amd64; it does not attempt to install or run them.

## Direct Sockets in an IWA (manual)

On a desktop with full Chromium/Chrome supporting development IWAs, run `node web/iwa/serve.mjs` on the **same host as the browser**. This serves a development proxy at `http://127.0.0.1:18996` and loopback-only TCP/UDP echo fixtures at port `18997`. Install from `chrome://web-app-internals` in IWA dev mode, or start a fresh browser profile with:

```sh
chromium --user-data-dir=/tmp/wnx-iwa-lab \
  --enable-features=IsolatedWebApps,IsolatedWebAppDevMode \
  --install-isolated-web-app-from-url=http://127.0.0.1:18996
```

Open the installed app, confirm the isolated app origin, grant loopback access if asked, and run the two echo tests. Save the reported JSON, browser version and commit with the lab results. Ordinary web pages are explicitly tested not to expose Direct Sockets. The packaged headless shell does not support installing/running the IWA; CI tests the manifest and the echo fixtures, not native socket access from an installed IWA. The development proxy and echo endpoints must not be exposed outside loopback.
