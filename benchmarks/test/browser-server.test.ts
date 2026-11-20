import { describe, expect, it } from 'vitest';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { serveBundle } from '../src/browser.ts';

describe('browser benchmark server', () => {
  it('serves the benchmark page with query parameters and accepts its report', async () => {
    const served = await serveBundle({
      code: 'console.log(1)',
      port: 0,
      query: 'suites=wasm&reps=1',
      timeoutMs: 10000,
    });
    try {
      const page = await fetch(served.url);
      expect(page.status).toBe(200);
      expect(page.headers.get('cross-origin-opener-policy')).toBe('same-origin');
      expect(await page.text()).toContain('/bench.js');
      const response = await fetch(new URL('/report', served.url), {
        method: 'POST',
        body: JSON.stringify({ version: 1 }),
      });
      expect(response.status).toBe(200);
      expect((await served.done).version).toBe(1);
    } finally {
      served.close();
    }
  });
  it('rejects cleanly when the selected port is occupied', async () => {
    const existing = createServer();
    await new Promise<void>((resolve) => existing.listen(0, '127.0.0.1', resolve));
    try {
      const port = (existing.address() as AddressInfo).port;
      await expect(serveBundle({ code: '', port, query: '', timeoutMs: 10000 })).rejects.toMatchObject({
        code: 'EADDRINUSE',
      });
    } finally {
      await new Promise<void>((resolve) => existing.close(() => resolve()));
    }
  });
});
