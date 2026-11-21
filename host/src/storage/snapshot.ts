/** A bounded whole-file transaction, not a virtio disk or a guest fsync implementation. */
export interface SnapshotFile {
  getFile(): Promise<{ size: number; arrayBuffer(): Promise<ArrayBuffer> }>;
  createWritable(): Promise<{
    write(data: Uint8Array<ArrayBuffer>): Promise<void>;
    close(): Promise<void>;
    abort(): Promise<void>;
  }>;
}
export type Exclusive = <T>(action: () => Promise<T>) => Promise<T>;
export const MAX_SNAPSHOT_BYTES = 16 * 1024 * 1024;

export const MAX_PENDING_SNAPSHOTS = 4;

export class SnapshotStore {
  private pending = 0;
  constructor(
    private readonly file: SnapshotFile,
    private readonly exclusive: Exclusive,
    readonly maxBytes = MAX_SNAPSHOT_BYTES,
  ) {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > MAX_SNAPSHOT_BYTES)
      throw new RangeError('invalid snapshot limit');
  }
  /** Bound outstanding calls before copying input or requesting a lock. */
  private admit<T>(work: () => Promise<T>): Promise<T> {
    if (this.pending >= MAX_PENDING_SNAPSHOTS) return Promise.reject(new Error('snapshot queue full'));
    this.pending++;
    try {
      return work().finally(() => {
        this.pending--;
      });
    } catch (error) {
      this.pending--;
      return Promise.reject(error);
    }
  }
  private async readLocked(): Promise<Uint8Array<ArrayBuffer>> {
    const file = await this.file.getFile();
    if (!Number.isSafeInteger(file.size) || file.size < 0 || file.size > this.maxBytes)
      throw new RangeError('snapshot exceeds limit or has invalid size');
    const bytes = new Uint8Array(await file.arrayBuffer());
    if (bytes.length !== file.size) throw new Error('snapshot size changed during read');
    return bytes;
  }
  private async replaceLocked(bytes: Uint8Array<ArrayBuffer>): Promise<void> {
    const stream = await this.file.createWritable();
    try {
      await stream.write(bytes);
      await stream.close();
    } catch (error) {
      try {
        await stream.abort();
      } catch {
        /* Preserve the original error. */
      }
      throw error;
    }
  }
  read(): Promise<Uint8Array<ArrayBuffer>> {
    return this.admit(() => this.exclusive(() => this.readLocked()));
  }
  replace(data: Uint8Array): Promise<void> {
    if (data.byteLength > this.maxBytes) return Promise.reject(new RangeError('snapshot exceeds limit'));
    return this.admit(() => {
      // Own input before the first await, but only after admission.
      const bytes = new Uint8Array(data);
      return this.exclusive(() => this.replaceLocked(bytes));
    });
  }
  /** Atomic read-modify-replace across cooperating contexts. Callback must be synchronous, non-reentrant. */
  update(change: (current: Uint8Array<ArrayBuffer>) => Uint8Array): Promise<void> {
    return this.admit(() =>
      this.exclusive(async () => {
        const result = change(await this.readLocked());
        if (!(result instanceof Uint8Array) || result.byteLength > this.maxBytes)
          throw new RangeError('invalid snapshot update result');
        await this.replaceLocked(new Uint8Array(result));
      }),
    );
  }
}

/** One fixed file per explicitly supplied directory; Web Locks serialize cooperating contexts. */
export async function openOpfsSnapshot(name: string): Promise<SnapshotStore> {
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(name)) throw new RangeError('invalid snapshot name');
  if (!navigator.storage?.getDirectory || !navigator.locks) throw new Error('OPFS and Web Locks required');
  const root = await navigator.storage.getDirectory();
  const directory = await root.getDirectoryHandle('wasmnux-snapshots-v1', { create: true });
  const file = await directory.getFileHandle(name, { create: true });
  return new SnapshotStore(
    file,
    async (action) => await navigator.locks.request(`wasmnux:snapshot:v1:${name}`, action),
  );
}
