// Spike E: User-space TCP/IP frame ring + relay / Direct Sockets adapter

export class SpscPacketRing {
  constructor(slotCount = 256, slotSize = 2048) {
    this.slotCount = slotCount;
    this.slotSize = slotSize;
    // Header: [head (4B), tail (4B)]
    this.sab = new SharedArrayBuffer(8 + slotCount * slotSize);
    this.ctrl = new Int32Array(this.sab, 0, 2);
    this.data = new Uint8Array(this.sab, 8);
  }

  enqueue(packet) {
    const head = Atomics.load(this.ctrl, 0);
    const tail = Atomics.load(this.ctrl, 1);
    const nextHead = (head + 1) % this.slotCount;
    if (nextHead === tail) return false; // full

    const offset = head * this.slotSize;
    const len = Math.min(packet.byteLength, this.slotSize - 2);
    this.data[offset] = len & 0xff;
    this.data[offset + 1] = (len >> 8) & 0xff;
    this.data.set(packet.subarray(0, len), offset + 2);

    Atomics.store(this.ctrl, 0, nextHead);
    return true;
  }

  dequeue() {
    const head = Atomics.load(this.ctrl, 0);
    const tail = Atomics.load(this.ctrl, 1);
    if (head === tail) return null; // empty

    const offset = tail * this.slotSize;
    const len = this.data[offset] | (this.data[offset + 1] << 8);
    const packet = this.data.slice(offset + 2, offset + 2 + len);

    Atomics.store(this.ctrl, 1, (tail + 1) % this.slotCount);
    return packet;
  }
}

export function detectNetworkTier(globalObj = globalThis) {
  if (typeof globalObj.TCPSocket === "function" || typeof globalObj.UDPSocket === "function") {
    return "direct-sockets-iwa";
  }
  return "userspace-tcpip-relay";
}
