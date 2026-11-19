/**
 * Baseline suite: WasmNUX against an existing in-browser RISC-V emulator.
 *
 * ROADMAP §4 asks for "throughput vs best existing in-browser emulator >= 3x".
 * Measuring that needs a real comparator, not a number quoted from a README, so
 * this suite runs the *same guest program* through both engines:
 *
 *  - `8086emu` (MIT, Rust compiled to Wasm, RV32IM) is a published in-browser
 *    emulator with an interpreter core - a fair stand-in for "what exists today".
 *    Its own assembler is not used: the image is produced by our assembler and
 *    written into its memory, so both engines execute byte-identical code.
 *  - Ours, interpreted and JIT-compiled.
 *
 * The instruction count is taken from our interpreter's retire counter and fed
 * to `8086emu` as its step budget, so both engines are timed over the same
 * nominal number of guest instructions. The workloads are the register-only
 * ones: the comparator has no device model, no syscalls and no atomics, so
 * anything touching MMIO would not be a like-for-like comparison.
 *
 * **The comparator is a speed reference, not a correctness oracle.** Measured on
 * these three workloads it neither retires exactly one instruction per step nor
 * reaches the same final register state: on `arith-loop` it halts having
 * produced `a0 = 0` where an independent model of the same program (and both of
 * our engines) produce -1188726464, and on `branchy` it stops mid-loop before
 * the step budget is spent. So this suite deliberately asserts nothing about its
 * results - it only reports how fast it went - and the checksum agreement it does
 * enforce is between *our* interpreter and *our* JIT. The authoritative
 * conformance oracles are `riscv-tests`, `riscv-arch-test` and QEMU-TCG
 * differential fuzzing in CI (ROADMAP §9), not another browser emulator.
 *
 * The dependency is optional. When it is not installed the suite reports itself
 * unavailable instead of failing, so a browser-only CI job still runs.
 */

import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { assemble } from '@wasmnux/core';
import { cpuWorkloads, runWorkload, type Workload } from '../src/guest.ts';
import type { BenchCase, Outcome, Suite, Variant } from '../src/types.ts';

/** Workloads that are pure register arithmetic: no MMIO, no syscalls, no atomics. */
const COMPARABLE = new Set(['arith-loop', 'divmod', 'branchy']);

interface RiscvEmulator {
  mem_write(addr: number, bytes: Uint8Array): void;
  reset(): void;
  run(steps: number): void;
  halted(): boolean;
  pc(): number;
  mem_size(): number;
}

interface EmulatorModule {
  version: string;
  create(): RiscvEmulator;
}

/**
 * Load `8086emu` synchronously (its wasm is instantiated at import time, and a
 * benchmark must not include that in a timed region). Returns null when the
 * package is absent.
 */
export async function loadBaselineEmulator(): Promise<EmulatorModule | null> {
  try {
    const req = createRequire(import.meta.url);
    const pkgPath = req.resolve('8086emu');
    const pkg = JSON.parse(readFileSync(join(dirname(pkgPath), 'package.json'), 'utf8')) as {
      version?: string;
    };
    const wasmPath = join(dirname(pkgPath), 'multi_cpu_emu_bg.wasm');
    const mod = (await import('8086emu')) as unknown as {
      initSync(input: { module: Uint8Array }): void;
      Emulator: new (isa: string) => RiscvEmulator;
    };
    mod.initSync({ module: readFileSync(wasmPath) });
    return {
      version: pkg.version ?? 'unknown',
      create: () => new mod.Emulator('rv32'),
    };
  } catch {
    return null;
  }
}

export function comparableWorkloads(scale = 1): Workload[] {
  return cpuWorkloads(scale).filter((w) => COMPARABLE.has(w.id));
}

/**
 * Both engines, same bytes, same instruction count.
 *
 * `steps` is discovered once (untimed) by running the workload interpreted, so
 * the comparator's budget is exactly the number of instructions the guest
 * program really retires.
 */
export async function baselineSuite(scale = 1): Promise<Suite | null> {
  const emu = await loadBaselineEmulator();
  if (!emu) return null;
  const workloads = comparableWorkloads(scale);

  const cases: BenchCase[] = workloads.map((w) => {
    const image = assemble(w.source, { base: 0 }).bytes;
    const steps = runWorkload({ workload: w, jit: false }).instructions;

    const baseline: Variant = {
      name: `8086emu ${emu.version} (rust/wasm)`,
      run: (): Outcome => {
        const e = emu.create();
        e.mem_write(0, image);
        e.reset();
        const t0 = performance.now();
        e.run(steps);
        const ms = performance.now() - t0;
        // `steps` is a nominal budget: see the module comment for why this
        // engine's step accounting is not compared against ours.
        return {
          ms,
          instructions: steps,
          meta: { imageBytes: image.length, halted: e.halted(), stoppedAtPc: e.pc() },
        };
      },
    };

    const ours: Variant[] = [
      {
        name: 'interpreter (ours)',
        run: (): Outcome => {
          const o = runWorkload({ workload: w, jit: false });
          if (o.instructions !== steps)
            throw new Error(`interpreter retired ${o.instructions}, expected ${steps}`);
          return o;
        },
      },
      {
        name: 'jit globals/trap (ours)',
        run: (): Outcome => {
          const o = runWorkload({ workload: w, jit: { config: { regalloc: 'globals', bounds: 'trap' } } });
          if (o.instructions !== steps) throw new Error(`jit retired ${o.instructions}, expected ${steps}`);
          return o;
        },
      },
    ];

    return {
      name: w.id,
      description: `${w.title} - byte-identical image, ${steps} guest instructions on both engines`,
      showMeta: true,
      variants: [ours[0]!, ours[1]!, baseline],
    };
  });

  return {
    id: 'baseline',
    title: 'Existing in-browser emulator comparison',
    spike: 'A',
    cases,
    verify: () => {
      for (const w of workloads) {
        const interp = runWorkload({ workload: w, jit: false });
        const jit = runWorkload({ workload: w, jit: { config: { regalloc: 'globals', bounds: 'trap' } } });
        if (interp.instructions !== jit.instructions) {
          throw new Error(
            `workload '${w.id}': retired ${interp.instructions} interpreted vs ${jit.instructions} compiled`,
          );
        }
        if (interp.meta?.['result'] !== jit.meta?.['result']) {
          throw new Error(
            `workload '${w.id}': our engines disagree (${interp.meta?.['result']} vs ${jit.meta?.['result']})`,
          );
        }
      }
    },
  };
}
