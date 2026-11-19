# ADR-0009: Worker-rendered terminal with WebGPU glyph atlas

**Status:** Accepted direction.

**Decision.** Bootstrap the shell with xterm.js; replace the renderer with a display-worker glyph atlas and damage updates. Keep keyboard capture, focus and IME on the main thread. Deliver committed text only and preserve grapheme cluster widths across optional ligature spans. Keep a Canvas2D/WebGL fallback when no WebGPU adapter is available.

**Alternatives.** Retaining only xterm.js reduces initial work but leaves less control of rendering, scanout handoff and performance. Writing a full terminal before a guest boots risks optimizing the wrong workload.

**Evidence and revisit.** The probe shapes a limited fixture with loaded monospace/CJK fonts, renders instanced quads and reads back GPU pixels. Chromium CDP exercises IME composition. Full wcwidth/emoji/bidi, glyph cache limits, actual VT parsing, real platform IMEs, damage tracking and keystroke-to-pixel latency remain to be verified.
