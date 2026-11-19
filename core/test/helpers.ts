/**
 * Shared helpers for the core test suite.
 *
 * Every CPU-level test is written as guest assembly and executed by the thing
 * under test, then compared against either a hand-computed expectation or the
 * interpreter (the differential oracle). Keeping that plumbing in one place is
 * what makes `jit.test.ts` able to sweep every JIT configuration variant.
 */

import { assemble, AsmError } from '../src/cpu/asm.ts';
import { CpuState } from '../src/cpu/state.ts';
import { Interpreter } from '../src/cpu/interp.ts';
import { Machine, type MachineOptions } from '../src/machine/machine.ts';
import { StringUartSink } from '../src/devices/uart.ts';
import { TEST_PASS } from '../src/devices/clint.ts';

export const RAM_BASE = 0x80000000;
export const RAM_BYTES = 1 << 20;
/** Scratch area tests use as a stack / data buffer. */
export const SCRATCH = RAM_BASE + 0x8000;

/**
 * Exit cleanly through the Linux exit syscall.
 *
 * Deliberately does *not* touch a0: tests report results in a0, and the exit
 * code the machine records is whatever a0 held.
 */
export const EXIT = '  li a7, 93\n  ecall\n';
/** Exit cleanly through the sifive_test finisher (also exercises MMIO). */
export const FINISH = `  li t6, 0x100000\n  li t5, ${TEST_PASS}\n  sw t5, 0(t6)\n`;

export interface RunResult {
  machine: Machine;
  cpu: CpuState;
  sink: StringUartSink;
  /** Instructions retired. */
  instructions: number;
  reg(i: number): number;
  /** Read a 32-bit word from guest RAM by guest address. */
  word(addr: number): number;
  byte(addr: number): number;
  half(addr: number): number;
  /** Assembler labels, so a test can address its own data section. */
  labels: ReadonlyMap<string, number>;
  label(name: string): number;
}

export interface RunOptions extends MachineOptions {
  /** Predefined assembler symbols (`.set`-equivalent, e.g. a heap base). */
  defines?: Record<string, number>;
  /** Initial register values (index -> value). */
  regs?: Record<number, number>;
  budget?: number;
  /** Assemble at this base instead of RAM base. */
  base?: number;
  /** Set sp to this before starting (default SCRATCH). */
  stackTop?: number;
}

/** Assemble, load into a fresh machine and run to completion (or budget). */
export function run(src: string, opts: RunOptions = {}): RunResult {
  const { budget = 200_000, regs, base, stackTop, defines, ...machineOpts } = opts;
  const assembled = assemble(src, { base: base ?? RAM_BASE, defines });
  const sink = new StringUartSink();
  const machine = new Machine({
    ramBytes: RAM_BYTES,
    ramBase: RAM_BASE,
    uartSink: sink,
    ...machineOpts,
  });
  machine.load(assembled.bytes, base ?? RAM_BASE);
  machine.reset(assembled.entry, stackTop ?? SCRATCH);
  if (regs) for (const [k, v] of Object.entries(regs)) machine.cpu.setReg(Number(k), v);
  machine.run(budget);
  return wrap(machine, sink, assembled.labels);
}

/** Run the same program with the interpreter only. The differential oracle. */
export function runInterpreted(src: string, opts: RunOptions = {}): RunResult {
  return run(src, { ...opts, jit: false });
}

function wrap(machine: Machine, sink: StringUartSink, labels: ReadonlyMap<string, number>): RunResult {
  const cpu = machine.cpu;
  return {
    labels,
    label: (name: string) => {
      const v = labels.get(name);
      if (v === undefined) throw new Error('no such label: ' + name);
      return v;
    },
    machine,
    cpu,
    sink,
    instructions: cpu.instret,
    reg: (i: number) => cpu.reg(i),
    word: (addr: number) => machine.mem.view.getUint32(machine.mem.ramOffset(addr)!, true),
    byte: (addr: number) => machine.mem.u8[machine.mem.ramOffset(addr)!]!,
    half: (addr: number) => machine.mem.view.getUint16(machine.mem.ramOffset(addr)!, true),
  };
}

/** Assemble + interpret one instruction sequence, returning the registers. */
export function evalAsm(body: string, opts: RunOptions = {}): number[] {
  const r = runInterpreted(`${body}\n${EXIT}`, opts);
  return Array.from(r.cpu.regs);
}

/** All 32 registers as a plain array (x0 always reads 0). */
export function regsOf(r: RunResult): number[] {
  return Array.from(r.cpu.regs);
}

export { assemble, AsmError, Interpreter, Machine };
