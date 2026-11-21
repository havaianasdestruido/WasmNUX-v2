import { openOpfsBlockDevice } from '../src/storage/block.ts';
import { runBrowserSmp } from '../src/smp.ts';
import { openOpfsSnapshot, SnapshotStore } from '../src/storage/snapshot.ts';
import { amoCounterProgram, lrscLockProgram, SMP_DATA } from '../../core/src/smp/programs.ts';
import { assemble } from '../../core/src/cpu/asm.ts';

function check(ok: boolean, message: string): asserts ok {
  if (!ok) throw new Error(message);
}
async function storageWorker(name: string, mode: string, value?: number) {
  const worker = new Worker('/storage-worker.js', { type: 'module' });
  try {
    return await new Promise<{ bytes?: number[]; staged?: boolean }>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('storage worker timeout')), 10_000);
      worker.onmessage = (event) => {
        clearTimeout(timer);
        if (event.data.error) reject(new Error(event.data.error));
        else resolve(event.data);
      };
      worker.onerror = (event) => {
        clearTimeout(timer);
        reject(new Error(event.message));
      };
      worker.postMessage({ name, mode, value });
    });
  } finally {
    worker.terminate();
  }
}
export async function browserChecks() {
  const name = `test-${crypto.randomUUID()}`;
  const store = await openOpfsSnapshot(name);
  try {
    await store.replace(new Uint8Array([42, 43]));
    check((await storageWorker(name, 'read')).bytes?.join() === '42,43', 'worker reopen');
    check((await storageWorker(name, 'stage')).staged === true, 'staged data');
    check((await store.read()).join() === '42,43', 'terminated writer destroyed committed snapshot');
    check((await storageWorker(name, 'write', 8)).bytes?.join() === '8', 'recovery writer');
    // Concurrent contexts must publish whole snapshots, never mixtures or stale tails.
    await Promise.all(Array.from({ length: 8 }, (_, i) => storageWorker(name, 'write', i)));
    const final = await store.read();
    check(final.length === 1 && final[0]! < 8, 'concurrent snapshot publication');
    const disk = await openOpfsBlockDevice(name, 8, true);
    await Promise.all(Array.from({ length: 8 }, (_, i) => storageWorker(name, 'disk-write', i)));
    for (let i = 0; i < 8; i++)
      check(
        (await disk.read(i, 1)).every((byte) => byte === i + 1),
        'lost concurrent disk sector',
      );
    check((await storageWorker(`disk-${name}`, 'stage')).staged === true, 'staged disk overwrite');
    const reopened = await openOpfsBlockDevice(name, 8);
    for (let i = 0; i < 8; i++)
      check(
        (await reopened.read(i, 1)).every((byte) => byte === i + 1),
        'worker termination damaged disk',
      );
    await reopened.discard(3, 2);
    check(
      (await disk.read(3, 2)).every((byte) => byte === 0),
      'disk discard',
    );
    check(
      (await disk.read(2, 1)).every((byte) => byte === 3),
      'disk discard touched neighbour',
    );
    const root = await navigator.storage.getDirectory();
    const dir = await root.getDirectoryHandle('wasmnux-snapshots-v1');
    const file = await dir.getFileHandle(name);
    for (const point of ['open', 'write', 'close']) {
      await store.replace(new Uint8Array([42, 43]));
      const fault = new SnapshotStore(
        {
          getFile: () => file.getFile(),
          createWritable: async () => {
            if (point === 'open') throw new Error('injected');
            const stream = await file.createWritable();
            return {
              write: async (bytes) => {
                await stream.write(bytes);
                if (point === 'write') throw new Error('injected');
              },
              close: async () => {
                throw new Error('injected');
              },
              abort: () => stream.abort(),
            };
          },
        },
        async (action) => await navigator.locks.request(`wasmnux:snapshot:v1:${name}`, action),
      );
      let failed = false;
      try {
        await fault.replace(new Uint8Array([99]));
      } catch {
        failed = true;
      }
      check(failed && (await store.read()).join() === '42,43', `OPFS fault ${point}`);
    }
  } finally {
    const root = await navigator.storage.getDirectory();
    const dir = await root.getDirectoryHandle('wasmnux-snapshots-v1');
    await dir.removeEntry(name);
    await dir.removeEntry(`disk-${name}`).catch((error: DOMException) => {
      if (error.name !== 'NotFoundError') throw error;
    });
  }
  const workerUrl = new URL('/hart.js', location.href);
  const opts = {
    harts: 4,
    entry: 0x80000000,
    stackTop: 0x80010000,
    ramBytes: 65536,
    budget: 50_000_000,
    timeoutMs: 30_000,
  };
  for (let repeat = 0; repeat < 3; repeat++) {
    for (const [program, address] of [
      [amoCounterProgram(1000).bytes, SMP_DATA.counter],
      [lrscLockProgram(1000).bytes, SMP_DATA.cell],
    ] as const) {
      const run = await runBrowserSmp({ ...opts, program }, workerUrl);
      check(
        run.harts.every((h) => h.stop === 'exit'),
        'all harts exit',
      );
      check(
        new Int32Array(run.memory.buffer)[(address - opts.entry) / 4] === 4000,
        'lost concurrent increment',
      );
      check(new Int32Array(run.memory.buffer)[(SMP_DATA.lock - opts.entry) / 4] === 0, 'lock left held');
    }
  }
  for (const invalid of [
    { entry: 0x180000000 },
    { ramBase: 0x80000001, entry: 0x80000004 },
    { ramBytes: 65537 },
    { stackTop: 0x180010000 },
    { harts: 17 },
    { budget: Infinity },
    { timeoutMs: 0 },
  ]) {
    let rejected = false;
    try {
      await runBrowserSmp({ ...opts, program: amoCounterProgram(1).bytes, ...invalid }, workerUrl);
    } catch (error) {
      rejected = error instanceof RangeError;
    }
    check(rejected, 'invalid browser SMP input accepted');
  }
  // A loader error in one worker must reject and terminate the whole group.
  let loadFailed = false;
  try {
    await runBrowserSmp({ ...opts, program: new Uint8Array(65536), entry: opts.entry + 4 }, workerUrl);
  } catch (error) {
    loadFailed = String(error).includes('does not fit');
  }
  check(loadFailed, 'worker error propagation');
  const infinite = assemble('loop: j loop', { base: opts.entry }).bytes;
  let timedOut = false;
  try {
    await runBrowserSmp(
      { ...opts, program: infinite, budget: Number.MAX_SAFE_INTEGER, timeoutMs: 50 },
      workerUrl,
    );
  } catch (error) {
    timedOut = String(error).includes('timed out');
  }
  check(timedOut, 'worker timeout');
  return 'OPFS snapshots + sector device: reopen, abort, worker termination, concurrent writers; SMP 3x4 harts x1000 AMO/LRSC and timeout passed';
}
