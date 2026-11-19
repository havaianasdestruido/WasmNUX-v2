import {createStack} from 'tcpip';
import {serveWorker} from '../worker-rpc.mjs';

function connect(url, tun) {
  const socket = new WebSocket(url);
  socket.binaryType = 'arraybuffer';
  const writer = tun.writable.getWriter();
  const reader = tun.readable.getReader();
  const stats = {sent:0, received:0};
  return new Promise((resolve, reject) => {
    socket.addEventListener('error', () => reject(new Error('relay socket failed')), {once:true});
    socket.addEventListener('open', () => {
      const inbound = new WritableStream({write: frame => writer.write(frame)}).getWriter();
      socket.addEventListener('message', ({data}) => {
        stats.received++;
        inbound.write(new Uint8Array(data)).catch(() => socket.close());
      });
      (async () => {
        while (socket.readyState === WebSocket.OPEN) {
          const {value, done} = await reader.read();
          if (done || socket.readyState !== WebSocket.OPEN) break;
          if (socket.bufferedAmount > 1024**2) throw new Error('relay queue overflow');
          socket.send(value); stats.sent++;
        }
      })().catch(() => socket.close());
      resolve({socket, stats});
    }, {once:true});
  });
}
async function readExactly(reader, dst) {
  for (let at = 0; at < dst.length;) {
    const {value, done} = await reader.read();
    if (done || value.length > dst.length-at) throw new Error('incorrect TCP record length');
    dst.set(value, at); at += value.length;
  }
}
serveWorker(async () => {
  const clientIp = '10.32.0.1', serverIp = '10.32.0.2';
  const [client, server] = await Promise.all([createStack(), createStack()]);
  const tuns = await Promise.all([client.interfaces.createTun({ip:`${clientIp}/24`}), server.interfaces.createTun({ip:`${serverIp}/24`})]);
  const url = new URL(`/relay/${crypto.randomUUID()}`, location.href);
  url.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const sides = await Promise.all(tuns.map(tun => connect(url, tun)));
  try {
    const listen = await server.tcp.listen({host:serverIp, port:8020});
    const packet = Uint8Array.from({length:16*1024}, (_, i) => i % 251);
    const receive = async () => {
      const {value:conn} = await listen[Symbol.asyncIterator]().next();
      const bytes = new Uint8Array(packet.length);
      await readExactly(conn.readable.getReader(), bytes);
      await conn.writable.getWriter().write(bytes);
    };
    const start = performance.now();
    const conn = await client.tcp.connect({host:serverIp, port:8020});
    const connected = performance.now();
    const result = new Uint8Array(packet.length);
    await Promise.all([receive(), conn.writable.getWriter().write(packet), readExactly(conn.readable.getReader(), result)]);
    if (result.some((b,i) => b !== packet[i])) throw new Error('relay payload mismatch');
    return {payloadBytes:packet.length, connectMs:connected-start, echoMs:performance.now()-connected,
      packetCounts:sides.map(side => side.stats), directSocketsExposed:typeof globalThis.TCPSocket === 'function'};
  } finally { for (const {socket} of sides) socket.close(); }
});
