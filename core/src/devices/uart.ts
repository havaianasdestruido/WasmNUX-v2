/**
 * ns16550a UART at the QEMU `virt` address, register-stride 1.
 *
 * Phase 0 only needs the subset a kernel and a benchmark harness actually touch:
 * a transmit FIFO that always accepts, a receive register fed by the host, line
 * status, and the interrupt enable/identification registers. Everything else
 * reads as zero and writes are ignored, which is what QEMU's own model does for
 * the unused registers of this device.
 */

import { truncate, type Device } from './bus.ts';

export const UART_BASE = 0x10000000;
export const UART_SIZE = 0x1000;

/** Register offsets (with LCR.DLAB = 0 unless noted). */
const R = {
  RBR: 0, // receive buffer / transmit holding
  THR: 0,
  IER: 1,
  IIR: 2,
  FCR: 2,
  LCR: 3,
  MCR: 4,
  LSR: 5,
  MSR: 6,
  SCR: 7,
  DLL: 0, // DLAB = 1
  DLM: 1, // DLAB = 1
} as const;

const LSR_DATA_READY = 1 << 0;
const LSR_THR_EMPTY = 1 << 5;
const LSR_THR_IDLE = 1 << 6;

export interface UartSink {
  /** One byte the guest transmitted. */
  onByte(byte: number): void;
}

export class Uart implements Device {
  readonly name = 'uart';
  readonly base: number;
  readonly size = UART_SIZE;

  /** Bytes typed into the terminal, consumed by RBR reads. */
  private readonly rx: number[] = [];
  private ier = 0;
  private lcr = 0x03; // 8N1, the reset value Linux expects
  private mcr = 0;
  private scr = 0;
  private dll = 0x0c;
  private dlm = 0;

  constructor(
    private readonly sink: UartSink,
    base = UART_BASE,
  ) {
    this.base = base;
  }

  /** Host -> guest: queue a byte as if it arrived from the keyboard. */
  pushInput(byte: number): void {
    this.rx.push(byte & 0xff);
  }

  pushInputText(text: string): void {
    for (const ch of text) this.pushInput(ch.codePointAt(0)!);
  }

  get pendingInput(): number {
    return this.rx.length;
  }

  /** Receive interrupt pending? (bit 2 of IIR when IER bit 0 is set) */
  get rxInterrupt(): boolean {
    return (this.ier & 1) !== 0 && this.rx.length > 0;
  }

  private lsr(): number {
    let v = LSR_THR_EMPTY | LSR_THR_IDLE; // the TX FIFO never fills in the model
    if (this.rx.length) v |= LSR_DATA_READY;
    return v;
  }

  read(offset: number, size: number): number {
    if (size !== 1) {
      // Wider accesses are uncommon; answer with the low byte of each register.
      let v = 0;
      for (let i = 0; i < size; i++) v |= (this.readByte(offset + i) & 0xff) << (8 * i);
      return v;
    }
    return this.readByte(offset);
  }

  private readByte(offset: number): number {
    const dlab = (this.lcr & 0x80) !== 0;
    switch (offset & 7) {
      case R.RBR:
        if (dlab) return this.dll;
        return this.rx.length ? this.rx.shift()! : 0;
      case R.IER:
        return dlab ? this.dlm : this.ier;
      case R.IIR: {
        // Priority: receive data available, then "no interrupt pending".
        if (this.rxInterrupt) return 0x04; // IIR: RDA, no FIFO status bits set
        return 0x01;
      }
      case R.LCR:
        return this.lcr;
      case R.MCR:
        return this.mcr;
      case R.LSR:
        return this.lsr();
      case R.MSR:
        return 0;
      case R.SCR:
        return this.scr;
      default:
        return 0;
    }
  }

  write(offset: number, size: number, value: number): void {
    for (let i = 0; i < size; i++) {
      this.writeByte(offset + i, truncate(value >> (8 * i), 1));
    }
  }

  private writeByte(offset: number, value: number): void {
    const dlab = (this.lcr & 0x80) !== 0;
    switch (offset & 7) {
      case R.THR:
        if (dlab) this.dll = value & 0xff;
        else this.sink.onByte(value & 0xff);
        return;
      case R.IER:
        if (dlab) this.dlm = value & 0xff;
        else this.ier = value & 0x0f;
        return;
      case R.FCR:
        return; // FIFO control: the model has an infinitely deep FIFO
      case R.LCR:
        this.lcr = value & 0xff;
        return;
      case R.MCR:
        this.mcr = value & 0xff;
        return;
      case R.SCR:
        this.scr = value & 0xff;
        return;
      default:
        return;
    }
  }
}

/** Collects guest console output into a string (tests, benchmarks, headless runs). */
export class StringUartSink implements UartSink {
  readonly chunks: string[] = [];
  private current = '';

  onByte(byte: number): void {
    const ch = String.fromCharCode(byte);
    this.current += ch;
    if (ch === '\n') {
      this.chunks.push(this.current);
      this.current = '';
    }
  }

  get text(): string {
    return this.current ? [...this.chunks, this.current].join('') : this.chunks.join('');
  }

  get lines(): string[] {
    return this.chunks.map((l) => l.replace(/\r?\n$/, ''));
  }
}

/** Forwards guest console output to a host stream (Node stdout, a worker port). */
export class CallbackUartSink implements UartSink {
  constructor(private readonly cb: (byte: number) => void) {}
  onByte(byte: number): void {
    this.cb(byte);
  }
}
