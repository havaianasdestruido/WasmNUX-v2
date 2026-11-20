# ADR-0009: Terminal — custom WebGPU renderer, xterm.js as bootstrap only

- **Status:** Proposed (Phase 0) — Spike F confirms the renderer design
- **Related:** ADR-0007, ADR-0010

## Context

§1.2 of the ROADMAP: the UI _is_ a terminal. There are no toolbars, menus or
settings pages, so the terminal renderer is not a component of the product — for
most sessions it is the whole product. That raises its bar: keystroke→pixel
within one frame, `cat` of a large file saturating the display without blocking
a vCPU, plus Unicode wide chars, emoji, combining marks, bidi, IME, optional
ligatures, scrollback, selection, clipboard, bracketed paste, inline graphics
(Kitty/Sixel), and a built-in multiplexer.

`xterm.js` already implements much of that correctly and today. Its rendering
back ends (DOM, Canvas2D, WebGL) are the problem: the WebGL renderer is the fast
one, and it is deprecated upstream in favour of a DOM/Canvas path, which caps
throughput and makes the frame budget unreachable for high-rate output.

## Decision

- **Custom WebGPU glyph-atlas renderer** in the display worker on an
  `OffscreenCanvas`, with damage tracking: only changed cells are re-uploaded,
  and the atlas is a persistent GPU texture.
- **Canvas2D/WebGL fallback renderer** behind the same interface for browsers
  without WebGPU (§11 Tier 2/3).
- **`xterm.js` is a bootstrap dependency only** (Phase 1: "temporary terminal
  wired to the virtio console") and is removed in Phase 2. Its parser/ANSI
  handling is not reused: the terminal state machine lives in our own code so
  the renderer, the multiplexer, and the scrollback ring share one buffer.
- **Text state and presentation are separate.** A cell grid (codepoints +
  attributes) is the single source of truth; renderers are pure functions of a
  damage region. That is what makes the fallback renderer, the accessible text
  layer (§9 hardening: screen-reader mode), and screenshot-based tests all
  possible without a second implementation.
- **Input goes through the main thread only.** Keyboard/pointer events are
  captured there and pushed to the guest over a SAB ring; the renderer never
  handles input (§1: no hot-path work on the main thread — the corollary is that
  the main thread does nothing but input and permissions).
- **The multiplexer is part of the renderer**, not a guest-side tmux: splits and
  multiple PTYs are rendered by the terminal itself.

**Rejected: xterm.js long-term.** DOM/Canvas throughput ceiling, no control over
the frame budget, and its renderer architecture would have to be forked to meet
the KPI — at which point we own the code anyway, without owning the design.

**Rejected: WebGL-only renderer.** Deprecated trajectory upstream, no compute
shaders for glyph rasterisation or damage compaction, and it does not exist on
some newer configurations where WebGPU does.

## Consequences

**Positive**

- One renderer serves the terminal, the multiplexer, inline graphics, and the
  GUI/VNC scanout surface (ADR-0007 presents into the same canvas), so the
  TTY↔GUI switcher is a change of source, not a change of widget.
- Damage tracking plus a GPU atlas is the only design that plausibly hits
  ≤1 frame keystroke→pixel while `cat`ing a large file.
- Keyboard Lock (`Ctrl+W`, `Ctrl+T`, `Esc` reaching the guest) is our code, so
  it can be made to work with the multiplexer's key handling instead of fighting
  a library's.

**Negative / risks**

- **We own Unicode.** Wide chars, combining marks, emoji ZWJ sequences, bidi,
  grapheme cluster boundaries in selection, and IME composition are each a
  project. This is the largest hidden cost in the ADR and the reason Spike F
  exists.
- **Two renderers to keep pixel-identical** (WebGPU and the fallback), tested by
  screenshot diff (§9).
- **Font handling**: a glyph atlas needs shaping (HarfBuzz-class), fallback
  chains, and the Local Font Access API where available — none of which the
  browser hands us for free in a worker.
- **Removing xterm.js is a hard cutover.** Phase 1 must not grow dependencies on
  it; the terminal state machine should be written in Phase 1 even while
  xterm.js renders it.
- WebGPU is unavailable in some Tier-2/3 contexts, so the fallback is not a
  corner case — it is Firefox/Safari today.

## What Spike F must produce

- Keystroke→pixel latency and `cat large-file` throughput for the WebGPU
  renderer vs the Canvas2D fallback vs xterm.js, on the same host.
- A Unicode conformance pass: wide chars, emoji ZWJ, combining marks, bidi
  basics, IME composition, grapheme-correct selection.
- Ligature and glyph-atlas memory numbers (atlas size vs font coverage).
