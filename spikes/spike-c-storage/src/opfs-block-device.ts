/**
 * OPFS block device (browser path). Mirrors NodeFileBlockDevice but backed by
 * a sync access handle inside a dedicated worker, per the OPFS spec.
 *
 * This module is import-safe in non-browser environments: nothing touches
 * `navigator` until `isAvailable()` / `create()` is called.
 */
export interface OpfsSyncAccessHandle {
  read(buffer: ArrayBufferView, options?: { at?: number }): number;
  write(buffer: ArrayBufferView, options?: { at?: number }): number;
  truncate(newSize: number): void;
  getSize(): number;
  flush(): void;
  close(): void;
}

export interface OpfsFileHandle {
  getFile(): Promise<{ size: number }>;
  createSyncAccessHandle(): Promise<OpfsSyncAccessHandle>;
}

export interface OpfsDirectoryHandle {
  getFileHandle(name: string, options?: { create?: boolean }): Promise<OpfsFileHandle>;
  removeEntry(name: string): Promise<void>;
}

export function opfsAvailable(): boolean {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const nav: any = (globalThis as any).navigator;
    return !!nav?.storage?.getDirectory;
  } catch {
    return false;
  }
}

export class OpfsBlockDevice {
  readonly sizeBytes: number;
  private readonly handle: OpfsSyncAccessHandle;
  private readonly fileHandle: OpfsFileHandle;
  readonly name: string;

  private constructor(handle: OpfsSyncAccessHandle, fileHandle: OpfsFileHandle, sizeBytes: number, name: string) {
    this.handle = handle;
    this.fileHandle = fileHandle;
    this.sizeBytes = sizeBytes;
    this.name = name;
  }

  static async create(name: string, sizeBytes: number): Promise<OpfsBlockDevice> {
    if (!opfsAvailable()) {
      throw new Error('OPFS is not available in this environment (need cross-origin isolated worker with navigator.storage.getDirectory)');
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const root: OpfsDirectoryHandle = await (globalThis as any).navigator.storage.getDirectory();
    const fileHandle = await root.getFileHandle(name, { create: true });
    const handle = await fileHandle.createSyncAccessHandle();
    const current = handle.getSize();
    if (current !== sizeBytes) handle.truncate(sizeBytes);
    handle.flush();
    return new OpfsBlockDevice(handle, fileHandle, sizeBytes, name);
  }

  readAt(offset: number, length: number): Uint8Array {
    const buf = new Uint8Array(length);
    const n = this.handle.read(buf, { at: offset });
    if (n !== length) throw new Error(`short OPFS read: wanted ${length}, got ${n}`);
    return buf;
  }

  writeAt(offset: number, data: Uint8Array): void {
    const n = this.handle.write(data, { at: offset });
    if (n !== data.length) throw new Error(`short OPFS write: wanted ${data.length}, got ${n}`);
  }

  flush(): void { this.handle.flush(); }
  getSize(): number { return this.handle.getSize(); }
  close(): void { this.handle.flush(); this.handle.close(); }
  async remove(): Promise<void> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const root: OpfsDirectoryHandle = await (globalThis as any).navigator.storage.getDirectory();
    await root.removeEntry(this.name);
  }
}
