/**
 * Glyph atlas (monospace grid variant).
 * The production renderer uses a GPU texture atlas; the packing math and the
 * LRU eviction policy are identical in either backing store.
 *
 * Grid policy: fixed cell size, ceil(atlasW/cellW) x ceil(atlasH/cellH) slots,
 * glyphs keyed by a string (e.g. 'a', '->', '\u{1F600}'). When full, the least
 * recently used glyphs are evicted (terminal workloads reuse a small hot set).
 */
export interface AtlasEntry {
  key: string;
  slot: number;
  row: number;
  col: number;
  hits: number;
}

export interface AtlasStats {
  slots: number;
  used: number;
  hits: number;
  misses: number;
  evictions: number;
  hitRate: number;
}

export class GlyphAtlas {
  readonly cellWidth: number;
  readonly cellHeight: number;
  readonly cols: number;
  readonly rows: number;
  private readonly entries = new Map<string, AtlasEntry>();
  private readonly lru: string[] = []; // back = most recent
  private hits = 0;
  private misses = 0;
  private evictions = 0;

  constructor(atlasWidth: number, atlasHeight: number, cellWidth = 8, cellHeight = 16) {
    if (atlasWidth % cellWidth || atlasHeight % cellHeight) {
      throw new Error('atlas dimensions must be cell-aligned');
    }
    this.cellWidth = cellWidth;
    this.cellHeight = cellHeight;
    this.cols = atlasWidth / cellWidth;
    this.rows = atlasHeight / cellHeight;
  }

  get slots(): number { return this.cols * this.rows; }

  lookup(key: string): AtlasEntry | null {
    const e = this.entries.get(key);
    if (e) {
      this.hits++;
      e.hits++;
      this.touch(key);
      return e;
    }
    this.misses++;
    return null;
  }

  /** Insert or fetch; evicts LRU entries when full. Returns the entry. */
  getOrInsert(key: string): AtlasEntry {
    const found = this.lookup(key);
    if (found) return found;
    if (this.entries.size >= this.slots) {
      const victim = this.lru.shift();
      if (victim === undefined) throw new Error('atlas full but LRU empty');
      this.entries.delete(victim);
      this.evictions++;
    }
    const usedSlots = new Set([...this.entries.values()].map(e => e.slot));
    let slot = -1;
    for (let s = 0; s < this.slots; s++) if (!usedSlots.has(s)) { slot = s; break; }
    if (slot === -1) throw new Error('no free slot after eviction (bug)');
    const entry: AtlasEntry = { key, slot, row: Math.floor(slot / this.cols), col: slot % this.cols, hits: 1 };
    this.entries.set(key, entry);
    this.lru.push(key);
    return entry;
  }

  private touch(key: string): void {
    const i = this.lru.indexOf(key);
    if (i >= 0) this.lru.splice(i, 1);
    this.lru.push(key);
  }

  stats(): AtlasStats {
    const total = this.hits + this.misses;
    return {
      slots: this.slots,
      used: this.entries.size,
      hits: this.hits,
      misses: this.misses,
      evictions: this.evictions,
      hitRate: total === 0 ? 0 : this.hits / total,
    };
  }

  /** Cell pixel coordinates of an entry (x, y, w, h). */
  rect(e: AtlasEntry): { x: number; y: number; w: number; h: number } {
    return { x: e.col * this.cellWidth, y: e.row * this.cellHeight, w: this.cellWidth, h: this.cellHeight };
  }
}
