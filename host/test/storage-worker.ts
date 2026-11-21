import { openOpfsBlockDevice } from '../src/storage/block.ts';
import { openOpfsSnapshot, SnapshotStore } from '../src/storage/snapshot.ts';
self.onmessage = async (event: MessageEvent<{ name: string; mode: string; value?: number }>) => {
  try {
    const { name, mode, value = 7 } = event.data;
    if (mode === 'disk-write') {
      const disk = await openOpfsBlockDevice(name, 8);
      await disk.write(value, new Uint8Array(512).fill(value + 1));
      self.postMessage({ bytes: Array.from((await disk.read(value, 1)).slice(0, 1)) });
      return;
    }
    const store = await openOpfsSnapshot(name);
    if (mode === 'write') await store.replace(new Uint8Array([value]));
    else if (mode === 'stage') {
      const root = await navigator.storage.getDirectory();
      const dir = await root.getDirectoryHandle('wasmnux-snapshots-v1');
      const file = await dir.getFileHandle(name);
      const stalled = new SnapshotStore(
        {
          getFile: () => file.getFile(),
          createWritable: async () => {
            const stream = await file.createWritable();
            return {
              write: async (data) => {
                await stream.write(data);
                self.postMessage({ staged: true });
                await new Promise(() => {}); // controller terminates this worker before close
              },
              close: () => stream.close(),
              abort: () => stream.abort(),
            };
          },
        },
        async (action) => await navigator.locks.request(`wasmnux:snapshot:v1:${name}`, action),
      );
      await stalled.replace(new Uint8Array([99]));
    }
    self.postMessage({ bytes: Array.from(await store.read()) });
  } catch (error) {
    self.postMessage({ error: String(error) });
  }
};
