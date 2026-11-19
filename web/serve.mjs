#!/usr/bin/env node
/**
 * Dev server for the Phase 0 probe page with COOP/COEP headers (ADR-0010).
 * Usage: node web/serve.mjs [port]   (defaults 8080, binds 0.0.0.0)
 */
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL(".", import.meta.url));
const port = Number(process.argv[2] ?? 8080);

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json",
  ".css": "text/css",
  ".map": "application/json",
  ".wasm": "application/wasm",
};

const server = createServer(async (req, res) => {
  try {
    let p = decodeURIComponent(new URL(req.url, "http://x").pathname);
    if (p === "/") p = "/index.html";
    const abs = normalize(join(root, p));
    if (!abs.startsWith(root.endsWith(sep) ? root : root + sep)) {
      res.writeHead(403).end("forbidden");
      return;
    }
    const body = await readFile(abs);
    res.writeHead(200, {
      "Content-Type": MIME[extname(abs)] ?? "application/octet-stream",
      // ADR-0010: cross-origin isolation for SharedArrayBuffer
      "Cross-Origin-Opener-Policy": "same-origin",
      "Cross-Origin-Embedder-Policy": "require-corp",
      "Cache-Control": "no-store",
    });
    res.end(body);
  } catch {
    res.writeHead(404).end("not found");
  }
});

server.listen(port, "0.0.0.0", () => {
  console.log(`WasmNUX probe server on http://0.0.0.0:${port} (COOP/COEP enabled)`);
});
