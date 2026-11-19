import { test } from 'node:test';
import assert from 'node:assert/strict';
import { graphemeWidth, countCells, segmentGraphemes, tokenizeLine, tokenWidth } from '../src/text.js';
import { GlyphAtlas } from '../src/atlas.js';
import { ScrollbackRing } from '../src/scrollback.js';
import { DamageTracker, unionMany, area } from '../src/damage.js';

test('width: ASCII=1, combining=0, CJK=2, emoji=2, ZWJ family=2', () => {
  assert.equal(graphemeWidth('a'), 1);
  assert.equal(graphemeWidth('\u0301'), 0);         // combining acute
  assert.equal(graphemeWidth('e\u0301'), 1);        // precomposed equivalent
  assert.equal(graphemeWidth('中'), 2);
  assert.equal(graphemeWidth('\u{1F600}'), 2);          // grinning face
  assert.equal(graphemeWidth('👦🏽'), 2);             // person + skin tone
  assert.equal(graphemeWidth('👨‍👩‍👧'), 2);             // ZWJ family — one cluster, wide
  assert.equal(countCells('ab中\u{1F600}'), 6);
});

test('graphemes: e + combining acute is one cluster', () => {
  const g = segmentGraphemes('e\u0301x');
  assert.equal(g.length, 2);
  assert.equal(g[0]!.text, 'e\u0301');
});

test('ligatures: longest match wins (=== over ==, <!-- kept whole)', () => {
  const toks = tokenizeLine('a === b => c <!-- d');
  const ligs = toks.filter(t => t.ligature).map(t => t.text);
  assert.deepEqual(ligs, ['===', '=>', '<!--']);
  assert.equal(tokenWidth(toks.find(t => t.text === '===')!), 3);
});

test('atlas: insert, lookup, slot exhaustion and LRU eviction', () => {
  const atlas = new GlyphAtlas(64, 32, 8, 16); // 8 * 2 = 16 slots
  assert.equal(atlas.slots, 16);
  for (let i = 0; i < 16; i++) atlas.getOrInsert(`glyph-${i}`);
  assert.equal(atlas.stats().used, 16);
  assert.equal(atlas.stats().evictions, 0);
  // touch glyph-0 so it is recently used, then force eviction by adding more
  atlas.lookup('glyph-0');
  atlas.getOrInsert('glyph-16');
  assert.equal(atlas.stats().evictions, 1);
  assert.ok(atlas.lookup('glyph-0') !== null, 'recently-used glyph should survive eviction');
  assert.equal(atlas.lookup('glyph-1'), null, 'LRU victim (glyph-1) should be evicted');
});

test('atlas: rect layout matches slot', () => {
  const atlas = new GlyphAtlas(64, 32, 8, 16);
  const e = atlas.getOrInsert('A');
  const r = atlas.rect(e);
  assert.deepEqual(r, { x: 0, y: 0, w: 8, h: 16 });
});

test('scrollback: ring eviction keeps the newest lines in order', () => {
  const ring = new ScrollbackRing(3);
  ring.push('l1'); ring.push('l2'); ring.push('l3'); ring.push('l4'); ring.push('l5');
  assert.equal(ring.length, 3);
  assert.deepEqual(ring.lines(), ['l3', 'l4', 'l5']);
  assert.equal(ring.totalPushed, 5);
  ring.clear();
  assert.equal(ring.length, 0);
});

test('damage: union of rects; scroll marks a wide short region', () => {
  const d = new DamageTracker(160, 48);
  assert.equal(d.drain(), null);
  d.markScrolledLines(46, 2);
  const r = d.drain()!;
  assert.deepEqual(r, { x: 0, y: 46, w: 160, h: 2 });
  assert.equal(d.coverageRatio(), 0); // drained
  d.mark(10, 10); d.mark(20, 10);
  const u = d.drain()!;
  assert.deepEqual(u, { x: 10, y: 10, w: 11, h: 1 });
});

test('unionMany: single rect and span', () => {
  const r = unionMany([{ x: 0, y: 0, w: 1, h: 1 }, { x: 5, y: 5, w: 1, h: 1 }])!;
  assert.deepEqual(r, { x: 0, y: 0, w: 6, h: 6 });
  assert.equal(area(r), 36);
});
