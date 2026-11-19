import test from "node:test";
import assert from "node:assert/strict";
import { TerminalGrid, GlyphAtlas, charDisplayWidth } from "./terminal-grid.mjs";
import { runSpikeF } from "./bench.mjs";

test("Spike F: wide chars and emoji occupy 2 cells and track damage", () => {
  const grid = new TerminalGrid(80, 24);
  assert.equal(charDisplayWidth("A".codePointAt(0)), 1);
  assert.equal(charDisplayWidth("日".codePointAt(0)), 2);
  assert.equal(charDisplayWidth("🚀".codePointAt(0)), 2);

  grid.writeText("A日");
  assert.equal(grid.cursorX, 3);
  assert.deepEqual(grid.flushDamage(), [0]);
  assert.deepEqual(grid.flushDamage(), []);
});

test("Spike F: GlyphAtlas caches, evicts LRU, and reuses evicted slot", () => {
  const atlas = new GlyphAtlas(2);
  const a = atlas.getOrInsert("a");
  const b = atlas.getOrInsert("b");
  assert.equal(a.hit, false);
  assert.equal(b.hit, false);
  assert.equal(atlas.getOrInsert("a").hit, true);
  const c = atlas.getOrInsert("c"); // evicts "b"
  assert.equal(c.hit, false);
  assert.equal(atlas.cache.has("b"), false);
  assert.equal(c.entry.slotIdx, b.entry.slotIdx);
  assert.notEqual(c.entry.slotIdx, a.entry.slotIdx);
});

test("Spike F: ZWJ emoji sequence occupies 2 columns", () => {
  const grid = new TerminalGrid(80, 24);
  grid.writeText("👨‍👩‍👧‍👦");
  assert.equal(grid.cursorX, 2);
});

test("Spike F: benchmark runs cleanly", () => {
  const res = runSpikeF();
  assert.ok(res.throughputMBs > 0);
});
