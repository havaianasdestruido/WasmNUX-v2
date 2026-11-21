/**
 * Build the browser demo, not a complete WasmNUX distribution.
 *
 * The output in `dist/web` is a static site: no server, no configuration, and
 * every asset referenced relatively (`./main.js`, not `/main.js`), so the same
 * build works from an origin root and from a project path such as
 * `https://<user>.github.io/WasmNUX-v2/`. `.github/workflows/pages.yml`
 * publishes exactly this directory.
 *
 * Cross-origin isolation — which `SharedArrayBuffer` and Wasm atomics need
 * (ADR-0004, ADR-0010) — comes from COOP/COEP. A static host cannot send those
 * headers, so `coi-serviceworker.js` is shipped beside the page and adds them
 * at fetch time; `index.html` registers it and reloads once.
 */
import { mkdir, copyFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const output = fileURLToPath(new URL('../dist/web/', import.meta.url));
await mkdir(output, { recursive: true });
await build({
  entryPoints: [fileURLToPath(new URL('./main.ts', import.meta.url))],
  outfile: `${output}main.js`,
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: 'es2022',
});

// Static assets copied verbatim. `.nojekyll` asks GitHub Pages not to run
// Jekyll over the output; `coi-serviceworker.js` is the header fallback.
for (const asset of ['index.html', 'coi-serviceworker.js', '.nojekyll']) {
  await copyFile(new URL(`./${asset}`, import.meta.url), `${output}${asset}`);
}

console.log(`Browser demo built in ${output}`);

await build({
  entryPoints: [fileURLToPath(new URL('../host/src/workers/hart.ts', import.meta.url))],
  outfile: `${output}hart.js`,
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: 'es2022',
});
