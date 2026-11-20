import { describe, expect, it } from 'vitest';
import { SnapshotStore, type Exclusive, type SnapshotFile } from '../src/storage/snapshot.ts';
import { SnapshotBlockDevice, openOpfsBlockDevice } from '../src/storage/block.ts';

function backend() {
  let bytes = new Uint8Array();
  let fail = false;
  const file: SnapshotFile = {
    async getFile() {
      const copy = bytes.slice();
      return { size: copy.length, arrayBuffer: async () => copy.buffer };
    },
    async createWritable() {
      let staged = new Uint8Array();
      return {
        async write(data) {
          staged = data.slice();
          if (fail) throw new Error('injected write failure');
        },
        async close() {
          bytes = staged;
        },
        async abort() {},
      };
    },
  };
  let tail: Promise<unknown> = Promise.resolve();
  const exclusive: Exclusive = (action) => {
    const next = tail.then(action);
    tail = next.catch(() => {});
    return next;
  };
  return {
    store: () => new SnapshotStore(file, exclusive),
    fail: (on: boolean) => {
      fail = on;
    },
  };
}

describe('transactional sector device', () => {
  it('creates, reopens, writes multiple sectors and discards without affecting neighbours', async () => {
    const b = backend();
    const disk = await SnapshotBlockDevice.create(b.store(), 8);
    const input = new Uint8Array(1024).fill(7);
    const write = disk.write(2, input);
    input.fill(99);
    await write;
    const reopened = await SnapshotBlockDevice.open(b.store(), 8);
    expect(await reopened.read(2, 2)).toEqual(new Uint8Array(1024).fill(7));
    await reopened.discard(2, 1);
    expect(await disk.read(2, 1)).toEqual(new Uint8Array(512));
    expect(await disk.read(3, 1)).toEqual(new Uint8Array(512).fill(7));
  });
  it('serializes read-modify-write across independently opened devices without losing sectors', async () => {
    const b = backend();
    await SnapshotBlockDevice.create(b.store(), 8);
    const disks = await Promise.all(Array.from({ length: 8 }, () => SnapshotBlockDevice.open(b.store(), 8)));
    await Promise.all(disks.map((disk, sector) => disk.write(sector, new Uint8Array(512).fill(sector + 1))));
    for (let i = 0; i < 8; i++) expect(await disks[0]!.read(i, 1)).toEqual(new Uint8Array(512).fill(i + 1));
  });
  it('keeps committed sectors after a failed transaction and permits retry', async () => {
    const b = backend();
    const disk = await SnapshotBlockDevice.create(b.store(), 8);
    await disk.write(0, new Uint8Array(512).fill(1));
    b.fail(true);
    await expect(disk.write(0, new Uint8Array(512).fill(2))).rejects.toThrow('injected');
    expect(await (await SnapshotBlockDevice.open(b.store(), 8)).read(0, 1)).toEqual(
      new Uint8Array(512).fill(1),
    );
    b.fail(false);
    await disk.write(0, new Uint8Array(512).fill(3));
    expect(await disk.read(0, 1)).toEqual(new Uint8Array(512).fill(3));
  });
  it('never overwrites an existing image or silently recreates a corrupt one', async () => {
    const b = backend();
    const store = b.store();
    await SnapshotBlockDevice.create(store, 8);
    await expect(SnapshotBlockDevice.create(store, 8)).rejects.toThrow('exists');
    await expect(SnapshotBlockDevice.open(store, 7)).rejects.toThrow('geometry');
    await store.update((image) => {
      image[16] = 1;
      return image;
    });
    await expect(SnapshotBlockDevice.open(store, 8)).rejects.toThrow('header');
  });
  it('rejects invalid OPFS disk names before requesting storage', async () => {
    for (const name of ['', '../escape', 'a'.repeat(60)])
      await expect(openOpfsBlockDevice(name, 8)).rejects.toThrow('name');
  });
  it('rejects malformed geometry, out-of-range and partial-sector I/O', async () => {
    const b = backend();
    for (const count of [0, -1, 1.5, Infinity, 32768])
      await expect(SnapshotBlockDevice.create(b.store(), count)).rejects.toThrow();
    const disk = await SnapshotBlockDevice.create(b.store(), 8);
    for (const [sector, count] of [
      [-1, 1],
      [8, 1],
      [7, 2],
      [0, Infinity],
      [0, -1],
      [0.5, 1],
    ]) {
      await expect(disk.read(sector!, count!)).rejects.toThrow(RangeError);
      await expect(disk.discard(sector!, count!)).rejects.toThrow(RangeError);
    }
    await expect(disk.write(0, new Uint8Array(513))).rejects.toThrow();
    expect(await disk.read(8, 0)).toHaveLength(0);
  });
});
