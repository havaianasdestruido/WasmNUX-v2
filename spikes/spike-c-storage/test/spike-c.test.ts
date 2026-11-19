import { test } from 'node:test';
import assert from 'node:assert/strict';
import { InMemoryBlockDevice } from '../src/block-device.js';
import { CowOverlayDevice, META_SECTOR_BYTES } from '../src/cow-overlay.js';
import { probeDurability } from '../src/durability.js';

function makeBase(bytes = 256 * 1024): InMemoryBlockDevice {
  const dev = new InMemoryBlockDevice(bytes);
  const pattern = new Uint8Array(bytes);
  for (let i = 0; i < bytes; i++) pattern[i] = (i * 2654435761 >>> 0) & 0xff;
  dev.writeAt(0, pattern);
  return dev;
}

function makeOverlay(size = 8 * 1024 * 1024): InMemoryBlockDevice {
  return new InMemoryBlockDevice(size);
}

test('COW: reads come from base until written; base is never modified', () => {
  const base = makeBase();
  const baseSnapshot = base.bytes.slice();
  const overlay = makeOverlay();
  const cow = CowOverlayDevice.open(base, overlay, { chunkSize: 4096, init: true });
  // read-through
  const before = cow.read(100, 1000);
  assert.deepEqual([...before], [...baseSnapshot.subarray(100, 1100)]);
  // partial write
  const patch = new Uint8Array(100).fill(0xee);
  cow.write(100, patch);
  const after = cow.read(100, 100);
  assert.deepEqual([...after], [...patch]);
  assert.deepEqual([...base.bytes], [...baseSnapshot], 'base modified!');
});

test('COW: whole-chunk write then read-back matches', () => {
  const base = makeBase();
  const cow = CowOverlayDevice.open(base, makeOverlay(), { chunkSize: 4096, init: true });
  const chunk = new Uint8Array(4096).map((_, i) => (i * 7 + 13) & 0xff);
  cow.write(4096 * 3, chunk);
  assert.deepEqual([...cow.read(4096 * 3, 4096)], [...chunk]);
  assert.equal(cow.stats().chunksPresent, 1);
});

test('COW: discard yields zeros and survives remount', () => {
  const base = makeBase();
  const overlay = makeOverlay();
  const cow = CowOverlayDevice.open(base, overlay, { chunkSize: 4096, init: true });
  cow.discard(4096 * 2, 4096);
  assert.deepEqual([...cow.read(4096 * 2, 4096)], [...new Uint8Array(4096)]);
  const cow2 = CowOverlayDevice.open(base, overlay, { chunkSize: 4096 });
  assert.deepEqual([...cow2.read(4096 * 2, 4096)], [...new Uint8Array(4096)]);
});

test('COW: crash mid meta-commit; older slot still mounts with prior state', () => {
  const base = makeBase();
  const overlay = makeOverlay();
  const cow = CowOverlayDevice.open(base, overlay, { chunkSize: 4096, init: true });
  cow.write(0, new Uint8Array(4096).fill(0x11));
  const snapshotBeforeSecondWrite = overlay.bytes.slice();
  cow.write(4096, new Uint8Array(4096).fill(0x22));
  // Corrupt the newest metadata slot (simulate torn sector)
  const newestSlot = Number(cow.sequence % 2n); // slot used by last commit
  const off = newestSlot * META_SECTOR_BYTES;
  for (let i = 0; i < 16; i++) overlay.bytes[off + i] ^= 0xff;
  const recovered = CowOverlayDevice.open(base, overlay, { chunkSize: 4096, init: false });
  const seen0 = recovered.read(0, 4096);
  // chunk 0 was committed before chunk 1; the older meta slot may or may not know chunk 1,
  // but must never show corrupt data as valid
  assert.deepEqual([...seen0], [...new Uint8Array(4096).fill(0x11)]);
  void snapshotBeforeSecondWrite;
});

test('COW: both meta slots corrupt -> mount refused unless allowEmptyFallback', () => {
  const base = makeBase();
  const overlay = makeOverlay();
  const cow = CowOverlayDevice.open(base, overlay, { chunkSize: 4096, init: true });
  cow.write(0, new Uint8Array(4096).fill(0x33));
  overlay.bytes.fill(0, 0, 2 * META_SECTOR_BYTES); // destroy both sectors
  assert.throws(() => CowOverlayDevice.open(base, overlay, { chunkSize: 4096 }), /corrupt/);
  const fallback = CowOverlayDevice.open(base, overlay, { chunkSize: 4096, allowEmptyFallback: true });
  assert.deepEqual([...fallback.read(0, 16)], [...base.bytes.subarray(0, 16)]);
});

test('COW: scrub detects bit rot in present chunks', () => {
  const base = makeBase();
  const overlay = makeOverlay();
  const cow = CowOverlayDevice.open(base, overlay, { chunkSize: 4096, init: true });
  cow.write(8192, new Uint8Array(4096).fill(0x42));
  const dataOff = 2 * META_SECTOR_BYTES + 2 * 4096;
  overlay.bytes[dataOff + 100] ^= 0x01; // bit rot
  const bad = cow.scrub();
  assert.deepEqual(bad, [2]);
});

test('COW: partial write preserves untouched bytes of the chunk', () => {
  const base = makeBase();
  const overlay = makeOverlay();
  const cow = CowOverlayDevice.open(base, overlay, { chunkSize: 4096, init: true });
  const before = cow.read(0, 4096);
  cow.write(10, new Uint8Array([1, 2, 3, 4]));
  const after = cow.read(0, 4096);
  assert.equal(after[0], before[0]);
  assert.deepEqual([...after.subarray(10, 14)], [1, 2, 3, 4]);
  assert.equal(after[4095], before[4095]);
});

test('durability probe: returns a structured report without crashing in Node', async () => {
  const report = await probeDurability();
  assert.equal(typeof report.opfsAvailable, 'boolean');
  assert.ok(Array.isArray(report.recommendations));
  assert.ok(report.recommendations.length >= 1);
});
