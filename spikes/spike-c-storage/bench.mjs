import { performance } from "node:perf_hooks";
import { CowBlockDevice, MemorySyncAccessHandle } from "./opfs-block.mjs";

export function runSpikeC() {
  const diskSize = 8 * 1024 * 1024; // 8 MiB
  const base = new Uint8Array(diskSize);
  const chunkSizes = [4096, 65536, 262144, 1048576];
  const results = [];

  for (const chunkSize of chunkSizes) {
    const dev = new CowBlockDevice(base, new MemorySyncAccessHandle(), chunkSize);
    const block = new Uint8Array(65536).fill(0xab);

    const tW0 = performance.now();
    for (let off = 0; off < diskSize; off += block.byteLength) {
      dev.write(off, block);
    }
    dev.flush();
    const writeMs = performance.now() - tW0;

    const tR0 = performance.now();
    for (let off = 0; off < diskSize; off += block.byteLength) {
      dev.read(off, block.byteLength);
    }
    const readMs = performance.now() - tR0;

    // 4 KiB random read IOPS
    const randReads = 10_000;
    const tRand0 = performance.now();
    for (let i = 0; i < randReads; i++) {
      const off = ((i * 7919) % (diskSize / 4096)) * 4096;
      dev.read(off, 4096);
    }
    const randMs = performance.now() - tRand0;

    results.push({
      chunkSize,
      seqWriteMBs: Number(((diskSize / (1024 * 1024)) / (writeMs / 1000)).toFixed(1)),
      seqReadMBs: Number(((diskSize / (1024 * 1024)) / (readMs / 1000)).toFixed(1)),
      rand4kIOPS: Math.round(randReads / (randMs / 1000)),
    });
  }

  return results;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  console.log("Spike C (Storage):", JSON.stringify(runSpikeC(), null, 2));
}
