/**
 * Damage tracking for the render grid: union of dirty rectangles,
 * in cell coordinates. Writing a cell marks its rectangle dirty.
 */
export interface Rect { x: number; y: number; w: number; h: number }

export function union(a: Rect, b: Rect): Rect {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  const right = Math.max(a.x + a.w, b.x + b.w);
  const bottom = Math.max(a.y + a.h, b.y + b.h);
  return { x, y, w: right - x, h: bottom - y };
}

export function unionMany(rects: Rect[]): Rect | null {
  if (rects.length === 0) return null;
  let acc = rects[0]!;
  for (let i = 1; i < rects.length; i++) acc = union(acc, rects[i]!);
  return acc;
}

export function area(r: Rect): number { return r.w * r.h; }

export class DamageTracker {
  private dirty: Rect | null = null;
  private readonly cols: number;
  private readonly rows: number;
  markedCells = 0;

  constructor(cols: number, rows: number) { this.cols = cols; this.rows = rows; }

  mark(x: number, y: number, w = 1, h = 1): void {
    const r = { x, y, w, h };
    this.dirty = this.dirty ? union(this.dirty, r) : r;
    this.markedCells += w * h;
  }

  /** Fast path for terminal scrolls: everything below the scroll line moved. */
  markScrolledLines(fromLine: number, lineCount: number): void {
    this.mark(0, fromLine, this.cols, lineCount);
  }

  /** Returns the current dirty union (or null) and resets tracking. */
  drain(): Rect | null {
    const d = this.dirty;
    this.dirty = null;
    this.markedCells = 0;
    return d;
  }

  coverageRatio(): number {
    if (!this.dirty) return 0;
    return area(this.dirty) / (this.cols * this.rows);
  }
}
