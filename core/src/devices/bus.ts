/**
 * MMIO device model and address-space dispatch.
 *
 * Addresses follow the QEMU `virt` machine so a stock Debian riscv kernel needs
 * no patching (ADR-0001, ADR-0006):
 *
 * | device          | base         | size    |
 * | --------------- | ------------ | ------- |
 * | CLINT           | 0x0200_0000  | 64 KiB  |
 * | PLIC            | 0x0c00_0000  | 64 MiB  |
 * | sifive_test     | 0x0010_0000  | 4 KiB   |
 * | ns16550 UART    | 0x1000_0000  | 4 KiB   |
 * | virtio-mmio     | 0x1000_1000  | 4 KiB×8 |
 *
 * Deliberately simple: a device owns a contiguous range and answers byte-wide
 * reads/writes. That is enough for the spikes, and it is the interface a future
 * Rust core has to match, so the shape is worth pinning down now.
 */

export interface Device {
  readonly name: string;
  readonly base: number;
  readonly size: number;
  /** Read `size` bytes (1, 2 or 4) at `offset` within the device. */
  read(offset: number, size: number): number;
  /** Write `value` (`size` bytes) at `offset` within the device. */
  write(offset: number, size: number, value: number): void;
  /** Called by the machine between instruction chunks. */
  tick?(nowNs: bigint): void;
}

export class DeviceBus {
  private readonly devices: Device[] = [];

  add(device: Device): this {
    for (const d of this.devices) {
      if (device.base < d.base + d.size && d.base < device.base + device.size) {
        throw new Error(`device ${device.name} at 0x${device.base.toString(16)} overlaps ${d.name}`);
      }
    }
    this.devices.push(device);
    this.devices.sort((a, b) => a.base - b.base);
    return this;
  }

  get all(): readonly Device[] {
    return this.devices;
  }

  find(addr: number): { device: Device; offset: number } | null {
    const a = addr >>> 0;
    // Few devices: a linear scan beats a map lookup for MMIO-heavy guests and
    // keeps the code branch-predictable. Revisit if the device count grows.
    for (const device of this.devices) {
      const off = (a - device.base) >>> 0;
      if (off < device.size) return { device, offset: off };
    }
    return null;
  }

  read(addr: number, size: number): number | null {
    const hit = this.find(addr);
    if (!hit) return null;
    return hit.device.read(hit.offset, size);
  }

  write(addr: number, size: number, value: number): boolean {
    const hit = this.find(addr);
    if (!hit) return false;
    hit.device.write(hit.offset, size, value);
    return true;
  }

  tick(nowNs: bigint): void {
    for (const d of this.devices) d.tick?.(nowNs);
  }
}

/** Mask a write to the accessed width, the way real hardware would. */
export function truncate(value: number, size: number): number {
  switch (size) {
    case 1:
      return value & 0xff;
    case 2:
      return value & 0xffff;
    default:
      return value | 0;
  }
}
