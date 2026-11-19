/**
 * Spike B benchmark runner. Usage: node dist/src/bench.js [--json out.json] [--quick]
 */
import { writeFileSync } from 'node:fs';
import os from 'node:os';
import { amoAddScaling, spinlockScaling, hashScaling, measureWakeLatency, runLitmus } from './smp.js';

async function main(): Promise<void> {
  const quick = process.argv.includes('--quick');
  const jsonIdx = process.argv.indexOf('--json');
  const maxWorkers = Math.min(os.cpus().length, quick ? 2 : 4);
  const amoIters = quick ? 20_000 : 200_000;
  const spinIters = quick ? 100 : 2_000;
  const hashIters = quick ? 2_000_000 : 40_000_000;
  const litmusRounds = quick ? 5_000 : 100_000;

  process.stderr.write(`host: ${os.cpus().length} logical CPUs\n`);
  process.stderr.write('amo scaling...\n');
  const amo = await amoAddScaling(maxWorkers, amoIters);
  process.stderr.write('spinlock scaling...\n');
  const spinlock = await spinlockScaling(maxWorkers, spinIters, 100);
  process.stderr.write('hash scaling...\n');
  const hash = await hashScaling(maxWorkers, hashIters);
  process.stderr.write('wake latency...\n');
  const wake = await measureWakeLatency();
  process.stderr.write('litmus SB...\n');
  const sb = await runLitmus('litmus-sb', litmusRounds);
  process.stderr.write('litmus LB...\n');
  const lb = await runLitmus('litmus-lb', litmusRounds);

  const report = {
    benchmark: 'wasmnux-spike-b-smp',
    version: 1,
    timestamp: new Date().toISOString(),
    host: { cpus: os.cpus().length, model: os.cpus()[0]?.model ?? 'unknown', platform: process.platform, release: os.release() },
    config: { maxWorkers, amoIters, spinIters, hashIters, litmusRounds },
    amoAddScaling: amo,
    spinlockScaling: spinlock,
    hashScaling: hash,
    atomicsWait: wake,
    litmus: [sb, lb],
  };
  const json = JSON.stringify(report, null, 2);
  if (jsonIdx >= 0 && process.argv[jsonIdx + 1]) writeFileSync(process.argv[jsonIdx + 1]!, json);
  console.log(json);
}

main().catch(err => { console.error(err); process.exit(1); });
