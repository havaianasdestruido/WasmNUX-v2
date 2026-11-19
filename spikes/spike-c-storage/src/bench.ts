/**
 * Spike C benchmark: chunk-size sweep + COW write amplification.
 * Usage: node dist/src/bench.js [--json out.json] [--quick]
 *
 * NOTE: in Node we benchmark NodeFileBlockDevice (positional pread/pwrite on a
 * preallocated file) as the OPFS SyncAccessHandle proxy. On disks with page
 * cache, small sizes will look unrealistically fast; treat the sweep as
 * relative guidance and re-run in the browser harness for release numbers.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import os from 'node:os';
import { NodeFileBlockDevice } from './node-file-block-device.js';

const SWEEP = [4096, 8192, 16384, 32768, 65536, 131072, 262144, 524288, 1048576];

interface SweepPoint {
  chunkBytes: number;
  seqWriteMBs: number;
  seqReadMBs: number;
  random4KReadIOPS: number;
  random4KWriteIOPS: number;
}

function sweep(file: string, sizeBytes: number, quick: boolean): SweepPoint[] {
  const dev = new NodeFileBlockDevice(file, sizeBytes);
  const out: SweepPoint[] = [];
  const writeSpan = quick ? 8 * 1024 * 1024 : 32 * 1024 * 1024;
  const readSpan = writeSpan;
  const randOps = quick ? 500 : 3000;
  // Prefill
  const fill = new Uint8Array(1048576).map((_, i) => (i * 131) & 0xff);
  for (let off = 0; off < sizeBytes; off += fill.length) dev.writeAt(off, fill);
  dev.flush();

  for (const chunk of SWEEP) {
    // sequential write
    let t0 = performance.now();
    const wbuf = new Uint8Array(chunk).fill(0xa5);
    for (let off = 0; off < writeSpan; off += chunk) dev.writeAt(off, wbuf);
    dev.flush();
    const seqWriteMBs = (writeSpan / (performance.now() - t0)) / 1000;
    // sequential read
    t0 = performance.now();
    let sink = 0;
    for (let off = 0; off < readSpan; off += chunk) sink ^= dev.readAt(off, chunk)[0]!;
    void sink;
    const seqReadMBs = (readSpan / (performance.now() - t0)) / 1000;
    // random 4K read
    t0 = performance.now();
    let seed = 0x12345678;
    for (let i = 0; i < randOps; i++) {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      const off = Math.min(sizeBytes - 4096, Math.floor((seed / 0xffffffff) * (sizeBytes / 4096)) * 4096);
      sink ^= dev.readAt(off, 4096)[0]!;
    }
    const rDt = performance.now() - t0;
    const random4KReadIOPS = randOps / (rDt / 1000);
    // random 4K write
    seed = 0x87654321;
    t0 = performance.now();
    for (let i = 0; i < randOps; i++) {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      const off = Math.min(sizeBytes - 4096, Math.floor((seed / 0xffffffff) * (sizeBytes / 4096)) * 4096);
      dev.writeAt(off, wbuf4096());
    }
    dev.flush();
    const wDt = performance.now() - t0;
    const random4KWriteIOPS = randOps / (wDt / 1000);
    out.push({ chunkBytes: chunk, seqWriteMBs, seqReadMBs, random4KReadIOPS, random4KWriteIOPS });
    process.stderr.write(`  chunk ${chunk}: write ${seqWriteMBs.toFixed(0)} MB/s read ${seqReadMBs.toFixed(0)} MB/s r4k ${random4KReadIOPS.toFixed(0)} IOPS\n`);
  }
  dev.close();
  return out;
}
const W4096 = new Uint8Array(4096).fill(0x5a);
function wbuf4096(): Uint8Array { return W4096; }

async function main(): Promise<void> {
  const quick = process.argv.includes('--quick');
  const jsonIdx = process.argv.indexOf('--json');
  const dir = mkdtempSync(join(tmpdir(), 'wasmnux-spike-c-'));
  try {
    const sizeBytes = quick ? 64 * 1024 * 1024 : 256 * 1024 * 1024;
    process.stderr.write(`sweep on ${sizeBytes / 1048576} MiB file in ${dir}\n`);
    const results = sweep(join(dir, 'sweep.img'), sizeBytes, quick);
    const report = {
      benchmark: 'wasmnux-spike-c-storage',
      version: 1,
      timestamp: new Date().toISOString(),
      host: { cpus: os.cpus().length, model: os.cpus()[0]?.model ?? 'unknown', platform: process.platform, release: os.release() },
      config: { sizeBytes, quick },
      proxy: 'NodeFileBlockDevice (positional pread/pwrite) stands in for OPFS SyncAccessHandle; run in-browser harness for release numbers',
      chunkSweep: results,
    };
    const json = JSON.stringify(report, null, 2);
    if (jsonIdx >= 0 && process.argv[jsonIdx + 1]) writeFileSync(process.argv[jsonIdx + 1]!, json);
    console.log(json);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

main().catch(err => { console.error(err); process.exit(1); });
