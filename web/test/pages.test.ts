/**
 * The deployed demo's contract, asserted in Node.
 *
 * GitHub Pages serves `dist/web` from a subpath (`/<repo>/`), sends no
 * COOP/COEP headers and runs Jekyll unless told not to. Each of those is a
 * silent failure at runtime — a 404 for `/main.js`, a page that is quietly not
 * cross-origin isolated, `_`-prefixed files dropped — so they are pinned here
 * instead. `web/test/browser.ts` covers the runtime behaviour once the build
 * exists; this covers the files it is built from.
 */

import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';

const read = (path: string): Promise<string> => readFile(new URL(path, import.meta.url), 'utf8');

describe('GitHub Pages hostability', () => {
  it('references its assets relatively, so a project-page subpath works', async () => {
    const html = await read('../index.html');
    expect(html).toContain('src="./main.js"');
    // `href="https://..."` is fine (external docs); `href="/..."` is not.
    expect(html).not.toMatch(/(?:src|href)="\/(?!\/)/);
  });

  it('registers the cross-origin-isolation worker the host cannot replace', async () => {
    const html = await read('../index.html');
    expect(html).toContain("register('./coi-serviceworker.js')");
    const worker = await read('../coi-serviceworker.js');
    expect(worker).toContain("'Cross-Origin-Opener-Policy'");
    expect(worker).toContain("'Cross-Origin-Embedder-Policy'");
    expect(worker).toContain("'require-corp'");
  });

  it('ships the worker and .nojekyll in the build', async () => {
    const build = await read('../build.ts');
    for (const asset of ['index.html', 'coi-serviceworker.js', '.nojekyll']) {
      expect(build).toContain(`'${asset}'`);
    }
  });
});
