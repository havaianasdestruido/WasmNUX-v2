import test from "node:test";
import assert from "node:assert/strict";
import { GPU_PATHS, CommandStreamRing } from "./gpu-paths.mjs";
import { runSpikeD } from "./bench.mjs";

test("Spike D: virtio-webgpu has highest conformance among hardware paths", () => {
  assert.ok(GPU_PATHS.C_VIRTIO_WEBGPU.webgpuConformancePct > GPU_PATHS.B_VENUS.webgpuConformancePct);
  assert.ok(GPU_PATHS.C_VIRTIO_WEBGPU.webgpuConformancePct > GPU_PATHS.A_VIRGL.webgpuConformancePct);
});

test("Spike D: CommandStreamRing serializes and drains draws", () => {
  const ring = new CommandStreamRing(1024);
  ring.pushDraw(1, 3, 1);
  ring.pushDraw(2, 6, 1);
  assert.equal(ring.drain(2), 1 + 3 + 2 + 6);
});

test("Spike D: benchmark runs within 16ms/frame scanout budget", () => {
  const res = runSpikeD();
  assert.ok(res.scanoutMsPerFrame1080p < 16.67);
});
