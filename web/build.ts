/** Build the browser demo, not a complete WasmNUX distribution. */
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
await copyFile(new URL('./index.html', import.meta.url), `${output}index.html`);
console.log(`Browser demo built in ${output}`);
