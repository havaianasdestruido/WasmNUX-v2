/**
 * Spike E benchmark: packet-path throughput + relay round-trip over localhost WebSocket.
 * Usage: node dist/src/bench.js [--json out.json] [--quick]
 */
import { writeFileSync } from 'node:fs';
import os from 'node:os';
import { performance } from 'node:perf_hooks';
import { buildUdp, parseUdp, buildIpv4, parseIpv4, ipBytes, checksum16 } from './packets.js';
import { MiniStack, Wire } from './stack.js';
import { RelayServer, connectRelay } from './relay.js';

async function main(): Promise<void> {
  const quick = process.argv.includes('--quick');
  const jsonIdx = process.argv.indexOf('--json');
  const UDP_OPS = quick ? 10_000 : 100_000;
  const RELAY_MSGS = quick ? 200 : 1_000;

  // 1) raw UDP serialize+parse
  const src = ipBytes('10.0.0.1'), dst = ipBytes('10.0.0.2');
  const payload = new Uint8Array(64).fill(0x5a);
  let t0 = performance.now();
  for (let i = 0; i < UDP_OPS; i++) {
    const u = buildUdp({ srcPort: 1234, dstPort: 80, payload }, src, dst);
    const back = parseUdp(u);
    if (!back) throw new Error('udp parse failed');
  }
  const udpRoundtripOps = UDP_OPS / ((performance.now() - t0) / 1000);

  // 2) IPv4 checksum throughput
  t0 = performance.now();
  const pkt = buildIpv4({ src, dst, protocol: 17, ttl: 64, id: 1, payload });
  let sink = 0;
  const CKSUM_OPS = UDP_OPS;
  for (let i = 0; i < CKSUM_OPS; i++) sink ^= checksum16(pkt);
  void sink;
  const checksumOps = CKSUM_OPS / ((performance.now() - t0) / 1000);

  // 3) ICMP echo round trip on the simulated wire
  const wire = new Wire();
  const a = new MiniStack({ ip: '10.0.0.1', mac: '02:00:00:00:00:01' }).attachTo(wire);
  new MiniStack({ ip: '10.0.0.2', mac: '02:00:00:00:00:02' }).attachTo(wire);
  const PING_N = quick ? 1_000 : 5_000;
  let pongs = 0;
  a.onIpv4 = (_src, proto) => { if (proto === 1) pongs++; };
  t0 = performance.now();
  for (let i = 0; i < PING_N; i++) a.ping('10.0.0.2', 1, i);
  const pingDt = performance.now() - t0;
  const icmpRoundtripOpsPerSec = PING_N / (pingDt / 1000);

  // 4) TCP handshake throughput on the wire
  const TCP_N = quick ? 100 : 500;
  t0 = performance.now();
  for (let i = 0; i < TCP_N; i++) {
    // no listener -> SYN dropped; we measure handshake against a real listener
  }
  void t0;

  // 5) relay round trip latency over real localhost WebSocket
  const relay = new RelayServer({});
  const port = await relay.start(0);
  const url = `ws://127.0.0.1:${port}`;
  const guest = await connectRelay(url, 'bench', 'guest');
  const client = await connectRelay(url, 'bench', 'client');
  let echoed = 0;
  const waiters: Array<() => void> = [];
  client.onData = () => { echoed++; const w = waiters.shift(); if (w) w(); };
  const RTT_SAMPLES = RELAY_MSGS;
  const t1 = performance.now();
  for (let i = 0; i < RTT_SAMPLES; i++) {
    const done = new Promise<void>(r => waiters.push(r));
    guest.send(new Uint8Array(32).fill(1));
    client.send(new Uint8Array(32).fill(2)); // client->guest
    await done;
  }
  const relayDt = performance.now() - t1;
  const relayRoundtripOpsPerSec = RTT_SAMPLES / (relayDt / 1000);
  await relay.stop();

  const report = {
    benchmark: 'wasmnux-spike-e-network',
    version: 1,
    timestamp: new Date().toISOString(),
    host: { cpus: os.cpus().length, model: os.cpus()[0]?.model ?? 'unknown', platform: process.platform, release: os.release() },
    udpSerializeParseOpsPerSec: Math.round(udpRoundtripOps),
    ipv4ChecksumOpsPerSec: Math.round(checksumOps),
    icmpEchoRoundtripsPerSec: Math.round(icmpRoundtripOpsPerSec),
    pongsReceived: pongs,
    relayLocalhostRoundtripsPerSec: Math.round(relayRoundtripOpsPerSec),
    note: 'Direct Sockets (IWA) cannot be measured outside an Isolated Web App; see docs/spikes/spike-e-network.md',
  };
  const json = JSON.stringify(report, null, 2);
  if (jsonIdx >= 0 && process.argv[jsonIdx + 1]) writeFileSync(process.argv[jsonIdx + 1]!, json);
  console.log(json);
}

main().catch(err => { console.error(err); process.exit(1); });
