import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";
import { SpscPacketRing, detectNetworkTier } from "./net-ring.mjs";

export function runSpikeE() {
  const ring = new SpscPacketRing(256, 2048);
  const pkt = new Uint8Array(1500).fill(0x42);
  const count = 50_000;

  const t0 = performance.now();
  let transferred = 0;
  for (let i = 0; i < count; i++) {
    ring.enqueue(pkt);
    const out = ring.dequeue();
    if (out) transferred += out.byteLength;
  }
  const ms = performance.now() - t0;

  return {
    tier: detectNetworkTier(),
    packets: count,
    throughputMBs: Number(((transferred / (1024 * 1024)) / (ms / 1000)).toFixed(1)),
    ms: Number(ms.toFixed(2)),
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  console.log("Spike E (Network):", JSON.stringify(runSpikeE(), null, 2));
}
