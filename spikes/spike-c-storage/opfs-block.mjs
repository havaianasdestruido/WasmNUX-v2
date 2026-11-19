// OPFS SyncAccessHandle-compatible COW block device for Spike C
// Works with browser FileSystemSyncAccessHandle or a Node/in-memory handle.

const MAGIC = 0x574e5831; // "WNX1"
const HEADER_SIZE = 65536; // 64 KiB metadata header at offset 0

export class MemorySyncAccessHandle {
  constructor(initialSize = 0) {
    this.buf = new Uint8Array(Math.max(initialSize, 4096));
    this.logicalSize = initialSize;
  }
  getSize() {
    return this.logicalSize;
  }
  truncate(newSize) {
    if (newSize > this.buf.byteLength) {
      let cap = this.buf.byteLength || 4096;
      while (cap < newSize) cap *= 2;
      const next = new Uint8Array(cap);
      next.set(this.buf.subarray(0, this.logicalSize));
      this.buf = next;
    }
    this.logicalSize = newSize;
  }
  read(target, { at = 0 } = {}) {
    const len = Math.min(target.byteLength, Math.max(0, this.logicalSize - at));
    target.set(this.buf.subarray(at, at + len));
    return len;
  }
  write(source, { at = 0 } = {}) {
    if (at + source.byteLength > this.logicalSize) {
      this.truncate(at + source.byteLength);
    }
    this.buf.set(source, at);
    return source.byteLength;
  }
  flush() {
    // No-op in memory; in OPFS calls SyncAccessHandle.flush()
  }
}

export class CowBlockDevice {
  constructor(baseImage, overlayHandle, chunkSize = 65536) {
    this.baseImage = baseImage; // Uint8Array (read-only base)
    this.overlay = overlayHandle; // SyncAccessHandle-like
    this.chunkSize = chunkSize;
    this.chunkMap = new Map(); // chunkIdx -> overlayOffset
    this.freeOffsets = []; // freed overlay offsets from TRIM/discard
    this.nextOverlayOffset = HEADER_SIZE;
    this.dirtyMeta = false;

    this._loadMetadata();
  }

  _loadMetadata() {
    if (this.overlay.getSize() < HEADER_SIZE) return;
    const hdr = new Uint8Array(HEADER_SIZE);
    this.overlay.read(hdr, { at: 0 });
    const view = new DataView(hdr.buffer, hdr.byteOffset, hdr.byteLength);
    if (view.getUint32(0, true) !== MAGIC) return;

    this.chunkSize = view.getUint32(4, true);
    this.nextOverlayOffset = view.getFloat64(8, true);
    const count = view.getUint32(16, true);
    let pos = 24;
    for (let i = 0; i < count && pos + 12 <= HEADER_SIZE; i++) {
      const chunkIdx = view.getUint32(pos, true);
      const ovOff = view.getFloat64(pos + 4, true);
      this.chunkMap.set(chunkIdx, ovOff);
      pos += 12;
    }
  }

  _saveMetadata() {
    const hdr = new Uint8Array(HEADER_SIZE);
    const view = new DataView(hdr.buffer, hdr.byteOffset, hdr.byteLength);
    view.setUint32(0, MAGIC, true);
    view.setUint32(4, this.chunkSize, true);
    view.setFloat64(8, this.nextOverlayOffset, true);
    view.setUint32(16, this.chunkMap.size, true);
    let pos = 24;
    for (const [chunkIdx, ovOff] of this.chunkMap.entries()) {
      if (pos + 12 > HEADER_SIZE) break;
      view.setUint32(pos, chunkIdx, true);
      view.setFloat64(pos + 4, ovOff, true);
      pos += 12;
    }
    this.overlay.write(hdr, { at: 0 });
    this.dirtyMeta = false;
  }

  read(offset, length) {
    const out = new Uint8Array(length);
    let pos = 0;
    while (pos < length) {
      const abs = offset + pos;
      const chunkIdx = Math.floor(abs / this.chunkSize);
      const inChunk = abs % this.chunkSize;
      const toRead = Math.min(length - pos, this.chunkSize - inChunk);

      if (this.chunkMap.has(chunkIdx)) {
        const ovOff = this.chunkMap.get(chunkIdx) + inChunk;
        this.overlay.read(out.subarray(pos, pos + toRead), { at: ovOff });
      } else if (abs < this.baseImage.byteLength) {
        const avail = Math.min(toRead, this.baseImage.byteLength - abs);
        out.set(this.baseImage.subarray(abs, abs + avail), pos);
      }
      pos += toRead;
    }
    return out;
  }

  write(offset, data) {
    let pos = 0;
    while (pos < data.byteLength) {
      const abs = offset + pos;
      const chunkIdx = Math.floor(abs / this.chunkSize);
      const inChunk = abs % this.chunkSize;
      const toWrite = Math.min(data.byteLength - pos, this.chunkSize - inChunk);

      if (!this.chunkMap.has(chunkIdx)) {
        // Copy-on-write: materialize chunk from baseImage into overlay
        const chunkBuf = new Uint8Array(this.chunkSize);
        const baseStart = chunkIdx * this.chunkSize;
        if (baseStart < this.baseImage.byteLength) {
          const avail = Math.min(this.chunkSize, this.baseImage.byteLength - baseStart);
          chunkBuf.set(this.baseImage.subarray(baseStart, baseStart + avail));
        }
        const ovOff =
          this.freeOffsets.length > 0 ? this.freeOffsets.pop() : this.nextOverlayOffset;
        if (ovOff === this.nextOverlayOffset) {
          this.nextOverlayOffset += this.chunkSize;
        }
        this.overlay.write(chunkBuf, { at: ovOff });
        this.chunkMap.set(chunkIdx, ovOff);
        this.dirtyMeta = true;
      }

      const ovOff = this.chunkMap.get(chunkIdx) + inChunk;
      this.overlay.write(data.subarray(pos, pos + toWrite), { at: ovOff });
      pos += toWrite;
    }
  }

  discard(offset, length) {
    // TRIM: free whole chunks that fall completely within [offset, offset + length)
    const startChunk = Math.ceil(offset / this.chunkSize);
    const endChunk = Math.floor((offset + length) / this.chunkSize);
    for (let c = startChunk; c < endChunk; c++) {
      if (this.chunkMap.has(c)) {
        this.freeOffsets.push(this.chunkMap.get(c));
        this.chunkMap.delete(c);
        this.dirtyMeta = true;
      }
    }
  }

  flush() {
    if (this.dirtyMeta) {
      this._saveMetadata();
    }
    this.overlay.flush();
  }
}
