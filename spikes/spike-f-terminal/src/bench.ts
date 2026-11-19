/**
 * Spike F benchmark: CPU-side terminal render cost.
 * Usage: node dist/src/bench.js [--json out.json] [--quick]
 *
 * Simulates `cat`ing a large file into the terminal:
 *   segment (Intl.Segmenter) -> ligature tokenise -> atlas lookup -> grid fill -> blit
 * The GPU upload leg is measured by spike-d-display / the WebGPU probe page.
 */
import { performance } from 'node:perf_hooks';
import { writeFileSync } from 'node:fs';
import os from 'node:os';
import { tokenizeLine, graphemeWidth } from './text.js';
import { GlyphAtlas } from './atlas.js';
import { ScrollbackRing } from './scrollback.js';
import { DamageTracker } from './damage.js';

const COLS = 160, ROWS = 48, CELL_W = 8, CELL_H = 16;
const WIDTH = COLS * CELL_W, HEIGHT = ROWS * CELL_H;

function pseudoGlyph(key: string): Uint8Array {
  // Procedural 8x16 "glyph" — deterministic per key. Production embeds a real
  // PSF/BDF font; what matters here is blit cost, not legibility.
  let h = 2166136261 >>> 0;
  for (let i = 0; i < key.length; i++) { h ^= key.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
  const glyph = new Uint8Array(CELL_W * CELL_H);
  for (let i = 0; i < glyph.length; i++) {
    h = (Math.imul(h, 1103515245) + 12345) >>> 0;
    glyph[i] = (h & 1) ? 0xff : 0x00;
  }
  return glyph;
}

function benchCat(lines: string[], useLigatures: boolean): { cellsPerSec: number; atlasHitRate: number; linesPerSec: number } {
  const atlas = new GlyphAtlas(512, 512, CELL_W, CELL_H);
  const cache = new Map<string, Uint8Array>();
  const getGlyph = (k: string) => {
    let g = cache.get(k);
    if (!g) { g = pseudoGlyph(k); cache.set(k, g); }
    atlas.getOrInsert(k);
    return g;
  };
  let cells = 0;
  const t0 = performance.now();
  for (const line of lines) {
    if (useLigatures) {
      for (const tok of tokenizeLine(line)) {
        for (let i = 0; i < tok.text.length && i < 6; i++) getGlyph(tok.text); // stand-in: full token as key
        void getGlyph(tok.text);
        void graphemeWidth(tok.text);
        cells += tok.ligature ? 2 : graphemeWidth(tok.text);
      }
    } else {
      const bare = line.replace(/\P{ASCII}/gu, '?'); // ASCII-safe fast path for the plain baseline
      for (let i = 0; i < bare.length; i++) {
        const ch = bare[i]!;
        getGlyph(ch);
        cells += graphemeWidth(ch);
      }
    }
  }
  const dt = (performance.now() - t0) / 1000;
  return { cellsPerSec: cells / dt, atlasHitRate: atlas.stats().hitRate, linesPerSec: lines.length / dt };
}

function benchBlitDamage(fullFrames: number): { fullFramesPerSec: number; damageFramesPerSec: number; fullMBs: number } {
  const fb = new Uint8Array(WIDTH * HEIGHT * 4);
  const glyphs = Array.from({ length: 95 }, (_, i) => pseudoGlyph(String.fromCharCode(33 + i)));
  const drawFrame = (rows: number, damageOnly: boolean) => {
    const start = damageOnly ? ROWS - rows : 0;
    for (let cellY = start; cellY < ROWS; cellY++) {
      for (let cellX = 0; cellX < COLS; cellX++) {
        const g = glyphs[(cellX * 7 + cellY * 13) % 95]!;
        for (let y = 0; y < CELL_H; y++) {
          const rowOff = ((cellY * CELL_H + y) * WIDTH + cellX * CELL_W) * 4;
          for (let x = 0; x < CELL_W; x++) {
            const v = g[y * CELL_W + x] === 0xff ? 255 : 0;
            const o = rowOff + x * 4;
            fb[o] = v; fb[o + 1] = v; fb[o + 2] = v; fb[o + 3] = 255;
          }
        }
      }
    }
  };
  let t0 = performance.now();
  for (let i = 0; i < fullFrames; i++) drawFrame(ROWS, false);
  const fullDt = (performance.now() - t0) / 1000;
  // damage: a 2-line scroll (typical for cat output)
  t0 = performance.now();
  for (let i = 0; i < fullFrames; i++) drawFrame(2, true);
  const dmgDt = (performance.now() - t0) / 1000;
  const fullBytes = WIDTH * HEIGHT * 4 * fullFrames;
  return {
    fullFramesPerSec: fullFrames / fullDt,
    damageFramesPerSec: fullFrames / dmgDt,
    fullMBs: fullBytes / fullDt / 1e6,
  };
}

async function main(): Promise<void> {
  const quick = process.argv.includes('--quick');
  const jsonIdx = process.argv.indexOf('--json');
  const LINE = 'the quick brown fox jumps over 13 lazy dogs — 100% pure 𐐷 vapor, costs $3.50, path /usr/bin -> /usr/local/bin, x === y => z != w && ok\n';
  const LINE_COUNT = quick ? 3_000 : 20_000;
  const lines = Array.from({ length: LINE_COUNT }, () => LINE);

  const lig = benchCat(lines, true);
  process.stderr.write('ligature pass done\n');
  const plain = benchCat(lines, false);
  process.stderr.write('plain pass done\n');
  const blit = benchBlitDamage(quick ? 2 : 6);

  const ring = new ScrollbackRing(50_000);
  const t0 = performance.now();
  for (let i = 0; i < 200_000; i++) ring.push(`line ${i} ${LINE.repeat(2)}`);
  const ringDt = performance.now() - t0;

  const damage = new DamageTracker(COLS, ROWS);
  damage.markScrolledLines(ROWS - 2, 2);
  const report = {
    benchmark: 'wasmnux-spike-f-terminal',
    version: 1,
    timestamp: new Date().toISOString(),
    host: { cpus: os.cpus().length, model: os.cpus()[0]?.model ?? 'unknown', platform: process.platform, release: os.release() },
    grid: { cols: COLS, rows: ROWS, cellWidth: CELL_W, cellHeight: CELL_H, width: WIDTH, height: HEIGHT },
    ingest: {
      ligatureCellsPerSec: Math.round(lig.cellsPerSec),
      ligatureLinesPerSec: Math.round(lig.linesPerSec),
      ligatureAtlasHitRate: lig.atlasHitRate,
      plainCellsPerSec: Math.round(plain.cellsPerSec),
      plainLinesPerSec: Math.round(plain.linesPerSec),
      plainAtlasHitRate: plain.atlasHitRate,
    },
    render: {
      fullRedrawFramesPerSec: blit.fullFramesPerSec,
      damageRedrawFramesPerSec2LineScroll: blit.damageFramesPerSec,
      fullRedrawBandwidthMBs: blit.fullMBs,
    },
    scrollbackPushPerSec: Math.round(200_000 / (ringDt / 1000)),
    damageCoverageAfterScroll: damage.coverageRatio(),
    note: 'CPU-side model only. GPU/WebGPU scanout cost: see spike-d-display and web/probe/webgpu-scanout.html.',
  };
  const json = JSON.stringify(report, null, 2);
  if (jsonIdx >= 0 && process.argv[jsonIdx + 1]) writeFileSync(process.argv[jsonIdx + 1]!, json);
  console.log(json);
}

main().catch(err => { console.error(err); process.exit(1); });
