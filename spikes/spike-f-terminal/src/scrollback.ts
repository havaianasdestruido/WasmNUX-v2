/**
 * Fixed-capacity scrollback ring. Push evicts oldest lines.
 * Iteration order: oldest -> newest.
 */
export class ScrollbackRing {
  private readonly buf: Array<string | undefined>;
  private head = 0; // index of oldest
  private count = 0;
  private pushed = 0;

  constructor(readonly capacity: number) {
    if (capacity <= 0) throw new Error('capacity must be positive');
    this.buf = new Array(capacity);
  }

  push(line: string): void {
    this.pushed++;
    if (this.count < this.capacity) {
      this.buf[(this.head + this.count) % this.capacity] = line;
      this.count++;
    } else {
      this.buf[this.head] = line;
      this.head = (this.head + 1) % this.capacity;
    }
  }

  get length(): number { return this.count; }
  /** Total lines ever pushed (monotonic), even if evicted. */
  get totalPushed(): number { return this.pushed; }

  lineAt(i: number): string {
    if (i < 0 || i >= this.count) throw new RangeError('line index out of range');
    return this.buf[(this.head + i) % this.capacity]!;
  }

  lines(): string[] {
    const out: string[] = new Array(this.count);
    for (let i = 0; i < this.count; i++) out[i] = this.lineAt(i);
    return out;
  }

  clear(): void { this.buf.fill(undefined); this.head = 0; this.count = 0; }
}
