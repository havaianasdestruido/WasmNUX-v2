import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checksum16, buildEthernet, parseEthernet, buildIpv4, parseIpv4, buildUdp, parseUdp, buildIcmp, parseIcmp, buildTcp, parseTcp, TCP_FLAG, ipBytes, macBytes, BROADCAST_MAC } from '../src/packets.js';
import { MiniStack, Wire } from '../src/stack.js';
import { RelayServer, connectRelay } from '../src/relay.js';
import { encodeQuery, parseResponse, TYPE } from '../src/dns.js';
import { directSocketsSupport } from '../src/direct-sockets.js';

const A = { ip: '10.0.0.1', mac: '02:00:00:00:00:01' };
const B = { ip: '10.0.0.2', mac: '02:00:00:00:00:02' };

function pair(): { a: MiniStack; b: MiniStack; wire: Wire } {
  const wire = new Wire();
  const a = new MiniStack(A).attachTo(wire);
  const b = new MiniStack(B).attachTo(wire);
  return { a, b, wire };
}

test('checksum16 matches RFC 1071 worked example', () => {
  const data = new Uint8Array([0x00, 0x01, 0xf2, 0x03, 0xf4, 0xf5, 0xf6, 0xf7]);
  assert.equal(checksum16(data), 0x220d); // RFC 1071 worked example
});

test('ethernet/ipv4/udp roundtrip', () => {
  const frame = buildEthernet(BROADCAST_MAC, macBytes(A.mac), 0x0800,
    buildIpv4({ src: ipBytes(A.ip), dst: ipBytes(B.ip), protocol: 17, ttl: 64, id: 1,
      payload: buildUdp({ srcPort: 1234, dstPort: 80, payload: new Uint8Array([1, 2, 3]) }, ipBytes(A.ip), ipBytes(B.ip)) }));
  const eth = parseEthernet(frame)!;
  assert.equal(eth.ethertype, 0x0800);
  const ip = parseIpv4(eth.payload)!;
  assert.equal(ip.protocol, 17);
  const udp = parseUdp(ip.payload)!;
  assert.equal(udp.srcPort, 1234);
  assert.deepEqual([...udp.payload], [1, 2, 3]);
});

test('ARP resolution happens synchronously on the wire', () => {
  const { a, b } = pair();
  const replies: boolean[] = [];
  b.udpListen(9999, () => replies.push(true));
  a.sendUdp(B.ip, 9999, new Uint8Array([42]));
  assert.equal(replies.length, 1);
  assert.ok(a['arpTable'].size > 0, 'ARP table populated');
});

test('ICMP echo request gets a reply', () => {
  const { a, b } = pair();
  const state: { got: { id: number; seq: number } | null } = { got: null };
  a.onIpv4 = (src, proto, payload) => {
    if (proto === 1) {
      const icmp = parseIcmp(payload);
      if (icmp && icmp.type === 0) state.got = { id: icmp.id, seq: icmp.seq };
    }
  };
  a.ping(B.ip, 777, 3);
  assert.ok(state.got);
  assert.equal(state.got!.id, 777);
  assert.equal(state.got!.seq, 3);
});

test('UDP delivery between two stacks', () => {
  const { a, b } = pair();
  const received: Array<{ data: number[]; from: string; port: number }> = [];
  b.udpListen(7000, (data, from, port) => received.push({ data: [...data], from, port }));
  a.sendUdp(B.ip, 7000, new Uint8Array([9, 8, 7, 6]), 5555);
  assert.equal(received.length, 1);
  assert.deepEqual(received[0]!.data, [9, 8, 7, 6]);
  assert.equal(received[0]!.port, 5555);
});

test('TCP three-way handshake + data + close', () => {
  const { a, b } = pair();
  const events: string[] = [];
  b.tcpListen(8080, conn => {
    events.push('accepted');
    conn.onData = (_c, data) => {
      events.push(`data:${new TextDecoder().decode(data)}`);
      conn.send(new Uint8Array([...data].reverse()));
    };
    conn.onClose = () => events.push('server-closed');
  });
  const client = a.tcpConnect(B.ip, 8080);
  client.onData = (_c, data) => events.push(`client-data:${new TextDecoder().decode(data)}`);
  client.onClose = () => events.push('client-closed');
  client.send(new Uint8Array([1, 2, 3, 4]));
  client.close();
  assert.deepEqual(events, ['accepted', 'data:\x01\x02\x03\x04', 'client-data:\x04\x03\x02\x01', 'server-closed', 'client-closed']);
});

test('TCP: server sees connection in established state with expected peer', () => {
  const { a, b } = pair();
  let peer = '';
  b.tcpListen(22, conn => { peer = `${conn.remoteIp}:${conn.remotePort}`; });
  a.tcpConnect(B.ip, 22);
  assert.ok(peer.startsWith('10.0.0.1:'));
});

test('DNS codec: encode query / parse A-record response with compression', () => {
  const q = encodeQuery(0x1234, 'example.com', TYPE.A);
  // hex sanity: starts with id, QDCOUNT=1
  const dv = new DataView(q.buffer);
  assert.equal(dv.getUint16(0, false), 0x1234);
  assert.equal(dv.getUint16(4, false), 1);
  // hand-build a response with a pointer to the qname
  const qname: number[] = [];
  for (const label of ['example', 'com']) qname.push(label.length, ...[...label].map(c => c.charCodeAt(0)));
  qname.push(0);
  const resp = new Uint8Array(12 + qname.length + 4 + 16);
  const rdv = new DataView(resp.buffer);
  rdv.setUint16(0, 0x1234, false); rdv.setUint16(2, 0x8180, false);
  rdv.setUint16(4, 1, false); rdv.setUint16(6, 1, false);
  resp.set(qname, 12);
  rdv.setUint16(12 + qname.length, TYPE.A, false); rdv.setUint16(12 + qname.length + 2, 1, false);
  const ans = 12 + qname.length + 4;
  resp[ans] = 0xc0; resp[ans + 1] = 0x0c; // pointer to qname at 12
  rdv.setUint16(ans + 2, TYPE.A, false); rdv.setUint16(ans + 4, 1, false);
  rdv.setUint32(ans + 6, 300, false); rdv.setUint16(ans + 10, 4, false);
  resp.set([93, 184, 216, 34], ans + 12);
  const parsed = parseResponse(resp);
  assert.equal(parsed.answers.length, 1);
  assert.equal(parsed.answers[0]!.address, '93.184.216.34');
  assert.equal(parsed.answers[0]!.ttl, 300);
});

test('Direct Sockets detection does not crash and reports not-supported in Node', () => {
  const s = directSocketsSupport();
  assert.equal(typeof s.supported, 'boolean');
  assert.equal(s.supported, false);
});

test('relay: guest and client pair up and exchange bytes both ways', async () => {
  const relay = new RelayServer({ token: 'swordfish' });
  const port = await relay.start(0);
  const url = `ws://127.0.0.1:${port}`;
  const guest = await connectRelay(url, 'sess-1', 'guest', 'swordfish');
  const client = await connectRelay(url, 'sess-1', 'client', 'swordfish');
  const received: Uint8Array[] = [];
  guest.onData = d => received.push(d);
  const clientReceived: Uint8Array[] = [];
  client.onData = d => clientReceived.push(d);
  client.send(new Uint8Array([1, 2, 3]));
  guest.send(new Uint8Array([9, 8]));
  await new Promise(r => setTimeout(r, 150));
  assert.deepEqual([...received[0]!], [1, 2, 3]);
  assert.deepEqual([...clientReceived[0]!], [9, 8]);
  await relay.stop();
});

test('relay: wrong token is refused; third joiner on same role is rejected', async () => {
  const relay = new RelayServer({ token: 'right' });
  const port = await relay.start(0);
  const url = `ws://127.0.0.1:${port}`;
  await assert.rejects(connectRelay(url, 's', 'guest', 'wrong'), /refused/);
  await connectRelay(url, 's', 'guest', 'right');
  await assert.rejects(connectRelay(url, 's', 'guest', 'right'), /refused/);
  await relay.stop();
});


test('DNS: cyclic compression pointer does not hang and is rejected', () => {
  // answer NAME is a pointer to its own offset: c0 0c at offset 21 (0x15)
  const msg = new Uint8Array(12 + 9 + 16);
  const dv = new DataView(msg.buffer);
  dv.setUint16(0, 1, false); dv.setUint16(2, 0x8180, false);
  dv.setUint16(4, 1, false); dv.setUint16(6, 1, false);
  dv.setUint16(8, 0, false); dv.setUint16(10, 0, false);
  msg[12] = 0x03; msg.set([97, 98, 99], 13); msg[16] = 0; // qname 'abc'
  dv.setUint16(17, 1, false); dv.setUint16(19, 1, false);
  const ans = 21;
  msg[ans] = 0xc0; msg[ans + 1] = (ans & 0xff); // pointer to itself
  dv.setUint16(ans + 2, 1, false);               // TYPE A
  dv.setUint16(ans + 4, 1, false);               // CLASS IN
  dv.setUint32(ans + 6, 60, false);              // TTL
  dv.setUint16(ans + 10, 4, false);              // RDLENGTH
  msg.set([127, 0, 0, 1], ans + 12);
  assert.throws(() => parseResponse(msg), /cyclic|jumps|bounds/);
});

test('DNS: self-referential qname pointer is rejected', () => {
  // question NAME is a pointer to offset 12 (itself): c0 0c at 12
  const msg = new Uint8Array(12 + 2);
  const dv = new DataView(msg.buffer);
  dv.setUint16(0, 1, false); dv.setUint16(2, 0x8180, false);
  dv.setUint16(4, 1, false); dv.setUint16(6, 0, false);
  msg[12] = 0xc0; msg[13] = 0x0c; // pointer to itself
  assert.throws(() => parseResponse(msg), /cyclic|jumps|bounds/);
});

test('IPv4: payload above 65515 bytes is rejected instead of wrapping', () => {
  const big = new Uint8Array(65_516);
  const src = ipBytes('10.0.0.1'), dst = ipBytes('10.0.0.2');
  assert.throws(() => buildIpv4({ src, dst, protocol: 17, ttl: 64, id: 1, payload: big }), /too large/);
});

test('relay: stop() terminates a socket that never completed the join handshake', async () => {
  const relay = new RelayServer({});
  const port = await relay.start(0);
  const WebSocket = (await import('ws')).default;
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  await new Promise(r => ws.on('open', r));
  // never send a join frame; stop() must terminate it promptly
  const t0 = Date.now();
  await relay.stop();
  assert.ok(Date.now() - t0 < 1000, 'stop() hung on unjoined socket');
});

test('relay: maxBufferedBytes kills a peer that is not draining', async () => {
  const relay = new RelayServer({ maxBufferedBytes: 8 });
  const port = await relay.start(0);
  const url = `ws://127.0.0.1:${port}`;
  const guest = await connectRelay(url, 's', 'guest');
  const client = await connectRelay(url, 's', 'client');
  client.onData = () => { /* never reads fast — butws buffers regardless; simulate by not reading */ };
  // saturate: send more than the limit before the peer drains
  let gotError = false;
  guest.onClose = () => { gotError = true; };
  for (let i = 0; i < 100; i++) client.send(new Uint8Array(1024).fill(1));
  await new Promise(r => setTimeout(r, 300));
  // one of the two sockets should have been closed by the relay
  const closed = guest.readyState === 3 || client.readyState === 3 || gotError;
  assert.ok(closed, 'relay did not enforce maxBufferedBytes');
  await relay.stop();
});
