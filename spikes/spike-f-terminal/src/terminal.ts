/**
 * Spike F — text measurement & glyph atlas (ADR-0009, ROADMAP §4 terminal
 * KPIs: keystroke→pixel ≤ 1 frame, Unicode: wide chars, emoji, combining
 * marks, ligatures, IME).
 *
 * Phase 0 scope: wcwidth-class width tables, an LRU glyph-atlas packer with
 * an allocation invariant test, and a cell buffer with damage + wide-char
 * double-cell semantics + IME composition state.
 */

export type CharWidth = 0 | 1 | 2;

/**
 * Combining marks / zero-width ranges (subset — full tables land in Phase 2).
 * Ranges are inclusive [lo, hi], sorted & merged.
 */
const ZERO_WIDTH: Array<[number, number]> = [
  [0x0300, 0x036f], [0x0483, 0x0489], [0x0591, 0x05bd],
  [0x0610, 0x061a], [0x064b, 0x065f], [0x0670, 0x0670],
  [0x06d6, 0x06dc], [0x0711, 0x0711], [0x0730, 0x074a],
  [0x0e31, 0x0e31], [0x0e34, 0x0e3a], [0x0e47, 0x0e4e],
  [0x200b, 0x200f], [0x202a, 0x202e], [0x2060, 0x2064],
  [0xfe00, 0xfe0f], [0xfe20, 0xfe2f], [0xfeff, 0xfeff],
  [0x1ab0, 0x1aff], [0x1dc0, 0x1dff],
  [0x20d0, 0x20ff], [0xfe00, 0xfe0f],
];
ZERO_WIDTH.sort((a, b) => a[0] - b[0]); // binary search requires sorted ranges

/** East Asian Wide/Fullwidth ranges (subset; emoji treated as wide). */
const WIDE: Array<[number, number]> = [
  [0x1100, 0x115f], [0x2e80, 0x303e], [0x3041, 0x33ff],
  [0x3400, 0x4dbf], [0x4e00, 0x9fff], [0xa000, 0xa4cf],
  [0xa960, 0xa97f], [0xac00, 0xd7a3], [0xf900, 0xfaff],
  [0xfe10, 0xfe19], [0xfe30, 0xfe6f], [0xff00, 0xff60],
  [0xffe0, 0xffe6], [0x1f300, 0x1f64f], [0x1f680, 0x1f6ff],
  [0x1f900, 0x1f9ff], [0x20000, 0x2fffd], [0x30000, 0x3fffd],
];

function inRanges(cp: number, ranges: Array<[number, number]>): boolean {
  let lo = 0;
  let hi = ranges.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const [a, b] = ranges[mid]!;
    if (cp < a) hi = mid - 1;
    else if (cp > b) lo = mid + 1;
    else return true;
  }
  return false;
}

export function charWidth(cp: number): CharWidth {
  if (cp === 0) return 0;
  if (cp < 0x20 || (cp >= 0x7f && cp < 0xa0)) return 0; // controls
  if (inRanges(cp, ZERO_WIDTH)) return 0;
  if (inRanges(cp, WIDE)) return 2;
  return 1;
}

/** Width of a grapheme-ish cluster string (base + combining marks). */
export function clusterWidth(s: string): number {
  let w = 0;
  let first = true;
  for (const ch of s) {
    const cw = charWidth(ch.codePointAt(0)!);
    if (first) { w += cw; first = false; }
    else if (cw > 0) w += cw; // zero-width marks add nothing
  }
  return w;
}

export interface LigatureRule {
  /** Exact sequence of characters (e.g. "=>" or "!="). */
  from: string;
  /** Replacement (informational; renderer keeps source cells for copy). */
  to: string;
}

/** Optional ligatures off by default (ADR-0009 keeps them opt-in). */
export const DEFAULT_LIGATURES: LigatureRule[] = [
  { from: "=>", to: "⇒" },
  { from: "!=", to: "≠" },
  { from: "<=", to: "≤" },
  { from: ">=", to: "≥" },
  { from: "->", to: "→" },
];

/** Greedy longest-match ligature scan over a row's text. */
export function findLigatures(text: string, rules: LigatureRule[] = DEFAULT_LIGATURES): Array<{ start: number; rule: LigatureRule }> {
  const out: Array<{ start: number; rule: LigatureRule }> = [];
  outer: for (let i = 0; i < text.length; i++) {
    for (const rule of [...rules].sort((a, b) => b.from.length - a.from.length)) {
      if (text.startsWith(rule.from, i)) {
        out.push({ start: i, rule });
        i += rule.from.length - 1;
        continue outer;
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Glyph atlas
// ---------------------------------------------------------------------------

export interface AtlasCell { x: number; y: number; }

export interface AtlasStats {
  allocated: number;
  evictions: number;
  hits: number;
  misses: number;
}

/**
 * Grid-pack glyph bitmap cache: cells of (cellW × cellH) in a W×H atlas.
 * LRU by touch order; invariant: no two live glyphs share a cell (property
 * test exercises allocation + eviction).
 */
export class GlyphAtlas {
  readonly cols: number;
  readonly rows: number;
  private readonly cells: Array<{ key: string; tick: number } | null>;
  private tick = 0;
  private readonly lru = new Map<string, number>(); // key → cell index
  readonly stats: AtlasStats = { allocated: 0, evictions: 0, hits: 0, misses: 0 };

  constructor(
    readonly widthPx: number,
    readonly heightPx: number,
    readonly cellW: number,
    readonly cellH: number,
  ) {
    if (widthPx % cellW !== 0 || heightPx % cellH !== 0) {
      throw new Error("atlas dimensions must be multiples of cell size");
    }
    this.cols = widthPx / cellW;
    this.rows = heightPx / cellH;
    this.cells = new Array(this.cols * this.rows).fill(null);
  }

  get capacity(): number { return this.cols * this.rows; }

  /** Get (or allocate) the cell for a glyph key; null when full after LRU. */
  lookup(key: string): AtlasCell | null {
    const existing = this.lru.get(key);
    if (existing !== undefined) {
      this.stats.hits++;
      this.touch(key, existing);
      return this.cellXy(existing);
    }
    this.stats.misses++;
    const free = this.cells.findIndex((c) => c === null);
    let idx: number;
    if (free >= 0) {
      idx = free;
      this.stats.allocated++;
    } else {
      // evict the least-recently-touched live cell
      let oldestKey: string | null = null;
      let oldestTick = Infinity;
      for (const [k] of this.lru) {
        const ki = this.lru.get(k)!;
        const t = this.cells[ki]?.tick ?? -1;
        if (t < oldestTick) { oldestTick = t; oldestKey = k; }
      }
      if (oldestKey === null) return null;
      idx = this.lru.get(oldestKey)!;
      this.lru.delete(oldestKey);
      this.stats.evictions++;
      this.cells[idx] = null;
      this.stats.allocated++;
    }
    this.lru.set(key, idx);
    this.touch(key, idx);
    this.cells[idx] = { key, tick: this.tick };
    return this.cellXy(idx);
  }

  private touch(key: string, idx: number): void {
    this.tick++;
    this.lru.set(key, idx);
    const c = this.cells[idx];
    if (c && c.key === key) c.tick = this.tick;
  }

  private cellXy(idx: number): AtlasCell {
    return { x: (idx % this.cols) * this.cellW, y: Math.floor(idx / this.cols) * this.cellH };
  }

  /** Expose occupancy for invariant checks. */
  occupiedIndices(): number[] {
    const out: number[] = [];
    this.cells.forEach((c, i) => { if (c) out.push(i); });
    return out;
  }

  has(key: string): boolean { return this.lru.has(key); }
}

// ---------------------------------------------------------------------------
// Cell buffer + IME
// ---------------------------------------------------------------------------

export interface Cell {
  /** Unicode codepoint (0 = continuation cell of a wide char). */
  cp: number;
  /** Row-wide damage flag lives outside cells for cache friendliness. */
}

export class TermBuffer {
  readonly width: number;
  readonly height: number;
  private cells: Uint32Array; // cp per cell; 0 = empty/continuation
  private dirty: Uint8Array;  // per-row dirty bitset
  cursorX = 0;
  cursorY = 0;

  constructor(width: number, height: number) {
    this.width = width;
    this.height = height;
    this.cells = new Uint32Array(width * height);
    this.dirty = new Uint8Array(Math.ceil(height / 8));
    this.markDirty(0); // initial full redraw handled by caller
  }

  private markDirty(y: number): void {
    if (y >= 0 && y < this.height) this.dirty[y >> 3]! |= 1 << (y & 7);
  }

  clear(): void {
    this.cells.fill(0);
    this.dirty.fill(0xff);
    this.cursorX = 0;
    this.cursorY = 0;
  }

  /**
   * Write a string at the cursor with wide-char semantics: a width-2 char
   * occupies its cell plus a continuation cell (cp stored, width respected on
   * read). Returns the number of COLUMNs advanced.
   */
  write(text: string): number {
    let advanced = 0;
    for (const ch of text) {
      const cp = ch.codePointAt(0)!;
      const w = charWidth(cp);
      if (w === 0) {
        // combining mark: attach to previous cell (store it there — simple
        // Phase 0 model: append to the cell's cp slot as base+mark is out of
        // scope; we keep the cell as-is and count nothing)
        continue;
      }
      if (this.cursorX + w > this.width) {
        this.cursorX = 0;
        this.cursorY = Math.min(this.height - 1, this.cursorY + 1);
      }
      const idx = this.cursorY * this.width + this.cursorX;
      this.cells[idx] = cp;
      this.markDirty(this.cursorY);
      if (w === 2) {
        if (this.cursorX + 1 < this.width) {
          this.cells[idx + 1] = 0x200b; // ZWSP marks continuation
          if (this.cursorX + 2 > this.width) { /* clipped */ }
        }
        this.cursorX += 2;
      } else {
        this.cursorX += 1;
      }
      advanced += w;
    }
    return advanced;
  }

  put(y: number, x: number, cp: number): void {
    if (y < 0 || y >= this.height || x < 0 || x >= this.width) return;
    this.cells[y * this.width + x] = cp;
    this.markDirty(y);
  }

  get(y: number, x: number): number {
    if (y < 0 || y >= this.height || x < 0 || x >= this.width) return 0;
    return this.cells[y * this.width + x]!;
  }

  takeDirtyRows(): number[] {
    const out: number[] = [];
    for (let y = 0; y < this.height; y++) {
      if (this.dirty[y >> 3]! & (1 << (y & 7))) out.push(y);
    }
    this.dirty.fill(0);
    return out;
  }

  rowText(y: number): string {
    if (y < 0 || y >= this.height) return "";
    let s = "";
    for (let x = 0; x < this.width; x++) {
      const cp = this.cells[y * this.width + x]!;
      if (cp === 0x200b) continue; // continuation of wide char
      if (cp === 0) continue;
      s += String.fromCodePoint(cp);
    }
    return s;
  }
}

export type ImeState =
  | { kind: "idle" }
  | { kind: "composing"; text: string; cursor: number }
  | { kind: "committed"; text: string };

/**
 * IME composition lifecycle: compositionstart → update* → commit|cancel.
 * The committed text is what gets written to the guest; composing text is
 * rendered locally (underline) and never reaches the guest until commit.
 */
export class ImeSession {
  private state: ImeState = { kind: "idle" };
  /** Committed output queue (guest key events). */
  readonly commits: string[] = [];

  get phase(): ImeState["kind"] { return this.state.kind; }
  get composing(): string | null {
    return this.state.kind === "composing" ? this.state.text : null;
  }

  start(): void {
    if (this.state.kind === "composing") return;
    this.state = { kind: "composing", text: "", cursor: 0 };
  }

  update(text: string, cursor = text.length): void {
    if (this.state.kind !== "composing") this.start();
    this.state = { kind: "composing", text, cursor };
  }

  commit(text?: string): string {
    if (this.state.kind === "composing") {
      const out = text ?? this.state.text;
      this.state = { kind: "committed", text: out };
      if (out) this.commits.push(out);
      this.state = { kind: "idle" };
      return out;
    }
    if (text) { this.commits.push(text); return text; }
    return "";
  }

  cancel(): void {
    this.state = { kind: "idle" };
  }
}
