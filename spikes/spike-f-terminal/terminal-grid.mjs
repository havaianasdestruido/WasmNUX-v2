// Spike F: WebGPU glyph-atlas terminal grid with damage tracking, wide chars, and IME

export function charDisplayWidth(codePoint) {
  // Simplified East Asian Width / Emoji wide-char check
  if (
    (codePoint >= 0x1100 && codePoint <= 0x115f) ||
    (codePoint >= 0x2e80 && codePoint <= 0xa4cf) ||
    (codePoint >= 0xac00 && codePoint <= 0xd7a3) ||
    (codePoint >= 0xf900 && codePoint <= 0xfaff) ||
    (codePoint >= 0x1f300 && codePoint <= 0x1f9ff)
  ) {
    return 2;
  }
  if (codePoint < 0x20 || (codePoint >= 0x7f && codePoint < 0xa0)) return 0;
  return 1;
}

export class GlyphAtlas {
  constructor(maxGlyphs = 4096) {
    this.maxGlyphs = maxGlyphs;
    this.cache = new Map(); // key -> { u, v, w, h }
  }

  getOrInsert(key) {
    if (this.cache.has(key)) {
      const entry = this.cache.get(key);
      // LRU refresh
      this.cache.delete(key);
      this.cache.set(key, entry);
      return { hit: true, entry };
    }
    let slotIdx;
    if (this.cache.size >= this.maxGlyphs) {
      const oldestKey = this.cache.keys().next().value;
      slotIdx = this.cache.get(oldestKey).slotIdx;
      this.cache.delete(oldestKey);
    } else {
      slotIdx = this.cache.size;
    }
    const entry = { slotIdx, u: (slotIdx % 64) * 16, v: Math.floor(slotIdx / 64) * 32, w: 16, h: 32 };
    this.cache.set(key, entry);
    return { hit: false, entry };
  }
}

export class TerminalGrid {
  constructor(cols = 120, rows = 40) {
    this.cols = cols;
    this.rows = rows;
    this.cells = new Uint32Array(cols * rows);
    this.dirtyRows = new Uint8Array(rows);
    this.cursorX = 0;
    this.cursorY = 0;
    this.imePreedit = "";
  }

  writeText(text) {
    const segmenter = new Intl.Segmenter("en", { granularity: "grapheme" });
    for (const { segment } of segmenter.segment(text)) {
      const cp = segment.codePointAt(0);
      if (cp === 0x0a) {
        this.cursorX = 0;
        this.cursorY = (this.cursorY + 1) % this.rows;
        continue;
      }
      const width = segment.length > 1 && cp >= 0x1f000 ? 2 : charDisplayWidth(cp);
      if (width === 0) continue;
      if (this.cursorX + width > this.cols) {
        this.cursorX = 0;
        this.cursorY = (this.cursorY + 1) % this.rows;
      }
      const idx = this.cursorY * this.cols + this.cursorX;
      this.cells[idx] = cp;
      if (width === 2 && this.cursorX + 1 < this.cols) {
        this.cells[idx + 1] = 0; // wide-char continuation
      }
      this.dirtyRows[this.cursorY] = 1;
      this.cursorX += width;
    }
  }

  flushDamage() {
    const dirty = [];
    for (let r = 0; r < this.rows; r++) {
      if (this.dirtyRows[r]) {
        dirty.push(r);
        this.dirtyRows[r] = 0;
      }
    }
    return dirty;
  }
}
