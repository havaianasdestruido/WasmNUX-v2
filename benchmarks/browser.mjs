import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';
import {chromium} from 'playwright-core';
import packaged from '@sparticuz/chromium';
import {build} from 'esbuild';
import {fontAssets} from '../host/terminal/fonts.mjs';
import {attachRelay} from '../relay/fixture.mjs';

const assetPaths = new Map([
  ...fontAssets.map(({file,source}) => [`/assets/${file}`,source]),
  ['/assets/libv86.mjs','node_modules/v86/build/libv86.mjs'],
  ['/assets/v86.wasm','node_modules/v86/build/v86.wasm'],
  ['/assets/v86-fallback.wasm','node_modules/v86/build/v86-fallback.wasm'],
  ['/assets/seabios.bin','browser-results/assets/seabios.bin'],
  ['/assets/loop.elf','browser-results/assets/loop.elf'],
  ['/tcpip.wasm','node_modules/tcpip/tcpip.wasm']
]);
const root = new URL('../', import.meta.url);
const mime = path => ({mjs:'text/javascript', woff2:'font/woff2', wasm:'application/wasm', html:'text/html'}[path.split('.').at(-1)] || 'application/octet-stream');
export async function withBrowser(run) {
  execFileSync('bash', ['benchmarks/v86/prepare.sh'], {cwd:root, stdio:'inherit'});
  const packed = (await build({entryPoints:[fileURLToPath(new URL('host/net/probe-worker.mjs',root))],
    bundle:true, format:'esm', write:false, external:['fs','stream']})).outputFiles[0].contents;
  const server = createServer(async (req,res) => {
    const path = req.url === '/' ? '/web/bench.html' : req.url;
    const file = assetPaths.get(path) || (/^\/(core|host|web|benchmarks)(\/[a-z0-9_-]+)+\.(mjs|html)$/.test(path) && path.slice(1));
    try {
      const data = path === '/assets/net-worker.mjs' ? packed : file && await readFile(new URL(file, root));
      if (!data) { res.writeHead(404).end(); return; }
      res.writeHead(200, {'Content-Type':mime(path), 'Cross-Origin-Opener-Policy':'same-origin',
        'Cross-Origin-Embedder-Policy':'require-corp', 'Cross-Origin-Resource-Policy':'same-origin',
        'X-Content-Type-Options':'nosniff', 'Cache-Control':'no-store',
        'Content-Security-Policy':"default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self' blob:; font-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'"});
      res.end(data);
    } catch { res.writeHead(404).end(); }
  });
  const closeRelay = attachRelay(server);
  await new Promise((resolve,reject) => { server.once('error',reject); server.listen(0,'127.0.0.1',resolve); });
  const address = `http://127.0.0.1:${server.address().port}`;
  let browser;
  try {
    const executablePath = process.env.CHROMIUM_PATH || await packaged.executablePath();
    browser = await chromium.launch({executablePath, args:[
      '--enable-unsafe-webgpu', ...(process.env.WNX_HARDWARE_GPU ? [] :
        ['--use-webgpu-adapter=swiftshader','--use-angle=swiftshader','--enable-unsafe-swiftshader']),
      '--disable-dev-shm-usage', ...(process.env.CHROMIUM_PATH ? [] : ['--single-process','--no-zygote'])
    ]});
    const page = await browser.newPage();
    page.on('pageerror', e => console.error(e));
    await page.goto(address);
    await page.waitForFunction(() => !!globalThis.probes);
    return await run(page, await page.context().newCDPSession(page), browser.version());
  } finally {
    try { await browser?.close(); } finally {
      closeRelay(); server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
    }
  }
}

export async function probeIme(page, cdp) {
  await page.focus('#ime');
  const samples = [];
  for (const text of ['日', '日本']) {
    await cdp.send('Input.imeSetComposition', {text, selectionStart:text.length, selectionEnd:text.length});
    samples.push(await page.evaluate(() => ({preedit:document.querySelector('#ime').value, commits:probes.commits.slice()})));
  }
  await cdp.send('Input.insertText', {text:'日本'});
  return {samples, commits:await page.evaluate(() => probes.commits.slice())};
}

export async function probeOriginLoss(page, cdp) {
  const origin = new URL(page.url()).origin;
  const before = await page.evaluate(async () => {
    const seeded = await probes.originLoss('seed');
    const checked = await probes.originLoss('check');
    return {...seeded, ...checked};
  });
  if (!before.present) throw new Error('flushed OPFS control sector missing before simulated loss');
  let quota;
  try {
    await cdp.send('Storage.overrideQuotaForOrigin', {origin, quotaSize:(before.usage ?? 4096) + 256*1024});
    quota = await page.evaluate(() => probes.originLoss('quota'));
  } finally {
    await cdp.send('Storage.overrideQuotaForOrigin', {origin});
  }
  await cdp.send('Storage.clearDataForOrigin', {origin, storageTypes:'all'});
  const after = await page.evaluate(() => probes.originLoss('check'));
  if (after.present) throw new Error('origin clearing did not remove OPFS control sector');
  return {originDataClearSimulation:{before, after}, quota, automaticEviction:'unmeasured'};
}
