// OPFS SyncAccessHandle-compatible COW block device for Spike C
// Works with browser FileSystemSyncAccessHandle or a Node/in-memory handle.

export class MemorySyncAccessHandle {
  constructor(initialSize = 0) {
    this.buf = new Uint8Array(initialSize);
  }
  getSize() {
    return this.buf.byteLength;
  }
  truncate(newSize) {
    const next = new Uint8Array(newSize);
    next.set(this.buf.subarray(0, Math.min(this.buf.byteLength, newSize)));
    this.buf = next;
  }
  read(target, { at = 0 } = {}) {
    const len = Math.min(target.byteLength, Math.max(0, this.buf.byteLength - at));
    target.set(this.buf.subarray(at, at + len));
    return len;
  }
  write(source, { at = 0 } = {}) {
    if (at + source.byteLength > this.buf.byteLength) {
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
    this.nextOverlayOffset = 0;
    this.dirtyChunks = new Set();
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
        const ovOff = this.nextOverlayOffset;
        this.nextOverlayOffset += this.chunkSize;
        this.overlay.write(chunkBuf, { at: ovOff });
        this.chunkMap.set(chunkIdx, ovOff);
      }

      const ovOff = this.chunkMap.get(chunkIdx) + inChunk;
      this.overlay.write(data.subarray(pos, pos + toWrite), { at: ovOff });
      this.dirtyChunks.add(chunkIdx);
      pos += toWrite;
    }
  }

  discard(offset, length) {
    // TRIM: free whole chunks that fall completely within [offset, offset + length)
    const startChunk = Math.ceil(offset / this.chunkSize);
    const endChunk = Math.floor((offset + length) / this.chunkSize);
    for (let c = startChunk; c < endChunk; c++) {
      this.chunkMap.delete(c);
      this.dirtyChunks.delete(c);
    }
  }

  flush() {
    this.overlay.flush();
    this.dirtyChunks.clear();
  }
}
