import test from "node:test";
import assert from "node:assert/strict";
import { runAllBenchmarks } from "./harness.mjs";

test("Benchmark harness runs all Phase 0 spikes and produces a valid report", async () => {
  const report = await runAllBenchmarks({ writeReport: false });
  assert.ok(report.commit);
  assert.ok(report.spikes.spikeA_jit.speedup > 1);
  assert.equal(report.spikes.spikeB_smp.lrsc4Actual, report.spikes.spikeB_smp.lrsc4Expected);
  assert.equal(report.spikes.spikeC_storage.length, 4);
  assert.ok(report.spikes.spikeD_gpu.drawsPerSec > 0);
  assert.ok(report.spikes.spikeE_network.throughputMBs > 0);
  assert.ok(report.spikes.spikeF_terminal.throughputMBs > 0);
});
