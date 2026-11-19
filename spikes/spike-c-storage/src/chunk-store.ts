/**
 * Spike C — chunked copy-on-write overlay with a write-ahead journal
 * (ROADMAP §4 storage KPIs, ADR-0005, Phase 2 "crash consistency").
 *
 * Model:
 *   read(id)  → overlay → base (read-only image) → zeros (sparse)
 *   write(id) → journal[BEGIN(id,len,crc,payload) … COMMIT] → chunk file → flush
 *
 * Recovery replays only BEGIN..COMMIT spans with a valid CRC and truncates the
 * torn tail, so a crash at ANY byte boundary leaves a consistent overlay
 * (the fault-injection tests verify every truncation point).
 */

export const CRC32_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) {
    c = CRC32_TABLE[(c ^ bytes[i]!) & 0xff]! ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

/** Abstract durable storage behind the overlay (Node fs / OPFS later). */
export interface ChunkBackend {
  /** Read a chunk from the overlay; null when absent. */
  readOverlay(id: number): Promise<Uint8Array | null>;
  /** Persist an overlay chunk (post-journal-commit). */
  writeOverlay(id: number, bytes: Uint8Array): Promise<void>;
  /** Append raw bytes to the journal (single sequential file). */
  journalAppend(bytes: Uint8Array): Promise<void>;
  /** Read the whole journal. */
  journalRead(): Promise<Uint8Array>;
  /** Truncate the journal to `size` (recovery). */
  journalTruncate(size: number): Promise<void>;
  /** fsync-equivalent for the durability boundary. */
  flush(): Promise<void>;
}

export interface BaseImage {
  /** Read-only base chunk; null when the base is sparse there. */
  read(id: number): Uint8Array | null;
}

// Journal record framing:
//   BEGIN: magic 0x574e5831 ('WNX1') | u32 id | u32 len | u32 crc | payload
//   COMMIT: magic 0x574e5843 ('WNXC') | u32 seq
const BEGIN_MAGIC = 0x574e5831;
const COMMIT_MAGIC = 0x574e5843;

function u32le(v: number): Uint8Array {
  return Uint8Array.of(v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff);
}
function readU32(b: Uint8Array, off: number): number {
  return (b[off]! | (b[off + 1]! << 8) | (b[off + 2]! << 16) | (b[off + 3]! << 24)) >>> 0;
}

export interface StoreStats {
  overlayReads: number;
  baseReads: number;
  missReads: number;
  writes: number;
  journalBytes: number;
  recoveredRecords: number;
  discardedTornRecords: number;
}

export class ChunkedCowStore {
  readonly stats: StoreStats = {
    overlayReads: 0, baseReads: 0, missReads: 0,
    writes: 0, journalBytes: 0, recoveredRecords: 0, discardedTornRecords: 0,
  };

  /**
   * Journal transactions must be strictly serialised: interleaved
   * BEGIN/COMMIT pairs from concurrent writeChunk calls would break
   * `recover()`'s "COMMIT follows its BEGIN" scanning rule and could
   * discard a committed payload on crash replay.
   */
  private txChain: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly backend: ChunkBackend,
    private readonly base: BaseImage,
    readonly chunkSize: number,
  ) {}

  /** Journal + overlay write for one chunk (durability: journal BEFORE data). */
  writeChunk(id: number, bytes: Uint8Array): Promise<void> {
    const run = this.txChain.then(() => this.writeChunkTx(id, bytes));
    // Keep the chain alive even when a write fails.
    this.txChain = run.catch(() => undefined);
    return run;
  }

  private async writeChunkTx(id: number, bytes: Uint8Array): Promise<void> {
    if (bytes.byteLength !== this.chunkSize) {
      throw new Error(`chunk ${id}: expected ${this.chunkSize} bytes, got ${bytes.byteLength}`);
    }
    const payload = bytes;
    const begin = new Uint8Array(16 + payload.byteLength);
    begin.set(u32le(BEGIN_MAGIC), 0);
    begin.set(u32le(id), 4);
    begin.set(u32le(payload.byteLength), 8);
    begin.set(u32le(crc32(payload)), 12);
    begin.set(payload, 16);
    const commit = new Uint8Array(8);
    commit.set(u32le(COMMIT_MAGIC), 0);
    commit.set(u32le(this.stats.writes + 1), 4);

    await this.backend.journalAppend(begin);
    await this.backend.journalAppend(commit);
    await this.backend.flush();           // ← durability point
    await this.backend.writeOverlay(id, payload);
    await this.backend.flush();
    this.stats.journalBytes += begin.byteLength + commit.byteLength;
    this.stats.writes++;
  }

  async readChunk(id: number): Promise<Uint8Array> {
    const overlay = await this.backend.readOverlay(id);
    if (overlay) {
      this.stats.overlayReads++;
      return overlay;
    }
    const base = this.base.read(id);
    if (base) {
      this.stats.baseReads++;
      return base;
    }
    this.stats.missReads++;
    return new Uint8Array(this.chunkSize); // sparse zeros
  }

  /**
   * Replay the journal: apply committed records whose overlay write was lost,
   * truncate any torn tail. Returns recovery counters.
   */
  async recover(): Promise<{ applied: number; discarded: number; truncatedTo: number }> {
    const journal = await this.backend.journalRead();
    let off = 0;
    let applied = 0;
    let discarded = 0;
    let lastGood = 0;
    while (off + 8 <= journal.byteLength) {
      const magic = readU32(journal, off);
      if (magic === BEGIN_MAGIC) {
        if (off + 16 > journal.byteLength) { discarded++; break; }
        const id = readU32(journal, off + 4);
        const len = readU32(journal, off + 8);
        const crc = readU32(journal, off + 12);
        const end = off + 16 + len;
        const commitEnd = end + 8;
        if (end > journal.byteLength || len > this.chunkSize) { discarded++; break; }
        const payload = journal.subarray(off + 16, end);
        if (crc32(payload) !== crc) { discarded++; break; }
        // BEGIN payload intact — need COMMIT to apply.
        if (commitEnd > journal.byteLength) { discarded++; break; }
        const commitMagic = readU32(journal, end);
        if (commitMagic !== COMMIT_MAGIC) { discarded++; break; }
        const overlay = await this.backend.readOverlay(id);
        if (!overlay || crc32(overlay) !== crc) {
          await this.backend.writeOverlay(id, payload.slice());
          applied++;
        }
        off = commitEnd;
        lastGood = off;
      } else if (magic === COMMIT_MAGIC) {
        off += 8; // orphan commit (BEGIN lost) — skip
        lastGood = off;
      } else {
        discarded++;
        break;
      }
    }
    if (lastGood !== journal.byteLength) {
      await this.backend.journalTruncate(lastGood);
      await this.backend.flush();
    }
    this.stats.recoveredRecords += applied;
    this.stats.discardedTornRecords += discarded;
    return { applied, discarded, truncatedTo: lastGood };
  }
}

/** In-memory backend with fault injection (test/bench). */
export class MemBackend implements ChunkBackend {
  overlay = new Map<number, Uint8Array>();
  journal: number[] = [];
  /** Crash simulation: stop accepting writes after N journal appends. */
  crashAfterAppends: number | null = null;
  private appends = 0;
  flushes = 0;

  async readOverlay(id: number): Promise<Uint8Array | null> {
    return this.overlay.get(id) ?? null;
  }
  async writeOverlay(id: number, bytes: Uint8Array): Promise<void> {
    this.overlay.set(id, bytes.slice());
  }
  async journalAppend(bytes: Uint8Array): Promise<void> {
    if (this.crashAfterAppends !== null && this.appends >= this.crashAfterAppends) {
      throw new Error("SIMULATED CRASH"); // torn write window
    }
    this.appends++;
    for (const b of bytes) this.journal.push(b);
  }
  async journalRead(): Promise<Uint8Array> {
    return Uint8Array.from(this.journal);
  }
  async journalTruncate(size: number): Promise<void> {
    this.journal.length = size;
  }
  async flush(): Promise<void> { this.flushes++; }
}
