/** Chromium smoke test for the built demo, including isolation and differential results. */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { readFile } from 'node:fs/promises';
import { chromium } from 'playwright-core';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { findBrowser } from '../../benchmarks/src/browser.ts';

const executablePath = findBrowser();
if (!executablePath) {
  throw new Error('Chromium not found: install it with npx playwright install chromium or set WNX_BROWSER');
}
const html = await readFile(new URL('../../dist/web/index.html', import.meta.url));
const js = await readFile(new URL('../../dist/web/main.js', import.meta.url));
const assets = new Map<string, string | Buffer>();
assets.set('/hart.js', await readFile(new URL('../../dist/web/hart.js', import.meta.url)));
for (const [name, source] of [
  ['browser-checks', '../../host/test/browser-checks.ts'],
  ['storage-worker', '../../host/test/storage-worker.ts'],
]) {
  const built = await build({
    entryPoints: [fileURLToPath(new URL(source!, import.meta.url))],
    bundle: true,
    write: false,
    platform: 'browser',
    format: 'esm',
    target: 'es2022',
  });
  assets.set(`/${name}.js`, built.outputFiles![0]!.text);
}
const server = createServer((req, res) => {
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  if (req.url === '/') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(html);
  } else if (req.url === '/main.js') {
    res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8' });
    res.end(js);
  } else if (assets.has(req.url ?? '')) {
    res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8' });
    res.end(assets.get(req.url!));
  } else {
    res.writeHead(404);
    res.end();
  }
});
await new Promise<void>((resolve, reject) => {
  server.once('error', reject);
  server.listen(0, '127.0.0.1', resolve);
});
try {
  const browser = await chromium.launch({ executablePath, headless: true });
  try {
    const page = await browser.newPage();
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    const port = (server.address() as AddressInfo).port;
    await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'load', timeout: 60_000 });
    await page.waitForFunction(() => document.title !== 'WasmNUX demo', null, { timeout: 60_000 });
    assert.equal(await page.title(), 'WasmNUX demo: ok');
    assert.equal(
      await page.evaluate(() => crossOriginIsolated && typeof SharedArrayBuffer !== 'undefined'),
      true,
    );
    const result = await page.locator('#out').innerText();
    assert.match(result, /done: both engines agree on every case/);
    const hostResult = await page.evaluate(async () => {
      const path = '/browser-checks.js';
      const { browserChecks } = await import(path);
      return browserChecks();
    });
    console.log(hostResult);
    assert.equal(errors.length, 0, errors.join('\n'));
    console.log(`Chromium ${browser.version()}: demo passed (cross-origin isolated)`);
  } finally {
    await browser.close();
  }
} finally {
  await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
}
