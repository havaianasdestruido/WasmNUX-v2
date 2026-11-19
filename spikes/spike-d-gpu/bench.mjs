import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";
import { GPU_PATHS, CommandStreamRing } from "./gpu-paths.mjs";

export function runSpikeD() {
  const ring = new CommandStreamRing(1024 * 1024);
  const draws = 100_000;
  const batchSize = 4096;

  const t0 = performance.now();
  let checksum = 0;
  for (let i = 0; i < draws; i++) {
    if (!ring.pushDraw(i & 0xff, 36, 1)) {
      checksum = (checksum + ring.drain(batchSize)) | 0;
      ring.pushDraw(i & 0xff, 36, 1);
    }
  }
  checksum = (checksum + ring.drain()) | 0;
  const cmdMs = performance.now() - t0;

  // Simulate 1080p RGBA8 scanout copy (damage rect = 10% of frame)
  const frameBytes = 1920 * 1080 * 4;
  const src = new Uint8Array(frameBytes);
  const dst = new Uint8Array(frameBytes);
  const damageBytes = Math.floor(frameBytes * 0.1);
  const t1 = performance.now();
  for (let f = 0; f < 60; f++) {
    dst.set(src.subarray(0, damageBytes), 0);
  }
  const scanout60Ms = performance.now() - t1;

  return {
    recommendedPath: GPU_PATHS.C_VIRTIO_WEBGPU.name,
    fallbackPath: GPU_PATHS.D_LAVAPIPE_SIMD.name,
    drawsPerSec: Math.round(draws / (cmdMs / 1000)),
    scanoutMsPerFrame1080p: Number((scanout60Ms / 60).toFixed(3)),
    checksum,
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  console.log("Spike D (Display + GPU):", JSON.stringify(runSpikeD(), null, 2));
}
