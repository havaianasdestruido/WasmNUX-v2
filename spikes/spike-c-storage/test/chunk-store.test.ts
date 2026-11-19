import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ChunkedCowStore, MemBackend, crc32 } from "../src/chunk-store.js";
import { NodeBackend } from "../src/node-backend.js";

const CS = 4096;
const chunk = (fill: number): Uint8Array => new Uint8Array(CS).fill(fill);

const base = (chunks: Record<number, Uint8Array>) => ({
  read: (id: number) => chunks[id] ?? null,
});

describe("spike C — chunked COW overlay", () => {
  it("crc32 matches known vectors", () => {
    expect(crc32(new TextEncoder().encode("123456789"))).toBe(0xcbf43926);
    expect(crc32(new Uint8Array(0))).toBe(0);
  });

  it("write → read roundtrip hits overlay, then base, then zeros", async () => {
    const backend = new MemBackend();
    const store = new ChunkedCowStore(backend, base({ 1: chunk(0xaa) }), CS);
    await store.writeChunk(7, chunk(0x77));
    expect((await store.readChunk(7))[0]).toBe(0x77);
    expect((await store.readChunk(1))[0]).toBe(0xaa);
    const sparse = await store.readChunk(9);
    expect(sparse.byteLength).toBe(CS);
    expect(sparse.every((b) => b === 0)).toBe(true);
    expect(store.stats.overlayReads).toBe(1);
    expect(store.stats.baseReads).toBe(1);
    expect(store.stats.missReads).toBe(1);
  });

  it("rejects wrong-size chunks", async () => {
    const store = new ChunkedCowStore(new MemBackend(), base({}), CS);
    await expect(store.writeChunk(0, new Uint8Array(10))).rejects.toThrow(/expected/);
  });

  it("survives a crash at EVERY journal append boundary (atomicity)", async () => {
    for (let crashAt = 0; crashAt <= 4; crashAt++) {
      const backend = new MemBackend();
      const store = new ChunkedCowStore(backend, base({}), CS);
      await store.writeChunk(0, chunk(0x11)); // committed baseline
      backend.crashAfterAppends = crashAt;     // c2's appends start counting
      let crashed = false;
      try {
        await store.writeChunk(1, chunk(0x22));
      } catch {
        crashed = true;
      }
      backend.crashAfterAppends = null;
      const store2 = new ChunkedCowStore(backend, base({}), CS);
      const rec = await store2.recover();
      const c0 = await store2.readChunk(0);
      const c1 = await store2.readChunk(1);
      expect(c0[0], `crashAt=${crashAt} chunk0 intact`).toBe(0x11);
      // chunk 1 must be exactly old (absent→zeros) or exactly new — never torn
      expect([0, 0x22], `crashAt=${crashAt}`).toContain(c1[0]);
      if (crashed && crashAt < 2) expect(rec.discarded).toBeGreaterThanOrEqual(0);
      expect(backend.journal.length).toBe(rec.truncatedTo);
    }
  });

  it("applies journal payload when overlay write was lost", async () => {
    const backend = new MemBackend();
    const store = new ChunkedCowStore(backend, base({}), CS);
    // Simulate: journal committed, overlay write lost, then crash.
    const payload = chunk(0x55);
    const begin = new Uint8Array(16 + CS);
    const view = new DataView(begin.buffer);
    view.setUint32(0, 0x574e5831, true);
    view.setUint32(4, 3, true);
    view.setUint32(8, CS, true);
    view.setUint32(12, crc32(payload), true);
    begin.set(payload, 16);
    const commit = new Uint8Array(8);
    new DataView(commit.buffer).setUint32(0, 0x574e5843, true);
    new DataView(commit.buffer).setUint32(4, 1, true);
    await backend.journalAppend(begin);
    await backend.journalAppend(commit);
    const rec = await store.recover();
    expect(rec.applied).toBe(1);
    expect((await store.readChunk(3))[0]).toBe(0x55);
  });

  it("discards a corrupted (torn) payload and keeps prior state", async () => {
    const backend = new MemBackend();
    const store = new ChunkedCowStore(backend, base({}), CS);
    await store.writeChunk(0, chunk(0x11));
    const rec0len = backend.journal.length; // BEGIN + COMMIT of chunk 0
    // Inject a torn record for chunk 4: payload byte flipped (overlay never written)
    const payload = chunk(0x44);
    payload[5] ^= 0xff; // corrupt
    const begin = new Uint8Array(16 + CS);
    const view = new DataView(begin.buffer);
    view.setUint32(0, 0x574e5831, true);
    view.setUint32(4, 4, true);
    view.setUint32(8, CS, true);
    view.setUint32(12, 0xdeadbeef, true); // wrong crc
    begin.set(payload, 16);
    const commit = new Uint8Array(8);
    new DataView(commit.buffer).setUint32(0, 0x574e5843, true);
    new DataView(commit.buffer).setUint32(4, 2, true);
    await backend.journalAppend(begin);
    await backend.journalAppend(commit);

    const rec = await store.recover();
    expect(rec.discarded).toBe(1);
    expect((await store.readChunk(4))[0]).toBe(0); // torn write never applied
    expect((await store.readChunk(0))[0]).toBe(0x11); // earlier commit intact
    expect(backend.journal.length).toBe(rec0len); // torn tail truncated
  });
});

describe("spike C — Node backend (real fsync path)", () => {
  const dirs: string[] = [];
  afterEach(async () => {
    for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
  });

  it("round-trips through files and recovers after simulated crash", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "wnx-store-"));
    dirs.push(dir);
    const backend = new NodeBackend(dir);
    await backend.init();
    const store = new ChunkedCowStore(backend, base({ 0: chunk(0xab) }), CS);
    await store.writeChunk(5, chunk(0x05));
    await backend.close();

    // New process-equivalent: fresh handle, journal replay
    const backend2 = new NodeBackend(dir);
    await backend2.init();
    const store2 = new ChunkedCowStore(backend2, base({ 0: chunk(0xab) }), CS);
    expect((await store2.readChunk(5))[0]).toBe(0x05);
    expect((await store2.readChunk(0))[0]).toBe(0xab);
    const rec = await store2.recover();
    expect(rec.applied).toBe(0); // nothing lost — overlay already durable
    expect(rec.discarded).toBe(0);
    await backend2.close();
  });

  it("chunk-size sweep works for standard sizes", async () => {
    for (const size of [4096, 65536, 262144, 1048576]) {
      const dir = await mkdtemp(path.join(tmpdir(), "wnx-store-"));
      dirs.push(dir);
      const backend = new NodeBackend(dir);
      await backend.init();
      const store = new ChunkedCowStore(backend, base({}), size);
      const data = new Uint8Array(size).fill(0xcd);
      await store.writeChunk(0, data);
      const back = await store.readChunk(0);
      expect(back.byteLength, `size=${size}`).toBe(size);
      expect(back[0]).toBe(0xcd);
      expect(back[size - 1]).toBe(0xcd);
      await backend.close();
    }
  });
});

describe("spike C — concurrent writeChunk serialization (Codex)", () => {
  const dirs: string[] = [];
  afterEach(async () => {
    for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
  });

  it("serializes concurrent writeChunk calls (no torn chunk records)", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "wnx-store-cc-"));
    dirs.push(dir);
    const backend = new NodeBackend(dir);
    await backend.init();
    const store = new ChunkedCowStore(backend, base({}), CS);

    const c1 = chunk(0x01);
    const c2 = chunk(0x02);
    const c3 = chunk(0x03);
    // Fire all three without awaiting: the txChain must serialize the
    // BEGIN/COMMIT journal pairs (concurrent BEGINs would break replay).
    await Promise.all([
      store.writeChunk(1, c1),
      store.writeChunk(2, c2),
      store.writeChunk(3, c3),
    ]);

    const r1 = await store.readChunk(1);
    const r2 = await store.readChunk(2);
    const r3 = await store.readChunk(3);
    expect(r1[0]).toBe(0x01);
    expect(r2[0]).toBe(0x02);
    expect(r3[0]).toBe(0x03);
    expect(r2[CS - 1]).toBe(0x02);

    // journal replay after a fresh open sees a consistent state
    await backend.close();
    const backend2 = new NodeBackend(dir);
    await backend2.init();
    const store2 = new ChunkedCowStore(backend2, base({}), CS);
    expect((await store2.readChunk(2))[0]).toBe(0x02);
    await backend2.close();
  });
});
