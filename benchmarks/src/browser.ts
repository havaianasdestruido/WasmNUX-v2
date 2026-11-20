/**
 * Browser runner: measure the same suites in a real browser.
 *
 * Node numbers are not browser numbers. What a spike actually has to know is
 * whether the design works where it ships, and three things differ enough to
 * matter: whether the page is cross-origin isolated (which decides if
 * `SharedArrayBuffer` and therefore SMP and Wasm atomics exist at all), how fast
 * the browser's Wasm compiler is compared to V8-in-Node, and whether a 4 GiB
 * reservation is accepted. So this module bundles the browser-safe entry point,
 * serves it with COOP/COEP headers (ADR-0010), and drives it with
 * playwright-core.
 *
 * The bundle step and the server are usable without a browser; only the
 * automation needs one. When no executable is found the failure says exactly how
 * to fix it rather than throwing a stack trace.
 */

import { existsSync, readdirSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import type { BenchReport } from './types.ts';

export interface BrowserRunOptions {
  suites: string[];
  reps?: number;
  scale?: number;
  port?: number;
  browserPath?: string;
  /** Milliseconds to wait for the page to finish. */
  timeoutMs?: number;
  headless?: boolean;
}

const ENTRY = fileURLToPath(new URL('./browser-entry.ts', import.meta.url));

/** Bundle the browser entry point into a single ESM file. */
export async function bundleEntry(): Promise<{ code: string; bytes: number }> {
  const result = await build({
    entryPoints: [ENTRY],
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: 'es2022',
    write: false,
    sourcemap: 'inline',
    // Nothing Node-only is reachable from the entry point; if that ever changes
    // it should fail the bundle, not silently ship a broken page.
    external: [],
  });
  const code = result.outputFiles?.[0]?.text ?? '';
  if (!code) throw new Error('esbuild produced no output for the browser entry point');
  return { code, bytes: code.length };
}

const PAGE = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>running</title>
    <style>body{font:14px/1.5 ui-monospace,monospace;margin:2rem;background:#111;color:#eee}</style>
  </head>
  <body>
    <h1>WasmNUX benchmarks</h1>
    <p id="state">starting</p>
    <pre id="log"></pre>
    <script type="module">
      const log = document.getElementById('log');
      const state = document.getElementById('state');
      const origFetch = window.fetch.bind(window);
      window.fetch = async (url, init) => {
        if (url === '/log' && init && init.body) {
          log.textContent += init.body + '\\n';
          state.textContent = String(init.body);
        }
        return origFetch(url, init);
      };
    </script>
    <script type="module" src="/bench.js"></script>
  </body>
</html>
`;

interface Served {
  server: Server;
  url: string;
  port: number;
  /** Resolves with the report the page POSTed. */
  done: Promise<BenchReport>;
  logs: string[];
  close(): void;
}

/**
 * Serve the bundle with cross-origin isolation headers. Without COOP/COEP the
 * page has no `SharedArrayBuffer`, so the atomics and shared-memory cases would
 * silently measure the fallback path instead of the real one.
 */
export async function serveBundle(opts: {
  code: string;
  port: number;
  query: string;
  timeoutMs: number;
}): Promise<Served> {
  const logs: string[] = [];
  let resolveDone!: (r: BenchReport) => void;
  let rejectDone!: (e: Error) => void;
  const done = new Promise<BenchReport>((res, rej) => {
    resolveDone = res;
    rejectDone = rej;
  });
  const timer = setTimeout(
    () => rejectDone(new Error(`browser run timed out after ${opts.timeoutMs} ms`)),
    opts.timeoutMs,
  );

  const server = createServer((req, res) => {
    const send = (status: number, body: string, type = 'text/plain; charset=utf-8'): void => {
      res.writeHead(status, {
        'content-type': type,
        // ADR-0010: cross-origin isolation, required for SharedArrayBuffer.
        'cross-origin-opener-policy': 'same-origin',
        'cross-origin-embedder-policy': 'require-corp',
        'cache-control': 'no-store',
      });
      res.end(body);
    };
    if (req.method === 'GET' && (req.url === '/' || req.url === '/index.html')) {
      send(200, PAGE, 'text/html; charset=utf-8');
      return;
    }
    if (req.method === 'GET' && req.url?.startsWith('/bench.js')) {
      send(200, opts.code, 'text/javascript; charset=utf-8');
      return;
    }
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      if (req.url === '/log') {
        logs.push(body);
        process.stdout.write(`  [page] ${body}\n`);
        send(200, 'ok');
        return;
      }
      if (req.url === '/report') {
        clearTimeout(timer);
        try {
          resolveDone(JSON.parse(body) as BenchReport);
        } catch (err) {
          rejectDone(err as Error);
        }
        send(200, 'ok');
        return;
      }
      if (req.url === '/error') {
        clearTimeout(timer);
        rejectDone(new Error(`page reported an error: ${body}`));
        send(200, 'ok');
        return;
      }
      send(404, 'not found');
    });
  });

  await new Promise<void>((res) => server.listen(opts.port, '127.0.0.1', res));
  const address = server.address() as AddressInfo;
  return {
    server,
    port: address.port,
    url: `http://127.0.0.1:${address.port}/?${opts.query}`,
    done,
    logs,
    close: () => {
      clearTimeout(timer);
      server.close();
    },
  };
}

/** Look for a Chromium/Chrome executable in the usual places. */
export function findBrowser(explicit?: string): string | null {
  if (explicit) return existsSync(explicit) ? explicit : null;
  const fromEnv = process.env['WNX_BROWSER'] ?? process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH'];
  if (fromEnv && existsSync(fromEnv)) return fromEnv;
  const candidates = [
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/snap/bin/chromium',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  ];
  for (const c of candidates) if (existsSync(c)) return c;
  // playwright's own download cache, if `npx playwright install chromium` ran.
  const cache =
    process.env['PLAYWRIGHT_BROWSERS_PATH'] ?? `${process.env['HOME'] ?? ''}/.cache/ms-playwright`;
  if (cache && existsSync(cache)) {
    for (const dir of readdirSync(cache).filter((d) => d.startsWith('chromium'))) {
      for (const rel of [
        'chrome-linux/chrome',
        'chrome-linux64/chrome',
        'chrome-linux/headless_shell',
        'chrome-headless-shell-linux64/chrome-headless-shell',
        'chrome-mac/Chromium.app/Contents/MacOS/Chromium',
      ]) {
        const p = `${cache}/${dir}/${rel}`;
        if (existsSync(p)) return p;
      }
    }
  }
  return null;
}

/**
 * Bundle, serve and drive the suites in a browser, returning the report the page
 * produced. Throws with an actionable message when no browser is available.
 */
export async function runInBrowser(opts: BrowserRunOptions): Promise<BenchReport> {
  const executablePath = findBrowser(opts.browserPath);
  if (!executablePath) {
    throw new Error(
      [
        'no Chromium/Chrome executable found.',
        '  install one with: npx playwright install chromium',
        '  or point at an existing binary: WNX_BROWSER=/path/to/chrome npm run bench:browser',
        'the same suites run without a browser via: npm run bench -- --all',
      ].join('\n'),
    );
  }

  const { code, bytes } = await bundleEntry();
  process.stdout.write(`bundled browser entry (${(bytes / 1024).toFixed(0)} KiB) with esbuild\n`);

  const query = new URLSearchParams({
    suites: opts.suites.join(','),
    reps: String(opts.reps ?? 5),
    scale: String(opts.scale ?? 1),
  }).toString();
  const served = await serveBundle({
    code,
    port: opts.port ?? 0,
    query,
    timeoutMs: opts.timeoutMs ?? 20 * 60_000,
  });

  const { chromium } = await import('playwright-core');
  const browser = await chromium.launch({
    executablePath,
    headless: opts.headless ?? true,
    args: [
      // Cross-origin isolation is set by response headers; these flags make the
      // measurement representative of a shipped PWA rather than a bare tab.
      '--enable-features=SharedArrayBuffer,WebAssemblyGC',
      '--enable-unsafe-swiftshader',
      '--use-gl=swiftshader',
      '--no-sandbox',
    ],
  });
  try {
    const page = await browser.newPage();
    page.on('console', (msg) => process.stdout.write(`  [console.${msg.type()}] ${msg.text()}\n`));
    page.on('pageerror', (err) => process.stdout.write(`  [pageerror] ${err.message}\n`));
    process.stdout.write(`launching ${executablePath}\nloading ${served.url}\n`);
    await page.goto(served.url, { waitUntil: 'load', timeout: 60_000 });
    const isolated = await page.evaluate('crossOriginIsolated');
    process.stdout.write(`crossOriginIsolated: ${String(isolated)}\n`);
    return await served.done;
  } finally {
    await browser.close();
    served.close();
  }
}
