import {WebSocketServer, WebSocket} from 'ws';

// Test-only packet switch. Exactly two peers under one unguessable case ID;
// no DNS, native socket egress, or arbitrary destinations.
export function attachRelay(server) {
  const wss = new WebSocketServer({noServer:true, maxPayload:1600, perMessageDeflate:false});
  const rooms = new Map();
  server.on('upgrade', (req, socket, head) => {
    const match = req.url?.match(/^\/relay\/([\da-f-]{36})$/);
    if (!match || req.headers.origin !== `http://127.0.0.1:${socket.localPort}`) {
      socket.destroy(); return;
    }
    const key = match[1];
    const room = rooms.get(key) || new Set();
    if (room.size >= 2 || (!rooms.has(key) && rooms.size >= 16)) { socket.destroy(); return; }
    wss.handleUpgrade(req, socket, head, peer => {
      rooms.set(key, room); room.add(peer);
      peer.on('error', () => peer.terminate());
      peer.on('close', () => { room.delete(peer); if (!room.size) rooms.delete(key); });
      peer.on('message', (frame, binary) => {
        if (!binary || !frame.length) { peer.close(1003, 'binary packet required'); return; }
        for (const other of room) if (other !== peer && other.readyState === WebSocket.OPEN) {
          if (other.bufferedAmount > 1024**2) { other.close(1009, 'backpressure'); continue; }
          other.send(frame, {binary:true});
        }
      });
    });
  });
  return () => { for (const peer of wss.clients) peer.terminate(); wss.close(); };
}
