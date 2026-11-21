import { MAX_SNAPSHOT_BYTES, SnapshotStore, openOpfsSnapshot } from './snapshot.ts';

export const SECTOR_BYTES = 512;
export const MAX_DISK_SECTORS = MAX_SNAPSHOT_BYTES / SECTOR_BYTES - 1;
const MAGIC = new TextEncoder().encode('WNXBLK01');

function sectorCount(count: number): void {
  if (!Number.isSafeInteger(count) || count < 1 || count > MAX_DISK_SECTORS)
    throw new RangeError('invalid disk sector count');
}
function validate(image: Uint8Array, expected: number): void {
  if (image.length !== (expected + 1) * SECTOR_BYTES || !MAGIC.every((byte, i) => image[i] === byte))
    throw new Error('invalid disk image or geometry mismatch');
  const header = new DataView(image.buffer, image.byteOffset, SECTOR_BYTES);
  if (
    header.getUint32(8, true) !== expected ||
    header.getUint32(12, true) !== SECTOR_BYTES ||
    image.subarray(16, SECTOR_BYTES).some((byte) => byte !== 0)
  )
    throw new Error('invalid disk header');
}

/** Small persistent sector device. Atomic whole-image transactions, not sparse COW or virtio-blk. */
export class SnapshotBlockDevice {
  private constructor(
    private readonly store: SnapshotStore,
    readonly sectors: number,
  ) {}

  /** Explicit creation never overwrites a nonempty existing image. */
  static async create(store: SnapshotStore, sectors: number): Promise<SnapshotBlockDevice> {
    sectorCount(sectors);
    await store.update((previous) => {
      if (previous.length !== 0) throw new Error('disk already exists');
      const image = new Uint8Array((sectors + 1) * SECTOR_BYTES);
      image.set(MAGIC);
      const view = new DataView(image.buffer);
      view.setUint32(8, sectors, true);
      view.setUint32(12, SECTOR_BYTES, true);
      return image;
    });
    return new SnapshotBlockDevice(store, sectors);
  }
  static async open(store: SnapshotStore, sectors: number): Promise<SnapshotBlockDevice> {
    sectorCount(sectors);
    validate(await store.read(), sectors);
    return new SnapshotBlockDevice(store, sectors);
  }
  private range(sector: number, count: number): number {
    if (
      !Number.isSafeInteger(sector) ||
      !Number.isSafeInteger(count) ||
      sector < 0 ||
      count < 0 ||
      sector > this.sectors ||
      count > this.sectors - sector
    )
      throw new RangeError('sector range outside disk');
    return (sector + 1) * SECTOR_BYTES;
  }
  async read(sector: number, count: number): Promise<Uint8Array<ArrayBuffer>> {
    const offset = this.range(sector, count);
    const image = await this.store.read();
    validate(image, this.sectors);
    return image.slice(offset, offset + count * SECTOR_BYTES);
  }
  async write(sector: number, data: Uint8Array): Promise<void> {
    if (data.length % SECTOR_BYTES !== 0) throw new RangeError('write must contain whole sectors');
    const offset = this.range(sector, data.length / SECTOR_BYTES);
    // Ownership is taken synchronously; update serializes read-modify-write, not only publication.
    const bytes = new Uint8Array(data);
    await this.store.update((image) => {
      validate(image, this.sectors);
      image.set(bytes, offset);
      return image;
    });
  }
  async discard(sector: number, count: number): Promise<void> {
    const offset = this.range(sector, count);
    await this.store.update((image) => {
      validate(image, this.sectors);
      image.fill(0, offset, offset + count * SECTOR_BYTES);
      return image;
    });
  }
}

/** Caller must explicitly choose create or open; corrupt/existing images are never reset implicitly. */
export async function openOpfsBlockDevice(name: string, sectors: number, create = false) {
  sectorCount(sectors);
  if (!/^[a-zA-Z0-9_-]{1,59}$/.test(name)) throw new RangeError('invalid disk name');
  const store = await openOpfsSnapshot(`disk-${name}`);
  return create ? SnapshotBlockDevice.create(store, sectors) : SnapshotBlockDevice.open(store, sectors);
}
