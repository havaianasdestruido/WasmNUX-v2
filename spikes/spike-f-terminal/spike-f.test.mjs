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

test("Spike F: GlyphAtlas caches and evicts LRU", () => {
  const atlas = new GlyphAtlas(2);
  assert.equal(atlas.getOrInsert("a").hit, false);
  assert.equal(atlas.getOrInsert("b").hit, false);
  assert.equal(atlas.getOrInsert("a").hit, true);
  assert.equal(atlas.getOrInsert("c").hit, false); // evicts "b"
  assert.equal(atlas.cache.has("b"), false);
});

test("Spike F: benchmark runs cleanly", () => {
  const res = runSpikeF();
  assert.ok(res.throughputMBs > 0);
});
