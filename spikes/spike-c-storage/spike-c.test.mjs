import test from "node:test";
import assert from "node:assert/strict";
import { CowBlockDevice, MemorySyncAccessHandle } from "./opfs-block.mjs";
import { runSpikeC } from "./bench.mjs";

test("Spike C: COW overlay preserves base image and isolates writes", () => {
  const base = new Uint8Array(16384).fill(0x11);
  const dev = new CowBlockDevice(base, new MemorySyncAccessHandle(), 4096);

  // Read from base
  assert.equal(dev.read(0, 4)[0], 0x11);

  // Write to chunk 1
  dev.write(4096, new Uint8Array([0xaa, 0xbb, 0xcc, 0xdd]));
  dev.flush();

  assert.deepEqual(dev.read(4096, 4), new Uint8Array([0xaa, 0xbb, 0xcc, 0xdd]));
  assert.equal(dev.read(4100, 1)[0], 0x11); // rest of chunk 1 copied from base
  assert.equal(base[4096], 0x11); // base untouched
});

test("Spike C: TRIM/discard frees whole chunks", () => {
  const base = new Uint8Array(16384);
  const dev = new CowBlockDevice(base, new MemorySyncAccessHandle(), 4096);
  dev.write(4096, new Uint8Array(4096).fill(0xff));
  assert.equal(dev.chunkMap.has(1), true);
  dev.discard(4096, 4096);
  assert.equal(dev.chunkMap.has(1), false);
});

test("Spike C: chunk-size sweep completes", () => {
  const res = runSpikeC();
  assert.equal(res.length, 4);
  assert.ok(res[1].seqReadMBs > 0);
});
