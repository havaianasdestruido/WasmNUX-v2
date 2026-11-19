const host = '127.0.0.1', port = 18997;
const payload = new TextEncoder().encode('wasmnux-direct-sockets');
async function echo(protocol) {
  const start = performance.now();
  const socket = protocol === 'tcp' ? new TCPSocket(host, port) : new UDPSocket({remoteAddress:host, remotePort:port});
  let timer, reader, writer;
  const probe = async () => {
    const {readable, writable} = await socket.opened;
    reader = readable.getReader(); writer = writable.getWriter();
    await writer.write(protocol === 'tcp' ? payload : {data:payload});
    let position = 0;
    while (position < payload.length) {
      const {value, done} = await reader.read();
      const data = protocol === 'tcp' ? value : value?.data;
      if (done || !data?.length || data.length > payload.length - position || data.some((b,i) => b !== payload[position+i])) {
        throw new Error(`${protocol} echo mismatch`);
      }
      position += data.length;
      if (protocol === 'udp' && position !== payload.length) throw new Error('incorrect UDP datagram length');
    }
    return {protocol, bytes:position, elapsedMs:performance.now()-start};
  };
  try {
    return await Promise.race([probe(), new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${protocol} echo timed out`)), 4000);
    })]);
  } finally {
    clearTimeout(timer);
    // A timeout can have an outstanding read, so stop it before unlocking.
    if (reader) { await reader.cancel().catch(() => {}); reader.releaseLock(); }
    if (writer) { await writer.abort().catch(() => {}); writer.releaseLock(); }
    await socket.close().catch(() => {});
  }
}
const status = document.querySelector('pre');
const button = document.querySelector('button');
button.onclick = async () => {
  if (!globalThis.TCPSocket || !globalThis.UDPSocket) { status.textContent = 'Direct Sockets unavailable: install as a development IWA.'; return; }
  button.disabled = true;
  try {
    status.textContent = JSON.stringify(await Promise.all(['tcp','udp'].map(echo)), null, 2);
  } catch (error) { status.textContent = String(error); }
  finally { button.disabled = false; }
};
