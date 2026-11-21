import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  MAX_SNAPSHOT_BYTES,
  openOpfsSnapshot,
  SnapshotStore,
  type SnapshotFile,
  type Exclusive,
} from '../src/storage/snapshot.ts';

function fixture(fail = '') {
  let committed = new Uint8Array([1, 2, 3]);
  let aborts = 0;
  const file: SnapshotFile = {
    async getFile() {
      const copy = committed.slice();
      return { size: copy.length, arrayBuffer: async () => copy.buffer };
    },
    async createWritable() {
      if (fail === 'open') throw new Error(fail);
      let staged = new Uint8Array();
      return {
        async write(bytes) {
          staged = bytes.slice();
          if (fail === 'write') throw new Error(fail);
        },
        async close() {
          if (fail === 'close') throw new Error(fail);
          committed = staged;
        },
        async abort() {
          aborts++;
        },
      };
    },
  };
  let tail: Promise<unknown> = Promise.resolve();
  const exclusive: Exclusive = (action) => {
    const result = tail.then(action);
    tail = result.catch(() => {});
    return result;
  };
  return { store: new SnapshotStore(file, exclusive, 32), file, exclusive, aborts: () => aborts };
}

describe('snapshot transaction', () => {
  for (const stage of ['open', 'write', 'close']) {
    it(`preserves confirmed bytes after ${stage} failure and reopen`, async () => {
      const f = fixture(stage);
      await expect(f.store.replace(new Uint8Array([9]))).rejects.toThrow(stage);
      const reopened = new SnapshotStore(f.file, f.exclusive);
      expect(await reopened.read()).toEqual(new Uint8Array([1, 2, 3]));
      expect(f.aborts()).toBe(stage === 'open' ? 0 : 1);
    });
  }
  it('serializes transactions, owns inputs and truncates the old tail', async () => {
    const f = fixture();
    const input = new Uint8Array([4, 5]);
    const first = f.store.replace(input);
    input.fill(99);
    const read = f.store.read();
    const second = f.store.replace(new Uint8Array([6]));
    await first;
    expect(await read).toEqual(new Uint8Array([4, 5]));
    await second;
    expect(await f.store.read()).toEqual(new Uint8Array([6]));
  });
  it('rejects oversize input before touching storage and supports empty snapshots', async () => {
    const f = fixture();
    await expect(f.store.replace(new Uint8Array(33))).rejects.toThrow(/limit/);
    expect(await f.store.read()).toEqual(new Uint8Array([1, 2, 3]));
    await f.store.replace(new Uint8Array());
    expect(await f.store.read()).toHaveLength(0);
  });
  it('checks on-disk size before allocating', async () => {
    let allocated = false;
    const f = fixture();
    f.file.getFile = async () => ({
      size: 33,
      arrayBuffer: async () => {
        allocated = true;
        return new ArrayBuffer(33);
      },
    });
    await expect(f.store.read()).rejects.toThrow(/limit/);
    expect(allocated).toBe(false);
  });
});

describe('snapshot limits and failure recovery', () => {
  it.each([0, -1, 1.5, Infinity, NaN, MAX_SNAPSHOT_BYTES + 1])(
    'rejects an invalid configured limit (%s)',
    (limit) => {
      const { file, exclusive } = fixture();
      expect(() => new SnapshotStore(file, exclusive, limit)).toThrow(RangeError);
    },
  );

  it('accepts an exact-limit subarray and keeps returned bytes independent', async () => {
    const { file, exclusive } = fixture();
    const store = new SnapshotStore(file, exclusive, 2);
    await store.replace(Uint8Array.of(9, 4, 5, 9).subarray(1, 3));
    const read = await store.read();
    expect(read).toEqual(Uint8Array.of(4, 5));
    read.fill(0);
    expect(await store.read()).toEqual(Uint8Array.of(4, 5));
  });

  it('rejects oversized writes without acquiring the lock', async () => {
    const { file, exclusive } = fixture();
    const acquire = vi.fn();
    const store = new SnapshotStore(
      file,
      (action) => {
        acquire();
        return exclusive(action);
      },
      1,
    );
    await expect(store.replace(new Uint8Array(2))).rejects.toThrow(RangeError);
    expect(acquire).not.toHaveBeenCalled();
  });

  it('preserves the original write error when abort also fails and permits the next write', async () => {
    const f = fixture();
    const createWritable = f.file.createWritable.bind(f.file);
    const original = new Error('write failed');
    const close = vi.fn();
    const abort = vi.fn().mockRejectedValueOnce(new Error('abort failed'));
    vi.spyOn(f.file, 'createWritable')
      .mockResolvedValueOnce({
        write: vi.fn().mockRejectedValueOnce(original),
        close,
        abort,
      })
      .mockImplementation(createWritable);

    const failed = f.store.replace(Uint8Array.of(8));
    const afterFailure = f.store.read();
    const recovery = f.store.replace(Uint8Array.of(9));

    await expect(failed).rejects.toBe(original);
    expect(close).not.toHaveBeenCalled();
    expect(abort).toHaveBeenCalledOnce();
    await expect(afterFailure).resolves.toEqual(Uint8Array.of(1, 2, 3));
    await recovery;
    await expect(f.store.read()).resolves.toEqual(Uint8Array.of(9));
  });
});

describe('OPFS snapshot adapter', () => {
  afterEach(() => vi.unstubAllGlobals());

  it.each(['', '.', '../other', 'a/b', 'a b', 'café', 'x'.repeat(65)])(
    'rejects invalid name %j before opening storage',
    async (name) => {
      const getDirectory = vi.fn();
      vi.stubGlobal('navigator', { storage: { getDirectory }, locks: {} });
      await expect(openOpfsSnapshot(name)).rejects.toThrow(RangeError);
      expect(getDirectory).not.toHaveBeenCalled();
    },
  );

  it.each([
    ['OPFS', { locks: {} }],
    ['Web Locks', { storage: { getDirectory: vi.fn() } }],
  ] as const)('rejects when %s is unavailable', async (_feature, navigator) => {
    vi.stubGlobal('navigator', navigator);
    await expect(openOpfsSnapshot('snapshot')).rejects.toThrow('OPFS and Web Locks required');
  });

  it('uses the same lock for reads and writes across handles and isolates distinct names', async () => {
    const firstName = 'A_0-'.repeat(16); // Longest accepted name.
    const secondName = 'B';
    const files = new Map([
      [firstName, fixture().file],
      [secondName, fixture().file],
    ]);
    const getFileHandle = vi.fn(async (name: string) => files.get(name));
    const getDirectoryHandle = vi.fn(async () => ({ getFileHandle }));
    const getDirectory = vi.fn(async () => ({ getDirectoryHandle }));
    const request = vi.fn((name: string, action: () => Promise<unknown>) => action());
    vi.stubGlobal('navigator', { storage: { getDirectory }, locks: { request } });

    const writer = await openOpfsSnapshot(firstName);
    const reader = await openOpfsSnapshot(firstName);
    const other = await openOpfsSnapshot(secondName);
    expect(getDirectoryHandle).toHaveBeenCalledWith('wasmnux-snapshots-v1', { create: true });
    expect(getFileHandle).toHaveBeenCalledWith(firstName, { create: true });
    expect(getFileHandle).toHaveBeenCalledWith(secondName, { create: true });
    await writer.replace(Uint8Array.of(42));
    await expect(reader.read()).resolves.toEqual(Uint8Array.of(42));
    await expect(other.read()).resolves.toEqual(Uint8Array.of(1, 2, 3));
    // The stable namespace must match across releases so existing tabs still coordinate.
    expect(request.mock.calls.map(([name]) => name)).toEqual([
      `wasmnux:snapshot:v1:${firstName}`,
      `wasmnux:snapshot:v1:${firstName}`,
      `wasmnux:snapshot:v1:${secondName}`,
    ]);
  });
});

describe('snapshot admission and update', () => {
  it('bounds pending work before lock acquisition and recovers capacity after rejection', async () => {
    const f = fixture();
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    const store = new SnapshotStore(f.file, async (action) => {
      await barrier;
      return action();
    });
    const queued = Array.from({ length: 4 }, () => store.read());
    await expect(store.read()).rejects.toThrow('queue full');
    await expect(store.replace(new Uint8Array([1]))).rejects.toThrow('queue full');
    release();
    await Promise.all(queued);
    expect(await store.read()).toEqual(new Uint8Array([1, 2, 3]));
  });
  it('releases admission on synchronous lock failure and on callback exceptions', async () => {
    const f = fixture();
    const store = new SnapshotStore(f.file, () => {
      throw new Error('lock failed');
    });
    for (let i = 0; i < 8; i++) await expect(store.read()).rejects.toThrow('lock failed');
    await expect(
      f.store.update(() => {
        throw new Error('transform');
      }),
    ).rejects.toThrow('transform');
    expect(await f.store.read()).toEqual(new Uint8Array([1, 2, 3]));
  });
  it('atomically updates without losing concurrent changes', async () => {
    const f = fixture();
    await Promise.all(
      Array.from({ length: 4 }, () =>
        f.store.update((bytes) => {
          bytes[0] = bytes[0]! + 1;
          return bytes;
        }),
      ),
    );
    expect((await f.store.read())[0]).toBe(5);
    await expect(f.store.update(() => new Uint8Array(33))).rejects.toThrow('result');
    expect((await f.store.read())[0]).toBe(5);
  });
});
