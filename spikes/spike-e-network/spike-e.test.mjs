import test from "node:test";
import assert from "node:assert/strict";
import { SpscPacketRing, detectNetworkTier } from "./net-ring.mjs";
import { runSpikeE } from "./bench.mjs";

test("Spike E: SpscPacketRing preserves packet contents and order", () => {
  const ring = new SpscPacketRing(16, 128);
  const p1 = new Uint8Array([1, 2, 3, 4]);
  const p2 = new Uint8Array([5, 6, 7]);
  assert.equal(ring.enqueue(p1), true);
  assert.equal(ring.enqueue(p2), true);
  assert.deepEqual(ring.dequeue(), p1);
  assert.deepEqual(ring.dequeue(), p2);
  assert.equal(ring.dequeue(), null);
});

test("Spike E: SpscPacketRing rejects packets exceeding slot capacity", () => {
  const ring = new SpscPacketRing(16, 128);
  const oversized = new Uint8Array(127); // max payload is 128 - 2 = 126
  assert.equal(ring.enqueue(oversized), false);
});

test("Spike E: detects Direct Sockets IWA vs relay fallback", () => {
  assert.equal(detectNetworkTier({}), "userspace-tcpip-relay");
  assert.equal(detectNetworkTier({ TCPSocket: function () {} }), "direct-sockets-iwa");
});

test("Spike E: benchmark runs cleanly", () => {
  const res = runSpikeE();
  assert.ok(res.throughputMBs > 0);
});
