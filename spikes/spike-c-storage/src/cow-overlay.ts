/**
 * Copy-on-write overlay block device (Spike C).
 *
 * Layout on the writable backing device:
 *   [ meta slot A (64 KiB) | meta slot B (64 KiB) | chunk slots, slot i = logical chunk i ]
 *
 * Every commit writes the chunk data first, flushes, then rewrites the metadata
 * sector to the inactive slot (ping-pong A/B with a monotonically increasing
 * sequence and a CRC-32 footer). A torn metadata sector is detected by its CRC
 * and the previous sector is used instead — the classic A/B superblock pattern,
 * which doubles as the journal for "data before metadata" ordering.
 *
 * Discard marks a chunk as sparse-zero without copying anything.
 *
 * Limitations (spike scope): the whole map lives in one metadata sector, so
 * chunkCount is bounded by the sector size; production layout needs a B-tree or
 * an extent journal (Phase 2). Crc verification on read is opt-in (`verifyOnRead`).
 */
import { crc32 } from './crc32.js';
import type { BlockDevice } from './block-device.js';

const MAGIC = 0x57434f57; // 'WCOW'
const VERSION = 1;
export const META_SECTOR_BYTES = 64 * 1024;
const HEADER_BYTES = 32;
const RECORD_BYTES = 12; // chunkIndex u32 | flags u8 | pad[3] | crc u32
const MAX_RECORDS = Math.floor((META_SECTOR_BYTES - HEADER_BYTES - 4) / RECORD_BYTES);

const FLAG_PRESENT = 1;
const FLAG_DISCARD = 2;

export interface CowStats {
  chunksPresent: number;
  chunksDiscarded: number;
  chunksUnwritten: number;
  bytesCopied: number;
}

interface MapEntry { state: 'present' | 'discard'; crc: number }

export class CowOverlayDevice {
  readonly chunkSize: number;
  readonly chunkCount: number;
  private readonly base: BlockDevice;
  private readonly overlay: BlockDevice;
  private map = new Map<number, MapEntry>();
  private seq = 0n;
  verifyOnRead = false;

  private constructor(base: BlockDevice, overlay: BlockDevice, chunkSize: number, chunkCount: number) {
    this.base = base;
    this.overlay = overlay;
    this.chunkSize = chunkSize;
    this.chunkCount = chunkCount;
  }

  /** Open an existing overlay, or initialize an empty one when `init` is set. */
  static open(base: BlockDevice, overlay: BlockDevice, opts: { chunkSize: number; init?: boolean; allowEmptyFallback?: boolean }): CowOverlayDevice {
    const chunkCount = Math.ceil(base.sizeBytes / opts.chunkSize);
    if (chunkCount > MAX_RECORDS) {
      throw new Error(`too many chunks for one metadata sector (${chunkCount} > ${MAX_RECORDS}); raise chunkSize`);
    }
    const dev = new CowOverlayDevice(base, overlay, opts.chunkSize, chunkCount);
    const a = dev.readMetaSlot(0);
    const b = dev.readMetaSlot(1);
    if (a && b) {
      const latest = a.seq >= b.seq ? a : b;
      dev.map = latest.map; dev.seq = latest.seq;
    } else if (a || b) {
      const valid = (a ?? b)!;
      dev.map = valid.map; dev.seq = valid.seq;
    } else if (opts.init) {
      dev.seq = 0n;
      dev.commitMeta();
    } else if (opts.allowEmptyFallback) {
      dev.map = new Map(); dev.seq = 0n;
    } else {
      throw new Error('both metadata slots are corrupt; refusing to mount (pass allowEmptyFallback to start empty)');
    }
    return dev;
  }

  private metaSlotOffset(slot: number): number { return slot * META_SECTOR_BYTES; }
  private dataOffset(chunkIndex: number): number { return 2 * META_SECTOR_BYTES + chunkIndex * this.chunkSize; }

  private readMetaSlot(slot: number): { seq: bigint; map: Map<number, MapEntry> } | null {
    const raw = this.overlay.readAt(this.metaSlotOffset(slot), META_SECTOR_BYTES);
    const dv = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
    if (dv.getUint32(0, true) !== MAGIC) return null;
    if (dv.getUint32(4, true) !== VERSION) return null;
    const footer = crc32(raw.subarray(0, META_SECTOR_BYTES - 4));
    if (footer !== dv.getUint32(META_SECTOR_BYTES - 4, true)) return null;
    const seq = dv.getBigUint64(8, true);
    const chunkSize = dv.getUint32(16, true);
    const chunkCount = dv.getUint32(20, true);
    const recordCount = dv.getUint32(24, true);
    if (chunkSize !== this.chunkSize || chunkCount !== this.chunkCount) return null; // config mismatch
    if (recordCount > MAX_RECORDS) return null;
    const map = new Map<number, MapEntry>();
    let off = HEADER_BYTES;
    for (let i = 0; i < recordCount; i++) {
      const chunkIndex = dv.getUint32(off, true);
      const flags = dv.getUint8(off + 4);
      const crc = dv.getUint32(off + 8, true);
      if (chunkIndex >= this.chunkCount) return null;
      map.set(chunkIndex, { state: flags === FLAG_DISCARD ? 'discard' : 'present', crc });
      off += RECORD_BYTES;
    }
    return { seq, map };
  }

  private commitMeta(): void {
    const slot = Number(this.seq % 2n);
    const sector = new Uint8Array(META_SECTOR_BYTES);
    const dv = new DataView(sector.buffer);
    dv.setUint32(0, MAGIC, true);
    dv.setUint32(4, VERSION, true);
    dv.setBigUint64(8, this.seq, true);
    dv.setUint32(16, this.chunkSize, true);
    dv.setUint32(20, this.chunkCount, true);
    dv.setUint32(24, this.map.size, true);
    let off = HEADER_BYTES;
    for (const [chunkIndex, entry] of this.map) {
      dv.setUint32(off, chunkIndex, true);
      dv.setUint8(off + 4, entry.state === 'discard' ? FLAG_DISCARD : FLAG_PRESENT);
      dv.setUint8(off + 5, 0); dv.setUint8(off + 6, 0); dv.setUint8(off + 7, 0);
      dv.setUint32(off + 8, entry.crc >>> 0, true);
      off += RECORD_BYTES;
    }
    dv.setUint32(META_SECTOR_BYTES - 4, crc32(sector.subarray(0, META_SECTOR_BYTES - 4)), true);
    this.overlay.writeAt(this.metaSlotOffset(slot), sector);
    this.overlay.flush();
  }

  read(offset: number, length: number): Uint8Array {
    const out = new Uint8Array(length);
    let remaining = length;
    let cursor = offset;
    let outOff = 0;
    while (remaining > 0) {
      const chunkIndex = Math.floor(cursor / this.chunkSize);
      const inChunk = cursor - chunkIndex * this.chunkSize;
      const take = Math.min(remaining, this.chunkSize - inChunk);
      const entry = this.map.get(chunkIndex);
      if (entry?.state === 'discard') {
        out.fill(0, outOff, outOff + take);
      } else if (entry) {
        const chunkData = this.overlay.readAt(this.dataOffset(chunkIndex), this.chunkSize);
        if (this.verifyOnRead && crc32(chunkData) !== entry.crc) {
          throw new Error(`overlay chunk ${chunkIndex} failed CRC verification (bit rot?)`);
        }
        out.set(chunkData.subarray(inChunk, inChunk + take), outOff);
      } else {
        const baseEnd = Math.min(this.base.sizeBytes, (chunkIndex + 1) * this.chunkSize);
        if (cursor >= this.base.sizeBytes) {
          out.fill(0, outOff, outOff + take);
        } else {
          const data = this.base.readAt(cursor, Math.min(take, baseEnd - cursor));
          out.set(data, outOff);
        }
      }
      cursor += take;
      remaining -= take;
      outOff += take;
    }
    return out;
  }

  write(offset: number, data: Uint8Array): void {
    let remaining = data.length;
    let cursor = offset;
    let dataOff = 0;
    while (remaining > 0) {
      const chunkIndex = Math.floor(cursor / this.chunkSize);
      if (chunkIndex >= this.chunkCount) throw new RangeError('write past end of overlay');
      const inChunk = cursor - chunkIndex * this.chunkSize;
      const take = Math.min(remaining, this.chunkSize - inChunk);
      const entry = this.map.get(chunkIndex);
      const fullChunk = inChunk === 0 && take === this.chunkSize;
      // Read-modify-write for partial chunks (unless already present).
      let chunkData: Uint8Array;
      if (fullChunk) {
        chunkData = data.subarray(dataOff, dataOff + take);
      } else if (entry?.state === 'present') {
        chunkData = this.overlay.readAt(this.dataOffset(chunkIndex), this.chunkSize);
        chunkData.set(data.subarray(dataOff, dataOff + take), inChunk);
      } else if (entry?.state === 'discard') {
        chunkData = new Uint8Array(this.chunkSize);
        chunkData.set(data.subarray(dataOff, dataOff + take), inChunk);
      } else {
        chunkData = new Uint8Array(this.chunkSize);
        // source: base image (or zeros beyond base end)
        if (cursor - inChunk < this.base.sizeBytes) {
          const baseLen = Math.min(this.chunkSize, this.base.sizeBytes - (cursor - inChunk));
          const src = this.base.readAt(cursor - inChunk, baseLen);
          chunkData.set(src, 0);
        }
        chunkData.set(data.subarray(dataOff, dataOff + take), inChunk);
      }
      this.overlay.writeAt(this.dataOffset(chunkIndex), chunkData);
      this.overlay.flush();
      this.map.set(chunkIndex, { state: 'present', crc: crc32(chunkData) });
      this.seq += 1n;
      this.commitMeta(); // per-chunk atomic commit; amortize in production with group commit
      cursor += take;
      remaining -= take;
      dataOff += take;
    }
  }

  discard(offset: number, length: number): void {
    let remaining = length;
    let cursor = offset;
    while (remaining > 0) {
      const chunkIndex = Math.floor(cursor / this.chunkSize);
      const take = Math.min(remaining, this.chunkSize - (cursor - chunkIndex * this.chunkSize));
      // Only discard whole chunks; partial discards are RMW-zeroed by write().
      if (take === this.chunkSize) {
        this.map.set(chunkIndex, { state: 'discard', crc: 0 });
        this.seq += 1n;
        this.commitMeta();
      } else {
        this.write(cursor, new Uint8Array(take));
      }
      cursor += take;
      remaining -= take;
    }
  }

  /** scrub: verify CRC of every present chunk; returns corrupt chunk indices. */
  scrub(): number[] {
    const bad: number[] = [];
    for (const [chunkIndex, entry] of this.map) {
      if (entry.state !== 'present') continue;
      const data = this.overlay.readAt(this.dataOffset(chunkIndex), this.chunkSize);
      if (crc32(data) !== entry.crc) bad.push(chunkIndex);
    }
    return bad;
  }

  stats(): CowStats {
    let present = 0, discarded = 0;
    for (const e of this.map.values()) (e.state === 'present' ? present++ : discarded++);
    return {
      chunksPresent: present,
      chunksDiscarded: discarded,
      chunksUnwritten: this.chunkCount - this.map.size,
      bytesCopied: present * this.chunkSize,
    };
  }

  get sequence(): bigint { return this.seq; }
}
