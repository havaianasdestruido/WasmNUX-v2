/**
 * Cross-origin isolation for hosts that cannot set response headers (ADR-0010 §2).
 *
 * GitHub Pages serves static files and offers no way to add
 * `Cross-Origin-Opener-Policy` / `Cross-Origin-Embedder-Policy`, so a document
 * served from it is not cross-origin isolated: no `SharedArrayBuffer`, no Wasm
 * atomics, no shared guest RAM (ADR-0004). This worker is the fallback the ADR
 * commits to — every same-origin response is re-headed on its way out, which
 * makes `crossOriginIsolated === true` after one reload.
 *
 * `web/index.html` registers it and reloads once. It costs that extra
 * navigation on first load and is deliberately *not* a performance path.
 *
 * Only same-origin responses are touched. Cross-origin subresources must carry
 * their own `Cross-Origin-Resource-Policy` or CORS, which is the embedder's
 * obligation under `require-corp` and not something a worker can invent.
 */

const COOP = 'same-origin';
const COEP = 'require-corp';
const CORP = 'same-origin';

self.addEventListener('install', () => {
  // Do not wait for every tab to close: the page needs this worker now.
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  // Take over the documents that are already open, so the reload the page
  // performs next is served through this handler.
  event.waitUntil(self.clients.claim());
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (new URL(request.url).origin !== self.location.origin) return;
  // A navigation-ish request in `only-if-cached` mode must stay same-origin, or
  // the browser rejects the response before we ever see it.
  if (request.cache === 'only-if-cached' && request.mode !== 'same-origin') return;

  event.respondWith(
    fetch(request).then((response) => {
      // Opaque responses (status 0) have no readable headers and cannot be
      // re-headed; leave them alone rather than breaking the load.
      if (response.status === 0) return response;

      const headers = new Headers(response.headers);
      headers.set('Cross-Origin-Opener-Policy', COOP);
      headers.set('Cross-Origin-Embedder-Policy', COEP);
      headers.set('Cross-Origin-Resource-Policy', CORP);
      return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers,
      });
    }),
  );
});
