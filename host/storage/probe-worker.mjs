import {serveWorker} from '../worker-rpc.mjs';
import {BlockDevice} from './opfs.mjs';
serveWorker(async ({bytes = 8 * 1024**2, randomOps = 2048} = {}) => {
  const root = await navigator.storage.getDirectory();
  const name = `phase-zero-${crypto.randomUUID()}`;
  const dir = await root.getDirectoryHandle(name, {create:true});
  const sweep = [];
  try {
    for (const chunkBytes of [64, 256, 1024, 4096].map(k => k * 1024)) {
      const part = await dir.getDirectoryHandle(String(chunkBytes), {create:true});
      const data = new Uint8Array(bytes), target = new Uint8Array(bytes);
      for (let i = 0; i < bytes; i += 4096) data[i] = ((i >>> 12) % 251) + 1;
      let disk = new BlockDevice(part, bytes, chunkBytes);
      try {
        target.fill(42);
        await disk.read(0, target);
        if (target.some(n => n !== 0)) throw new Error('sparse read is not zero-filled');
        let start = performance.now();
        await disk.write(0, data);
        disk.flush();
        const writeFlushMs = performance.now() - start;
        disk.close();
        disk = new BlockDevice(part, bytes, chunkBytes);
        start = performance.now();
        await disk.read(0, target);
        const reopenReadMs = performance.now() - start;
        if (target.some((value, j) => value !== data[j])) throw new Error('reopen mismatch');
        let seed = 2309;
        const buf = new Uint8Array(4096);
        start = performance.now();
        for (let i = 0; i < randomOps; i++) {
          seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5;
          const offset = (seed >>> 0) % (bytes / 4096) * 4096;
          await disk.read(offset, buf);
          if (buf[0] !== data[offset]) throw new Error('wrong random sector');
        }
        sweep.push({chunkBytes, bytes, randomOps, writeFlushMs, reopenReadMs, randomReadMs:performance.now() - start});
      } finally { disk.close(); }
    }
  } finally { await root.removeEntry(name, {recursive:true}); }
  const estimate = await navigator.storage.estimate();
  const bucket = {available:!!navigator.storageBuckets};
  if (navigator.storageBuckets) {
    // Bucket names cannot contain uppercase characters and must be short.
    const key = name.slice(0, 55);
    try {
      const storage = await navigator.storageBuckets.open(key, {durability:'strict'});
      bucket.requestedDurability = 'strict';
      bucket.reportedDurability = typeof storage.durability === 'function' ? await storage.durability() : storage.durability ?? null;
      bucket.persisted = await storage.persisted();
      const directory = await storage.getDirectory();
      const disk = new BlockDevice(directory, 4096, 4096);
      try {
        await disk.write(0, new Uint8Array(4096).fill(13));
        disk.flush();
      } finally { disk.close(); }
      const reopened = new BlockDevice(await (await navigator.storageBuckets.open(key)).getDirectory(), 4096, 4096);
      try {
        const sector = new Uint8Array(4096);
        await reopened.read(0, sector);
        bucket.reopenVerified = sector.every(n => n === 13);
        if (!bucket.reopenVerified) throw new Error('bucket reopen mismatch');
      } finally { reopened.close(); }
    } catch (e) { bucket.error = String(e); }
    finally { await navigator.storageBuckets.delete(key); }
  }
  return {sweep, estimate, persisted:await navigator.storage.persisted(), bucket, eviction:'not induced by this probe'};
});
