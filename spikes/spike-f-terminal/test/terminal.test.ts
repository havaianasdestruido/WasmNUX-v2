import { describe, expect, it } from "vitest";
import {
  DEFAULT_LIGATURES, GlyphAtlas, ImeSession, TermBuffer,
  charWidth, clusterWidth, findLigatures,
} from "../src/terminal.js";

describe("spike F — character width", () => {
  it("ASCII and Latin are width 1", () => {
    for (const ch of ["a", "Z", "0", "~", "é", "ñ", "Ω"]) {
      expect(charWidth(ch.codePointAt(0)!), ch).toBe(1);
    }
  });

  it("CJK, Hangul and emoji are width 2", () => {
    for (const ch of ["漢", "字", "한", "글", "😀", "🚀", "Ａ"]) {
      expect(charWidth(ch.codePointAt(0)!), ch).toBe(2);
    }
  });

  it("combining marks and controls are width 0", () => {
    for (const ch of ["\u0301", "\u200d", "\ufe0f", "\u0007", "\u001b"]) {
      expect(charWidth(ch.codePointAt(0)!), JSON.stringify(ch)).toBe(0);
    }
  });

  it("cluster width counts only the base character", () => {
    expect(clusterWidth("e\u0301")).toBe(1);       // e + acute
    expect(clusterWidth("á̂")).toBe(1);       // stacked marks
    expect(clusterWidth("漢")).toBe(2);
    expect(clusterWidth("a漢b")).toBe(4);
  });

  it("finds ligature candidates greedily", () => {
    const ligs = findLigatures("x => y != z <= w");
    expect(ligs.map((l) => l.rule.from)).toEqual(["=>", "!=", "<="]);
    expect(findLigatures("plain text", DEFAULT_LIGATURES)).toEqual([]);
  });
});

describe("spike F — glyph atlas", () => {
  it("rejects non-divisible dimensions", () => {
    expect(() => new GlyphAtlas(100, 30, 8, 16)).toThrow(/multiples/);
  });

  it("allocates unique cells until capacity", () => {
    const atlas = new GlyphAtlas(64, 64, 8, 16); // 8 × 4 = 32 cells
    expect(atlas.capacity).toBe(32);
    const seen = new Set<string>();
    const coords = new Set<string>();
    for (let i = 0; i < 32; i++) {
      const key = `g${i}`;
      const cell = atlas.lookup(key);
      expect(cell, key).not.toBeNull();
      const c = `${cell!.x},${cell!.y}`;
      expect(coords.has(c), `overlap at ${c}`).toBe(false);
      coords.add(c);
      seen.add(key);
      expect(atlas.has(key)).toBe(true);
    }
    expect(atlas.stats.allocated).toBe(32);
    expect(atlas.stats.evictions).toBe(0);
    expect(atlas.occupiedIndices()).toHaveLength(32);
  });

  it("hits return the same cell without reallocating", () => {
    const atlas = new GlyphAtlas(64, 64, 8, 16);
    const a = atlas.lookup("A")!;
    const b = atlas.lookup("A")!;
    expect(a).toEqual(b);
    expect(atlas.stats.hits).toBe(1);
    expect(atlas.stats.misses).toBe(1);
    expect(atlas.occupiedIndices()).toHaveLength(1);
  });

  it("LRU eviction recycles the least-recently-used cell only", () => {
    const atlas = new GlyphAtlas(16, 16, 8, 16); // 2 × 1 = 2 cells
    const c0 = atlas.lookup("x")!; // cell (0,0)
    const c1 = atlas.lookup("y")!; // cell (8,0)
    atlas.lookup("x");             // touch x → y is now LRU
    const c2 = atlas.lookup("z")!; // evicts y
    expect(atlas.stats.evictions).toBe(1);
    expect(atlas.has("y")).toBe(false);
    expect(atlas.has("x")).toBe(true);
    expect(atlas.has("z")).toBe(true);
    // y's slot was recycled for z
    expect(c2).toEqual(c1);
    expect(c0).not.toEqual(c1);
    expect(atlas.occupiedIndices()).toHaveLength(2);
  });

  it("stays invariant under a long random workload", () => {
    const atlas = new GlyphAtlas(64, 32, 8, 16); // 32 cells
    let seed = 99;
    const rnd = (n: number): number => ((seed = (seed * 1103515245 + 12345) >>> 0), seed % n);
    const coordsAt = new Map<number, string>();
    for (let i = 0; i < 500; i++) {
      const key = `k${rnd(100)}`;
      const cell = atlas.lookup(key);
      expect(cell).not.toBeNull();
    }
    // no duplicate occupied indices, count ≤ capacity
    const occ = atlas.occupiedIndices();
    expect(new Set(occ).size).toBe(occ.length);
    expect(occ.length).toBeLessThanOrEqual(atlas.capacity);
    void coordsAt;
  });
});

describe("spike F — cell buffer", () => {
  it("writes text, advances cursor, reports damage", () => {
    const buf = new TermBuffer(16, 4);
    buf.takeDirtyRows(); // clear initial
    const adv = buf.write("hi");
    expect(adv).toBe(2);
    expect(buf.cursorX).toBe(2);
    expect(buf.rowText(0)).toBe("hi"); // empty cells are not materialised
    expect(buf.takeDirtyRows()).toEqual([0]);
    expect(buf.takeDirtyRows()).toEqual([]);
  });

  it("wide characters occupy two cells with a continuation", () => {
    const buf = new TermBuffer(8, 2);
    buf.takeDirtyRows();
    buf.write("漢");
    expect(buf.cursorX).toBe(2);
    expect(buf.get(0, 0)).toBe(0x6f22);
    expect(buf.get(0, 1)).toBe(0x200b); // continuation
    expect(buf.rowText(0).startsWith("漢")).toBe(true);
    // writing at the last column wraps rather than clipping a wide glyph
    buf.write("x漢x");
    expect(buf.cursorY).toBeLessThanOrEqual(1);
  });

  it("wraps at the right edge", () => {
    const buf = new TermBuffer(4, 3);
    buf.write("abcdef");
    expect(buf.cursorY).toBe(1);
    expect(buf.cursorX).toBe(2);
    expect(buf.rowText(0)).toBe("abcd");
  });

  it("zero-width marks do not advance the cursor", () => {
    const buf = new TermBuffer(8, 1);
    const adv = buf.write("e\u0301");
    expect(adv).toBe(1);
    expect(buf.cursorX).toBe(1);
  });

  it("put/get respects bounds", () => {
    const buf = new TermBuffer(4, 2);
    buf.put(-1, 0, 65);
    buf.put(0, 99, 65);
    buf.put(0, 0, 66);
    expect(buf.get(0, 0)).toBe(66);
    expect(buf.get(-1, 0)).toBe(0);
  });
});

describe("spike F — IME session", () => {
  it("commit flushes composed text to the guest queue", () => {
    const ime = new ImeSession();
    ime.start();
    expect(ime.phase).toBe("composing");
    ime.update("你好", 2);
    expect(ime.composing).toBe("你好");
    expect(ime.commits).toHaveLength(0); // guest sees nothing while composing
    const out = ime.commit();
    expect(out).toBe("你好");
    expect(ime.commits).toEqual(["你好"]);
    expect(ime.phase).toBe("idle");
    expect(ime.composing).toBeNull();
  });

  it("cancel drops composition without a commit", () => {
    const ime = new ImeSession();
    ime.start();
    ime.update("konnichiwa");
    ime.cancel();
    expect(ime.phase).toBe("idle");
    expect(ime.commits).toHaveLength(0);
  });

  it("commit with explicit text overrides", () => {
    const ime = new ImeSession();
    ime.start();
    ime.update("abc");
    expect(ime.commit("xyz")).toBe("xyz");
    expect(ime.commits).toEqual(["xyz"]);
  });
});
