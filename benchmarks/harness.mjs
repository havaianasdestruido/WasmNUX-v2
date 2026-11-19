import { execSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { runSpikeA } from "../spikes/spike-a-jit/bench.mjs";
import { runSpikeB } from "../spikes/spike-b-smp/bench.mjs";
import { runSpikeC } from "../spikes/spike-c-storage/bench.mjs";
import { runSpikeD } from "../spikes/spike-d-gpu/bench.mjs";
import { runSpikeE } from "../spikes/spike-e-network/bench.mjs";
import { runSpikeF } from "../spikes/spike-f-terminal/bench.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));

function getGitCommit() {
  try {
    return execSync("git rev-parse --short HEAD", { encoding: "utf8" }).trim();
  } catch {
    return "unknown";
  }
}

export async function runAllBenchmarks({ writeReport = true } = {}) {
  const report = {
    timestamp: new Date().toISOString(),
    commit: getGitCommit(),
    nodeVersion: process.version,
    spikes: {
      spikeA_jit: runSpikeA(),
      spikeB_smp: await runSpikeB(),
      spikeC_storage: runSpikeC(),
      spikeD_gpu: runSpikeD(),
      spikeE_network: runSpikeE(),
      spikeF_terminal: runSpikeF(),
    },
  };

  if (writeReport) {
    const outDir = join(__dirname, "results");
    mkdirSync(outDir, { recursive: true });
    writeFileSync(join(outDir, "latest.json"), JSON.stringify(report, null, 2));
  }

  return report;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const report = await runAllBenchmarks();
  console.log(JSON.stringify(report, null, 2));
}
