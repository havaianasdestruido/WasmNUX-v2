/**
 * The service-worker fallback is what makes the deployed demo isolated, so its
 * two rules are asserted here rather than discovered on the live site:
 *
 *  1. a same-origin response comes back with COOP/COEP (and CORP, so it can
 *     itself be embedded under `require-corp`);
 *  2. a cross-origin response is left untouched — re-heading one is impossible
 *     for an opaque body and would break the load.
 *
 * The worker is plain script (no imports) run against a fake `self`, which is
 * the closest thing to a service worker that Node can offer. Chromium's own
 * behaviour is covered by `web/test/browser.ts`, but only against a server that
 * already sets the headers.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFile } from 'node:fs/promises';

const ORIGIN = 'https://havaianasdestruido.github.io';

interface FetchEvent {
  request: Request;
  respondWith(response: Promise<Response>): void;
  waitUntil?(promise: Promise<unknown>): void;
}

type Handler = (event: FetchEvent) => void;

/** Evaluate the worker script against a fake `self` and return its listeners. */
async function boot(): Promise<Map<string, Handler>> {
  const source = await readFile(new URL('../coi-serviceworker.js', import.meta.url), 'utf8');
  const handlers = new Map<string, Handler>();
  const scope = {
    location: { origin: ORIGIN },
    addEventListener: (type: string, handler: Handler): void => void handlers.set(type, handler),
    skipWaiting: (): void => {},
    clients: { claim: (): Promise<void> => Promise.resolve() },
  };
  new Function('self', source)(scope);
  return handlers;
}

/** Fire a `fetch` event and return what the worker passed to `respondWith`. */
function dispatch(handlers: Map<string, Handler>, request: Request): Promise<Response> | undefined {
  const handler = handlers.get('fetch');
  if (!handler) throw new Error('worker registered no fetch handler');
  let responded: Promise<Response> | undefined;
  handler({ request, respondWith: (response) => void (responded = response) });
  return responded;
}

afterEach(() => vi.unstubAllGlobals());

describe('coi-serviceworker', () => {
  it('adds COOP, COEP and CORP to a same-origin response and keeps the body', async () => {
    vi.stubGlobal('fetch', async () => {
      return new Response('<!doctype html>demo', {
        status: 200,
        headers: { 'content-type': 'text/html; charset=utf-8' },
      });
    });
    const handlers = await boot();
    const responded = dispatch(handlers, new Request(`${ORIGIN}/WasmNUX-v2/index.html`));
    expect(responded).toBeDefined();
    const response = (await responded)!;
    expect(response.status).toBe(200);
    expect(response.headers.get('cross-origin-opener-policy')).toBe('same-origin');
    expect(response.headers.get('cross-origin-embedder-policy')).toBe('require-corp');
    expect(response.headers.get('cross-origin-resource-policy')).toBe('same-origin');
    expect(response.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(await response.text()).toBe('<!doctype html>demo');
  });

  it('does not touch a cross-origin response, which COEP leaves to its server', async () => {
    const handlers = await boot();
    expect(dispatch(handlers, new Request('https://example.com/widget.js'))).toBeUndefined();
  });
});
