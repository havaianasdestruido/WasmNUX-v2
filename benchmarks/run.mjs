import {execFileSync} from 'node:child_process';
import {mkdir, writeFile} from 'node:fs/promises';
import {dirname} from 'node:path';
import {arch, availableParallelism, cpus, platform, release} from 'node:os';
import {withBrowser, probeIme, probeOriginLoss} from './browser.mjs';
const git = args => execFileSync('git', args, {encoding:'utf8'}).trim();
const commit = git(['rev-parse','HEAD']);
const out = process.argv[2] || `browser-results/${commit}.json`;
const dirty = !!git(['status','--porcelain']);
const results = await withBrowser(async (page, cdp, browser) => ({
  environment:{browser, node:process.version, arch:arch(), os:platform(), kernel:release(),
    cpu:cpus()[0]?.model, logicalProcessors:availableParallelism(), gpuMode:process.env.WNX_HARDWARE_GPU ? 'system adapter' : 'SwiftShader requested'},
  crossOriginIsolated:await page.evaluate(() => crossOriginIsolated),
  ime:await probeIme(page, cdp),
  cpu:await page.evaluate(() => probes.cpu()),
  smp:await page.evaluate(() => probes.smp()),
  storage:await page.evaluate(() => probes.storage()),
  originLoss:await probeOriginLoss(page, cdp),
  graphics:await page.evaluate(() => probes.graphics()),
  network:await page.evaluate(() => probes.network()),
}));
await mkdir(dirname(out), {recursive:true});
await writeFile(out, JSON.stringify({schema:1, commit, dirty, recordedAt:new Date().toISOString(), ...results}, null, 2)+'\n');
console.log(out);
