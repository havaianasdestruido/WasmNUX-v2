/**
 * Block device abstraction shared by the spike implementations.
 * All I/O is positional; sizes are in bytes; offsets are absolute.
 */
export interface BlockDevice {
  readonly sizeBytes: number;
  readAt(offset: number, length: number): Uint8Array;
  writeAt(offset: number, data: Uint8Array): void;
  /** Flush all buffered state to durable storage (fdatasync-class). */
  flush(): void;
  close(): void;
}

/** Deterministic in-memory device for tests (optionally pre-faulted). */
export class InMemoryBlockDevice implements BlockDevice {
  readonly sizeBytes: number;
  readonly bytes: Uint8Array;
  flushCount = 0;
  constructor(sizeBytes: number, fill = 0) {
    this.sizeBytes = sizeBytes;
    this.bytes = new Uint8Array(sizeBytes).fill(fill);
  }
  readAt(offset: number, length: number): Uint8Array {
    this.bounds(offset, length);
    return this.bytes.slice(offset, offset + length);
  }
  writeAt(offset: number, data: Uint8Array): void {
    this.bounds(offset, data.length);
    this.bytes.set(data, offset);
  }
  flush(): void { this.flushCount++; }
  close(): void { /* nothing */ }
  private bounds(offset: number, length: number): void {
    if (offset < 0 || length < 0 || offset + length > this.sizeBytes) {
      throw new RangeError(`block device access out of bounds: off=${offset} len=${length} size=${this.sizeBytes}`);
    }
  }
}
