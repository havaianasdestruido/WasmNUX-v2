import { performance } from "node:perf_hooks";
import { TerminalGrid, GlyphAtlas } from "./terminal-grid.mjs";

export function runSpikeF() {
  const grid = new TerminalGrid(120, 40);
  const atlas = new GlyphAtlas(4096);
  const line = "user@wasmnux:~/project$ ls -la --color=auto  日本語 🚀\n";
  const lines = 20_000;

  const t0 = performance.now();
  for (let i = 0; i < lines; i++) {
    grid.writeText(line);
    if (i % 40 === 0) grid.flushDamage();
  }
  for (const ch of line) {
    atlas.getOrInsert(ch);
  }
  const ms = performance.now() - t0;
  const totalBytes = lines * line.length;

  return {
    lines,
    throughputMBs: Number(((totalBytes / (1024 * 1024)) / (ms / 1000)).toFixed(1)),
    ms: Number(ms.toFixed(2)),
    atlasSize: atlas.cache.size,
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  console.log("Spike F (Terminal):", JSON.stringify(runSpikeF(), null, 2));
}
