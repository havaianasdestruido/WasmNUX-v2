const sector = 4096;
export class BlockDevice {
  #directory; #chunk; #size; #handles = new Map(); #closed = false;
  constructor(directory, size, chunk) {
    if (![size, chunk].every(n => Number.isSafeInteger(n) && n >= sector && n % sector === 0) || size % chunk) {
      throw new RangeError('size and chunk must be sector multiples; chunk must divide size');
    }
    this.#directory = directory; this.#size = size; this.#chunk = chunk;
  }
  async #handle(index, write) {
    if (this.#closed) throw new Error('device closed');
    if (!this.#handles.has(index)) {
      try {
        const file = await this.#directory.getFileHandle(`block-${index}`, {create:write});
        this.#handles.set(index, await file.createSyncAccessHandle());
      } catch (error) {
        if (!write && error.name === 'NotFoundError') return undefined;
        throw error;
      }
    }
    return this.#handles.get(index);
  }
  async #transfer(offset, buffer, write) {
    if (!(buffer instanceof Uint8Array) || !Number.isSafeInteger(offset) || offset < 0 ||
        offset % sector || buffer.length % sector || offset > this.#size - buffer.length) throw new RangeError('invalid sector request');
    if (this.#closed) throw new Error('device closed');
    // Single serialized caller (storage worker); do not pipeline requests.
    for (let done = 0; done < buffer.length;) {
      const position = offset + done, at = position % this.#chunk;
      const part = buffer.subarray(done, done + Math.min(this.#chunk - at, buffer.length - done));
      const handle = await this.#handle(Math.floor(position / this.#chunk), write);
      if (write) {
        for (let copied = 0; copied < part.length;) {
          const n = handle.write(part.subarray(copied), {at:at + copied});
          if (!n) throw new Error('short OPFS write');
          copied += n;
        }
      } else {
        part.fill(0);
        for (let copied = 0; handle && copied < part.length;) {
          const n = handle.read(part.subarray(copied), {at:at + copied});
          if (!n) break;
          copied += n;
        }
      }
      done += part.length;
    }
  }
  read(offset, target) { return this.#transfer(offset, target, false); }
  write(offset, source) { return this.#transfer(offset, source, true); }
  flush() { for (const handle of this.#handles.values()) handle.flush(); }
  close() {
    this.#closed = true;
    for (const handle of this.#handles.values()) handle.close();
    this.#handles.clear();
  }
}
