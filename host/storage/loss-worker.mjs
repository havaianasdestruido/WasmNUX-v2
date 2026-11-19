import {BlockDevice} from './opfs.mjs';
import {serveWorker} from '../worker-rpc.mjs';
serveWorker(async ({mode}) => {
  const root = await navigator.storage.getDirectory();
  const request = mode === 'seed';
  let folder;
  try { folder = await root.getDirectoryHandle('phase-zero-origin-loss', {create:request}); }
  catch (error) { if (mode === 'check' && error.name === 'NotFoundError') return {present:false}; throw error; }
  const disk = new BlockDevice(folder, 4*1024*1024, 4*1024*1024);
  try {
    if (request) {
      await disk.write(0, new Uint8Array(4096).fill(31));
      disk.flush();
      const estimate = await navigator.storage.estimate();
      return {usage:estimate.usage, persisted:await navigator.storage.persisted()};
    }
    if (mode === 'quota') {
      try {
        await disk.write(4096, new Uint8Array(2*1024*1024).fill(7)); disk.flush();
        return {status:'not-induced'};
      } catch (error) {
        if (error.name !== 'QuotaExceededError') throw error;
        const data = new Uint8Array(4096);
        await disk.read(0, data);
        if (!data.every(n => n === 31)) throw new Error('previously flushed control sector changed');
        return {status:'quota-exceeded', previousSectorIntact:true};
      }
    }
    const data = new Uint8Array(4096);
    await disk.read(0, data);
    return {present:data.every(n => n === 31)};
  } finally { disk.close(); }
});
