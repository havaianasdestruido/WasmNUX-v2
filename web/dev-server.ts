/**
 * Dev server for the browser demo (`npm run serve`).
 *
 * It exists for two reasons that a plain static file server does not serve:
 *
 *  1. **Cross-origin isolation.** `SharedArrayBuffer` — and therefore shared
 *     guest RAM, Wasm atomics and every SMP plan in ADR-0004 — only exists in a
 *     document served with COOP/COEP (ADR-0010). Opening `web/index.html` from
 *     disk silently degrades to a single-hart, non-atomic configuration, which
 *     is the worst possible way to discover that. The `coi-serviceworker.js`
 *     route below keeps the same page working on hosts that cannot set those
 *     headers (GitHub Pages, `.github/workflows/pages.yml`), by re-heading
 *     responses from a worker instead.
 *  2. **TypeScript, unbundled-on-disk.** `core/src` is imported with `.ts`
 *     extensions and never compiled to `dist/`, so the page needs a bundler in
 *     front of it. esbuild is already a devDependency (the benchmark browser
 *     runner uses it) and does the job in tens of milliseconds.
 *
 * Binds 0.0.0.0 so it works behind a proxy or in a container preview.
 */

import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { readFileSync, statSync } from 'node:fs';
import { build } from 'esbuild';

const HERE = dirname(fileURLToPath(import.meta.url));
const ENTRY = resolve(HERE, 'main.ts');
const PAGE = resolve(HERE, 'index.html');
const COI_WORKER = resolve(HERE, 'coi-serviceworker.js');
const PORT = Number(process.env['PORT'] ?? 8080);
const HOST = process.env['HOST'] ?? '0.0.0.0';

/**
 * Bundle the demo entry point.
 *
 * `platform: 'browser'` is the point: `core/src` is forbidden from importing
 * `node:*` (see CONTRIBUTING.md) precisely so this bundle can exist, and an
 * unresolved Node specifier here is that rule being broken. Let it fail loudly.
 */
async function bundle(): Promise<{ code: string; inputs: string[]; at: number }> {
  const result = await build({
    entryPoints: [ENTRY],
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: 'es2022',
    write: false,
    sourcemap: 'inline',
    metafile: true,
    logLevel: 'warning',
  });
  const code = result.outputFiles?.[0]?.text;
  if (!code) throw new Error('esbuild produced no output');
  return { code, inputs: Object.keys(result.metafile?.inputs ?? {}), at: Date.now() };
}

let built = await bundle();
process.stdout.write(
  `bundled ${ENTRY} (${(built.code.length / 1024).toFixed(0)} KiB, ${built.inputs.length} inputs)\n`,
);

/** True when any file that went into the current bundle changed since it was built. */
function stale(): boolean {
  for (const rel of built.inputs) {
    try {
      if (statSync(resolve(HERE, '..', rel)).mtimeMs > built.at) return true;
    } catch {
      return true; // a deleted input is definitely stale
    }
  }
  return false;
}

const server = createServer((req, res) => {
  const url = (req.url ?? '/').split('?')[0]!;
  const send = (status: number, body: string | Uint8Array, type: string): void => {
    res.writeHead(status, {
      'content-type': type,
      // ADR-0010: required for crossOriginIsolated === true.
      'cross-origin-opener-policy': 'same-origin',
      'cross-origin-embedder-policy': 'require-corp',
      'cross-origin-resource-policy': 'same-origin',
      'cache-control': 'no-store',
    });
    res.end(body);
  };

  if (url === '/' || url === '/index.html') {
    send(200, readFileSync(PAGE), 'text/html; charset=utf-8');
    return;
  }
  if (url === '/main.js') {
    // Rebuild when a source file changed, so editing core/ and reloading the
    // page is the whole workflow.
    const serve = (): void => send(200, built.code, 'text/javascript; charset=utf-8');
    if (!stale()) {
      serve();
      return;
    }
    const t0 = Date.now();
    bundle()
      .then((next) => {
        built = next;
        process.stdout.write(
          `rebuilt in ${Date.now() - t0} ms (${(next.code.length / 1024).toFixed(0)} KiB)\n`,
        );
        serve();
      })
      .catch((err: unknown) => {
        // Keep serving the last good bundle and say why, so a syntax error
        // shows up in the terminal instead of as a blank page.
        process.stdout.write(`rebuild failed, serving previous bundle: ${String(err)}\n`);
        send(500, `// build failed: ${String(err)}\n`, 'text/javascript; charset=utf-8');
      });
    return;
  }
  if (url === '/coi-serviceworker.js') {
    // Not used here (the headers already isolate the page), but served so that
    // the page behaves the same on a host that cannot set headers.
    send(200, readFileSync(COI_WORKER), 'text/javascript; charset=utf-8');
    return;
  }
  if (url === '/rebuild') {
    bundle()
      .then((next) => {
        built = next;
        send(200, `rebuilt: ${(next.code.length / 1024).toFixed(0)} KiB\n`, 'text/plain; charset=utf-8');
      })
      .catch((err: unknown) => send(500, `build failed: ${String(err)}\n`, 'text/plain; charset=utf-8'));
    return;
  }
  if (url === '/healthz') {
    send(200, 'ok\n', 'text/plain; charset=utf-8');
    return;
  }
  send(404, 'not found\n', 'text/plain; charset=utf-8');
});

server.listen(PORT, HOST, () => {
  process.stdout.write(`WasmNUX demo on http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}/\n`);
  process.stdout.write('  COOP/COEP set, so SharedArrayBuffer and Wasm atomics are available\n');
  process.stdout.write('  editing core/ or web/ and reloading rebuilds automatically\n');
});
