/**
 * Spike C — Node backend: real files under a directory (OPFS stands in via
 * the same ChunkBackend interface in the browser build).
 *
 * Layout: <dir>/chunks/<id>.bin, <dir>/journal.bin
 */

import { promises as fs } from "node:fs";
import * as path from "node:path";
import type { ChunkBackend } from "./chunk-store.js";

export class NodeBackend implements ChunkBackend {
  private readonly chunkDir: string;
  private readonly journalPath: string;
  private fh: import("node:fs/promises").FileHandle | null = null;

  constructor(readonly dir: string) {
    this.chunkDir = path.join(dir, "chunks");
    this.journalPath = path.join(dir, "journal.bin");
  }

  async init(): Promise<void> {
    await fs.mkdir(this.chunkDir, { recursive: true });
    try {
      await fs.access(this.journalPath);
    } catch {
      await fs.writeFile(this.journalPath, new Uint8Array(0));
    }
    this.fh = await fs.open(this.journalPath, "a");
  }

  private chunkPath(id: number): string {
    return path.join(this.chunkDir, `${id.toString(16)}.bin`);
  }

  async readOverlay(id: number): Promise<Uint8Array | null> {
    try {
      const buf = await fs.readFile(this.chunkPath(id));
      return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
    } catch {
      return null;
    }
  }

  async writeOverlay(id: number, bytes: Uint8Array): Promise<void> {
    const tmp = this.chunkPath(id) + ".tmp";
    await fs.writeFile(tmp, bytes);
    await fs.rename(tmp, this.chunkPath(id));
  }

  async journalAppend(bytes: Uint8Array): Promise<void> {
    if (!this.fh) await this.init();
    await this.fh!.write(bytes);
  }

  async journalRead(): Promise<Uint8Array> {
    try {
      const buf = await fs.readFile(this.journalPath);
      return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
    } catch {
      return new Uint8Array(0);
    }
  }

  async journalTruncate(size: number): Promise<void> {
    if (this.fh) { await this.fh.close(); this.fh = null; }
    await fs.truncate(this.journalPath, size);
  }

  async flush(): Promise<void> {
    if (this.fh) await this.fh.sync();
  }

  async close(): Promise<void> {
    if (this.fh) { await this.fh.close(); this.fh = null; }
  }
}
