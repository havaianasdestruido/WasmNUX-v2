import { describe, expect, it } from "vitest";
import {
  EchoStack, buildIcmpEcho, buildIpv4, buildUdp, bytesToIp, checksum16,
  ipToBytes, parseIcmpEcho, parseIpv4, parseUdp,
} from "../src/ip.js";
import { DirectSocketPolicy, RelayServer, StreamReassembler, splitStream } from "../src/relay.js";

describe("spike E — checksum & codecs", () => {
  it("RFC 1071 checksum vectors", () => {
    // RFC 1071 §3 example: folded sum of 00 01 f2 03 f4 f5 f6 f7 is 0xddf2,
    // so the Internet checksum (one's complement) is ~0xddf2 = 0x220d.
    expect(checksum16(Uint8Array.from([0x00, 0x01, 0xf2, 0x03, 0xf4, 0xf5, 0xf6, 0xf7]))).toBe(0x220d);
    // Verifying a computed header yields 0
    const ip = buildIpv4({
      src: ipToBytes("10.0.0.1"),
      dst: ipToBytes("10.0.0.2"),
      protocol: 17,
      payload: new Uint8Array(4),
    });
    expect(checksum16(ip.subarray(0, 20))).toBe(0);
  });

  it("IPv4 roundtrip preserves addresses and header checksum", () => {
    const pkt = buildIpv4({
      src: ipToBytes("192.168.1.10"),
      dst: ipToBytes("8.8.8.8"),
      protocol: 1,
      payload: new Uint8Array([8, 0, 0, 0, 0, 1, 0, 1]),
    });
    const p = parseIpv4(pkt);
    expect(bytesToIp(p.src)).toBe("192.168.1.10");
    expect(bytesToIp(p.dst)).toBe("8.8.8.8");
    expect(p.protocol).toBe(1);
    expect(p.headerChecksumOk).toBe(true);
    expect(p.payload).toEqual(Uint8Array.from([8, 0, 0, 0, 0, 1, 0, 1]));
  });

  it("rejects bad addresses and non-IPv4 input", () => {
    expect(() => ipToBytes("1.2.3")).toThrow(/bad IPv4/);
    expect(() => ipToBytes("1.2.3.999")).toThrow(/bad IPv4/);
    const v6 = new Uint8Array(20);
    v6[0] = 0x60; // IPv6 version nibble in a full-size packet
    expect(() => parseIpv4(v6)).toThrow(/not IPv4/);
    expect(() => parseIpv4(new Uint8Array(8))).toThrow(/short/);
  });

  it("UDP checksum validates with pseudo-header", () => {
    const src = ipToBytes("172.16.0.2");
    const dst = ipToBytes("172.16.0.1");
    const udp = buildUdp({ srcPort: 50000, dstPort: 7, payload: new TextEncoder().encode("ping") }, src, dst);
    const parsed = parseUdp(udp);
    expect(parsed.srcPort).toBe(50000);
    expect(parsed.dstPort).toBe(7);
    expect(new TextDecoder().decode(parsed.payload)).toBe("ping");
    expect(parsed.checksumOk(src, dst)).toBe(true);
    // flip a payload byte → checksum fails
    udp[8] ^= 0xff;
    expect(parseUdp(udp).checksumOk(src, dst)).toBe(false);
  });

  it("ICMP echo request ↔ reply", () => {
    const req = buildIcmpEcho(0x1234, 7, new TextEncoder().encode("wnx"));
    const parsed = parseIcmpEcho(req);
    expect(parsed.type).toBe(8);
    expect(parsed.id).toBe(0x1234);
    expect(parsed.seq).toBe(7);
    expect(parsed.checksumOk).toBe(true);

    const stack = new EchoStack(ipToBytes("10.0.0.1"));
    const raw = buildIpv4({
      src: ipToBytes("10.0.0.2"),
      dst: ipToBytes("10.0.0.1"),
      protocol: 1,
      payload: req,
    });
    stack.handle(raw);
    expect(stack.icmpReplies).toHaveLength(1);
    const reply = parseIpv4(stack.icmpReplies[0]!);
    expect(bytesToIp(reply.src)).toBe("10.0.0.1");
    const icmp = parseIcmpEcho(reply.payload);
    expect(icmp.type).toBe(0); // echo reply
    expect(icmp.seq).toBe(7);
    expect(icmp.checksumOk).toBe(true);
  });

  it("UDP echo server answers on port 7", () => {
    const stack = new EchoStack(ipToBytes("10.0.0.1"));
    const req = buildIpv4({
      src: ipToBytes("10.0.0.2"),
      dst: ipToBytes("10.0.0.1"),
      protocol: 17,
      payload: buildUdp({ srcPort: 40000, dstPort: 7, payload: Uint8Array.of(1, 2, 3) }, ipToBytes("10.0.0.2"), ipToBytes("10.0.0.1")),
    });
    stack.handle(req);
    expect(stack.udpReplies).toHaveLength(1);
    const resp = parseIpv4(stack.udpReplies[0]!);
    const udp = parseUdp(resp.payload);
    expect(udp.srcPort).toBe(7);
    expect(udp.dstPort).toBe(40000);
    expect([...udp.payload]).toEqual([1, 2, 3]);
    expect(udp.checksumOk(ipToBytes("10.0.0.1"), ipToBytes("10.0.0.2"))).toBe(true);
  });
});

describe("spike E — relay routing & streams", () => {
  it("routes datagrams between peers and drops unknown targets", () => {
    const relay = new RelayServer();
    const inbox: Array<[string, Uint8Array]> = [];
    relay.register("guest", (_from, f) => { if (f.payload) inbox.push(["guest", f.payload]); });
    expect(relay.send("net-worker", "guest", { kind: "datagram", payload: Uint8Array.of(9) })).toBe(true);
    expect(relay.send("ghost", "nobody", { kind: "datagram", payload: Uint8Array.of(1) })).toBe(false);
    expect(inbox).toEqual([["guest", Uint8Array.of(9)]]);
    expect(relay.stats()).toMatchObject({ routed: 1, dropped: 1, peers: 1 });
  });

  it("splits and reassembles streams in order", () => {
    const payload = Uint8Array.from({ length: 1000 }, (_, i) => i & 0xff);
    const frames = splitStream(payload, 64);
    expect(frames.length).toBe(Math.ceil(1000 / 64));
    expect(frames.at(-1)!.fin).toBe(true);
    const rx = new StreamReassembler();
    let out: Uint8Array | null = null;
    for (const f of frames) out = rx.push(f) ?? out;
    expect(out).toEqual(payload);
    expect(rx.completed).toEqual(payload);
  });

  it("detects out-of-order stream frames", () => {
    const rx = new StreamReassembler();
    rx.push({ kind: "stream", seq: 0, payload: Uint8Array.of(1) });
    expect(() => rx.push({ kind: "stream", seq: 2, payload: Uint8Array.of(3) }))
      .toThrow(/out-of-order/);
  });

  it("binds inbound-forward ports without collisions", () => {
    const relay = new RelayServer();
    relay.register("guest", () => {});
    const p1 = relay.bindPort("guest");
    const p2 = relay.bindPort("guest");
    expect(p1).not.toBe(p2);
    expect(relay.bindPort("guest", 8080)).toBe(8080);
    expect(relay.resolvePort(8080)).toBe("guest");
    relay.register("guest2", () => {});
    expect(() => relay.bindPort("guest2", 8080)).toThrow(/already bound/);
    relay.unregister("guest");
    expect(relay.resolvePort(8080)).toBeNull();
  });

  it("Direct Sockets are IWA-only with a clear degradation message", () => {
    const iwa = new DirectSocketPolicy(true);
    const web = new DirectSocketPolicy(false);
    expect(iwa.canListenTcp() && iwa.canUdp()).toBe(true);
    expect(web.canListenTcp() || web.canUdp()).toBe(false);
    expect(web.degradeReason()).toMatch(/Isolated Web App/);
    expect(iwa.degradeReason()).toBeNull();
  });
});
