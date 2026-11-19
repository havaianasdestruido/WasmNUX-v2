import { describe, expect, it } from "vitest";
import { DamageTracker, fillPattern, presentFrame } from "../src/damage.js";
import { PATHS, FEATURES, pickScanoutBackend, scorePaths } from "../src/gpu-paths.js";

const W = 64;
const H = 32;

describe("spike D — damage tracking", () => {
  it("starts full-redraw, then tracks individual rows", () => {
    const d = new DamageTracker(H);
    expect(d.isFull).toBe(true);
    expect(d.takeDamage()).toHaveLength(H);
    expect(d.isFull).toBe(false);
    expect(d.takeDamage()).toHaveLength(0);
    d.markRow(3);
    d.markRow(30);
    expect(d.takeDamage()).toEqual([3, 30]);
    expect(d.takeDamage()).toEqual([]);
  });

  it("markAll forces a full frame", () => {
    const d = new DamageTracker(H);
    d.takeDamage();
    d.markRow(5);
    d.markAll();
    expect(d.takeDamage()).toHaveLength(H);
  });

  it("ignores out-of-range rows", () => {
    const d = new DamageTracker(H);
    d.takeDamage();
    d.markRow(-1);
    d.markRow(H);
    expect(d.peekDamageCount()).toBe(0);
  });

  it("peek does not consume damage", () => {
    const d = new DamageTracker(H);
    d.takeDamage();
    d.markRow(7);
    expect(d.peekDamageCount()).toBe(1);
    expect(d.peekDamageCount()).toBe(1);
    expect(d.takeDamage()).toEqual([7]);
  });
});

describe("spike D — presentFrame", () => {
  it("copies only changed rows and counts byte diffs", () => {
    const frame = new Uint8Array(W * H * 4);
    const prev = new Uint8Array(W * H * 4);
    fillPattern(frame, W, H, 1);
    prev.set(frame);
    const staging = new Uint8Array(W * H * 4);

    // full present first
    const full = presentFrame(staging, frame, null, W, H);
    expect(full.bytesChanged).toBe(W * H * 4);
    expect(staging).toEqual(frame);

    // modify row 5 (two bytes) and present with damage
    frame[5 * W * 4 + 10] ^= 0xff;
    frame[5 * W * 4 + 11] ^= 0xff;
    const partial = presentFrame(staging, frame, prev, W, H, [5]);
    expect(partial.bytesChanged).toBe(2);
    expect(partial.rowsCopied).toBe(1);
    expect(partial.partial).toBe(true);
    expect(staging[5 * W * 4 + 10]).toBe(frame[5 * W * 4 + 10]);

    // presenting an identical row changes nothing
    const noop = presentFrame(staging, frame, prev, W, H, [5, 6]);
    expect(noop.bytesChanged).toBe(2); // only row 5 differs from prev
  });

  it("measures blit throughput for a 1080p frame (bench smoke)", () => {
    const w = 1920, h = 1080;
    const frame = new Uint8Array(w * h * 4);
    fillPattern(frame, w, h, 42);
    const staging = new Uint8Array(w * h * 4);
    const t0 = performance.now();
    presentFrame(staging, frame, null, w, h);
    const ms = performance.now() - t0;
    expect(staging[0]).toBe(frame[0]);
    expect(ms).toBeLessThan(2000); // sanity bound; real numbers go to RESULTS.md
  });
});

describe("spike D — GPU path comparison (ADR-0007)", () => {
  it("scores all four paths deterministically", () => {
    const s1 = scorePaths();
    const s2 = scorePaths();
    expect(s1).toEqual(s2);
    expect(s1).toHaveLength(4);
    for (const s of s1) {
      expect(s.conformance).toBeGreaterThan(0);
      expect(s.conformance).toBeLessThanOrEqual(100);
      expect([2, 3, 4, 5]).toContain(s.effort);
    }
    // Software fallback must have the highest conformance (it's Mesa itself).
    const lavapipe = s1.find((s) => s.id === "D-lavapipe")!;
    const gl = s1.find((s) => s.id === "A-gl-virgl")!;
    expect(lavapipe.conformance).toBeGreaterThan(gl.conformance);
  });

  it("every path documents support for every feature", () => {
    for (const p of PATHS) {
      for (const f of FEATURES) {
        expect(p.support[f.id], `${p.id}/${f.id}`).toBeDefined();
        expect([0, 1, 2]).toContain(p.support[f.id]);
      }
    }
  });

  it("scanout backend selection degrades gracefully", () => {
    expect(pickScanoutBackend(true, true)).toBe("webgpu");
    expect(pickScanoutBackend(false, true)).toBe("canvas2d");
    expect(pickScanoutBackend(true, false)).toBe("webgpu");
    // Node has neither → none (browsers with OffscreenCanvas report canvas2d)
    expect(pickScanoutBackend(false, false)).toBe(
      (typeof globalThis !== "undefined" && "OffscreenCanvas" in globalThis) ? "canvas2d" : "none",
    );
  });
});

describe("spike D — damage accounting (Codex)", () => {
  it("rowsCopied counts only rows actually staged", () => {
    const frame = new Uint8Array(W * H * 4);
    const prev = new Uint8Array(W * H * 4);
    fillPattern(frame, W, H, 1);
    prev.set(frame);
    const staging = new Uint8Array(W * H * 4);

    // full present (no previous): every row staged
    const full = presentFrame(staging, frame, null, W, H);
    expect(full.rowsCopied).toBe(H);

    // change one row, present only that row: one staged
    frame[5 * W * 4] ^= 0xff;
    const partial = presentFrame(staging, frame, prev, W, H, [5]);
    expect(partial.rowsCopied).toBe(1);
    expect(partial.bytesChanged).toBe(1);

    // present the same damage again with prev updated: nothing staged
    prev.set(frame);
    const noop = presentFrame(staging, frame, prev, W, H, [5, 6]);
    expect(noop.rowsCopied).toBe(0);
    expect(noop.bytesChanged).toBe(0);
  });
});
