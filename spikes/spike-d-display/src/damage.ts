/**
 * Spike D — scanout & damage tracking (ROADMAP §4 terminal/GUI KPIs).
 *
 * The display worker presents guest scanout without touching the main thread.
 * Two measurable primitives:
 *  - DamageTracker: which rows changed since last present (damage KPI:
 *    keystroke→pixel ≤ 1 frame means damage must be tiny and tracked cheaply).
 *  - presentFrame: byte-level diff + row blit into a staging buffer, returning
 *    the dirty region — feeds either a WebGPU texture upload or Canvas2D path.
 */

export class DamageTracker {
  private rows: Uint8Array;
  private full = true;

  constructor(readonly height: number) {
    this.rows = new Uint8Array(Math.ceil(height / 8));
  }

  markRow(y: number): void {
    if (y < 0 || y >= this.height) return;
    this.rows[y >> 3]! |= 1 << (y & 7);
  }

  markAll(): void {
    this.full = true;
    this.rows.fill(0xff);
  }

  get isFull(): boolean { return this.full; }

  /** Return dirty rows (ascending) and clear. */
  takeDamage(): number[] {
    if (this.full) {
      this.full = false;
      this.rows.fill(0);
      return Array.from({ length: this.height }, (_, i) => i);
    }
    const out: number[] = [];
    for (let y = 0; y < this.height; y++) {
      if (this.rows[y >> 3]! & (1 << (y & 7))) out.push(y);
    }
    this.rows.fill(0);
    return out;
  }

  /** Rows pending without clearing (frame budgeting). */
  peekDamageCount(): number {
    if (this.full) return this.height;
    let n = 0;
    for (let y = 0; y < this.height; y++) {
      if (this.rows[y >> 3]! & (1 << (y & 7))) n++;
    }
    return n;
  }
}

export interface PresentResult {
  /** Rows actually copied to the staging buffer. */
  rowsCopied: number;
  bytesChanged: number;
  /** Full-height or partial present. */
  partial: boolean;
}

/**
 * Copy changed rows of `frame` (RGBA8) into `staging`, skipping identical
 * rows when a previous frame is supplied. Returns bytes actually changed.
 */
export function presentFrame(
  staging: Uint8Array,
  frame: Uint8Array,
  previous: Uint8Array | null,
  width: number,
  height: number,
  damageRows?: readonly number[],
): PresentResult {
  const stride = width * 4;
  const rows = damageRows ?? Array.from({ length: height }, (_, i) => i);
  let bytesChanged = 0;
  let rowsCopied = 0;
  for (const y of rows) {
    const off = y * stride;
    const a = frame.subarray(off, off + stride);
    if (previous) {
      const b = previous.subarray(off, off + stride);
      let same = true;
      for (let i = 0; i < stride; i++) {
        if (a[i] !== b[i]) { same = false; break; }
      }
      if (same) continue; // identical row — nothing copied
      let changed = 0;
      for (let i = 0; i < stride; i++) if (a[i] !== b[i]) changed++;
      bytesChanged += changed;
    } else {
      bytesChanged += stride;
    }
    staging.set(a, off);
    rowsCopied++;
  }
  return {
    rowsCopied,
    bytesChanged,
    partial: damageRows !== undefined && damageRows.length < height,
  };
}

/** Fill a test pattern into an RGBA buffer (bench/screenshot fixtures). */
export function fillPattern(buf: Uint8Array, width: number, height: number, seed: number): void {
  let x = seed >>> 0;
  for (let i = 0; i < buf.length; i += 4) {
    x = (x * 1664525 + 1013904223) >>> 0;
    buf[i] = x & 0xff;
    buf[i + 1] = (x >>> 8) & 0xff;
    buf[i + 2] = (x >>> 16) & 0xff;
    buf[i + 3] = 255;
  }
  void width; void height;
}
