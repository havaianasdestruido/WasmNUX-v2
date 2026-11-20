import { describe, expect, it } from 'vitest';
import { Machine, SYS, MAX_SYSCALL_IO } from '../src/machine/machine.ts';
import { SmpChannel } from '../src/smp/channel.ts';
import { assemble } from '../src/cpu/asm.ts';

function machines(base = 0x80000000) {
  const memory = new WebAssembly.Memory({ initial: 1, maximum: 1, shared: true });
  const channel = new SmpChannel(SmpChannel.createShared(2), 2);
  const opts = { ramBytes: 65536, ramBase: base, memory, shared: true, harts: 2, smp: channel };
  return { first: new Machine({ ...opts, hartId: 0 }), second: new Machine({ ...opts, hartId: 1 }), channel };
}
describe('coordinated host writes', () => {
  it('invalidates another hart reservation after overlapping host writes, including ABA', () => {
    const { first, second } = machines();
    first.onLr(0, 0x80000100, 64);
    second.writeHostBytes(0x80000101, new Uint8Array([1]));
    second.writeHostBytes(0x80000101, new Uint8Array([0]));
    expect(first.onSc(0, 0x80000100, 99, 64)).toBe(false);
    expect(first.mem.readU32(0x80000100)).toBe(0);
  });
  it('does not invalidate disjoint reservations or wrap an invalid address into RAM', () => {
    const { first, second } = machines();
    first.onLr(0, 0x80000100, 64);
    for (const address of [0x180000100, -1, 0x8000ffff])
      expect(() => second.writeHostBytes(address, new Uint8Array(2))).toThrow();
    second.writeHostBytes(0x80000200, new Uint8Array([1]));
    expect(first.onSc(0, 0x80000100, 99, 64)).toBe(true);
  });
  it('routes syscall input through the shared reservation barrier and bounds the copy', () => {
    const { first, second } = machines(0xffff0000);
    first.onLr(0, 0xfffffffc, 16383);
    second.uart.pushInputText('ABC');
    second.cpu.setReg(17, SYS.read);
    second.cpu.setReg(10, 0);
    second.cpu.setReg(11, 0xffffffff);
    second.cpu.setReg(12, 10);
    second.onSyscall(second.cpu);
    expect(second.cpu.reg(10)).toBe(1);
    expect(second.uart.pendingInput).toBe(2);
    expect(first.mem.readU8(0xffffffff)).toBe(65);
    expect(first.onSc(0, 0xfffffffc, 0, 16383)).toBe(false);
  });
  it('invalidates uniprocessor compiled code after a host patch', () => {
    const base = 0x80000000;
    const machine = new Machine({ ramBytes: 65536 });
    const original = assemble('li a0, 1\nli a7, 93\necall', { base });
    machine.load(original.bytes);
    machine.reset(base, base + 65532);
    expect(machine.engine.compileAt(base, false)).not.toBeNull();
    machine.writeHostBytes(base, assemble('li a0, 2', { base }).bytes);
    machine.run(100);
    expect(machine.cpu.exitCode).toBe(2);
  });
});

describe('host syscall resource bounds', () => {
  it('limits writes to 64 KiB per instruction and returns a retryable partial count', () => {
    let writes = 0;
    const machine = new Machine({
      ramBytes: 131072,
      uartSink: {
        onByte: () => {
          writes++;
        },
      },
    });
    machine.cpu.setReg(17, SYS.write);
    machine.cpu.setReg(10, 1);
    machine.cpu.setReg(11, 0x80000000);
    machine.cpu.setReg(12, -1);
    machine.onSyscall(machine.cpu);
    expect(machine.cpu.reg(10)).toBe(MAX_SYSCALL_IO);
    expect(writes).toBe(MAX_SYSCALL_IO);
  });
});
