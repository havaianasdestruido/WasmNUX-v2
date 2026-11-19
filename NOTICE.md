# Third-party notices

WasmNUX's Apache-2.0 license does not relicense independent upstream works. Phase 0 uses these external fixtures and libraries under their upstream terms. Keep their notices with any redistributed copies.

| Dependency or asset | License / source |
|---|---|
| `v86` browser benchmark | BSD-2-Clause; [v86](https://github.com/copy/v86) |
| SeaBIOS, downloaded at benchmark time, not included in this repo | LGPL-3.0; the pinned v86 BIOS binary and rebuild instructions are in [v86/bios](https://github.com/copy/v86/tree/315b2b0b758703ef0e6cc7b4088d6068f83f3c20/bios). Preserve applicable source/notice obligations if distributing it. |
| `tcpip` and bundled lwIP | [tcpip.js](https://github.com/chipmk/tcpip.js) MIT; [lwIP](https://savannah.nongnu.org/projects/lwip/) BSD-3-Clause |
| `ws` | MIT; [ws](https://github.com/websockets/ws) |
| Fira Code and Noto Sans JP font subsets | SIL Open Font License 1.1; upstream notices in the installed `@fontsource/fira-code` and `@fontsource/noto-sans-jp` packages |
| Chromium, SwiftShader and packaged headless Chromium | [Chromium third-party credits](https://www.chromium.org/credits/), [SwiftShader](https://github.com/google/swiftshader) (Apache-2.0), [Sparticuz Chromium](https://github.com/Sparticuz/chromium) (MIT packaging) |
| Playwright and esbuild | [Playwright](https://github.com/microsoft/playwright) Apache-2.0; [esbuild](https://github.com/evanw/esbuild) MIT |

See `package-lock.json` and the upstream packages for the exact dependency graph and licenses. The Debian kernel, Mesa drivers, firmware, and guest packages are not bundled in Phase 0.
