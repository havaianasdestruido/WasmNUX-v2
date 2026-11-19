/**
 * Node equivalent of an OPFS SyncAccessHandle block device: positional sync I/O
 * on a regular file. Used for the chunk-size sweep when OPFS is unavailable
 * (e.g. in Node CI). The OPFS implementation in opfs-block-device.ts mirrors
 * this contract exactly.
 */
import { openSync, readSync, writeSync, fsyncSync, closeSync, fstatSync, ftruncateSync } from 'node:fs';
import type { BlockDevice } from './block-device.js';

export class NodeFileBlockDevice implements BlockDevice {
  readonly sizeBytes: number;
  private fd: number;
  readonly path: string;

  constructor(path: string, sizeBytes: number, opts?: { create?: boolean }) {
    this.path = path;
    this.sizeBytes = sizeBytes;
    this.fd = openSync(path, opts?.create === false ? 'r+' : 'w+');
    ftruncateSync(this.fd, sizeBytes);
  }

  readAt(offset: number, length: number): Uint8Array {
    const buf = new Uint8Array(length);
    let read = 0;
    while (read < length) {
      const n = readSync(this.fd, buf, read, length - read, offset + read);
      if (n <= 0) throw new Error(`short read at ${offset + read}`);
      read += n;
    }
    return buf;
  }

  writeAt(offset: number, data: Uint8Array): void {
    let written = 0;
    while (written < data.length) {
      const n = writeSync(this.fd, data, written, data.length - written, offset + written);
      if (n <= 0) throw new Error(`short write at ${offset + written}`);
      written += n;
    }
  }

  flush(): void { fsyncSync(this.fd); }
  close(): void { closeSync(this.fd); }
  actualSize(): number { return fstatSync(this.fd).size; }
}
