import {createServer} from 'node:http';
import {createServer as createTcp} from 'node:net';
import {createSocket} from 'node:dgram';
import {readFile} from 'node:fs/promises';
import {once} from 'node:events';
import {pathToFileURL} from 'node:url';
const local = '127.0.0.1';
const manifest = ['manifest.webmanifest','application/manifest+json'];
const files = {'/':['index.html','text/html'], '/direct.mjs':['direct.mjs','text/javascript'],
  '/.well-known/manifest.webmanifest':manifest, '/icon.png':['icon.png','image/png']};
export async function startIwaFixture(httpPort = 18996, echoPort = 18997) {
  const sockets = new Set();
  const tcp = createTcp(socket => {
    sockets.add(socket); socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => socket.destroy()); socket.pipe(socket);
  });
  const udp = createSocket('udp4');
  udp.on('message', (bytes, remote) => udp.send(bytes, remote.port, remote.address, () => {}));
  const http = createServer(async (request, response) => {
    const file = Object.hasOwn(files, request.url) && files[request.url];
    if (!file) { response.writeHead(404).end(); return; }
    try {
      const data = await readFile(new URL(file[0], import.meta.url));
      response.writeHead(200, {'Content-Type':file[1], 'Cross-Origin-Opener-Policy':'same-origin',
        'Cross-Origin-Embedder-Policy':'require-corp', 'Content-Security-Policy':"default-src 'self'; object-src 'none'"});
      response.end(data);
    } catch { response.writeHead(500).end(); }
  });
  async function close() {
    for (const socket of sockets) socket.destroy();
    await Promise.all([
      new Promise(resolve => http.close(resolve)), new Promise(resolve => tcp.close(resolve)),
      new Promise(resolve => { try { udp.close(resolve); } catch { resolve(); } })
    ]);
  }
  try {
    tcp.listen(echoPort, local); await once(tcp, 'listening');
    udp.bind(tcp.address().port, local); await once(udp, 'listening');
    http.listen(httpPort, local); await once(http, 'listening');
    return {port:http.address().port, echoPort:tcp.address().port, close};
  } catch (error) { await close(); throw error; }
}
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const fixture = await startIwaFixture();
  console.log(`IWA dev proxy: http://${local}:${fixture.port}`);
}
