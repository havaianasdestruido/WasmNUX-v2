import { describe, expect, it } from 'vitest';
import { assemble } from '../src/cpu/asm.ts';
import { Machine } from '../src/machine/machine.ts';

const BASE = 0x80000000;
const cases: Array<[number, number]> = [
  [7, 0],
  [-1, 0],
  [-2147483648, -1],
  [-2147483648, 3],
  [-7, 2],
  [-1, 2],
  [2147483647, -1],
  [0, -1],
  [0x12345678, 0x101],
];

function expected(a: number, b: number): number[] {
  const signedA = BigInt(a | 0);
  const signedB = BigInt(b | 0);
  const unsignedA = BigInt(a >>> 0);
  const unsignedB = BigInt(b >>> 0);
  const signedOverflow = signedA === -2147483648n && signedB === -1n;
  const result = [
    signedB === 0n ? -1n : signedOverflow ? signedA : signedA / signedB,
    unsignedB === 0n ? -1n : unsignedA / unsignedB,
    signedB === 0n ? signedA : signedOverflow ? 0n : signedA % signedB,
    unsignedB === 0n ? unsignedA : unsignedA % unsignedB,
  ];
  return result.map((x) => Number(BigInt.asIntN(32, x)));
}

describe('compiled DIV and REM semantics', () => {
  for (const optimized of [false, true]) {
    for (const constants of [false, true]) {
      it(`${optimized ? 'optimized' : 'baseline'} JIT, ${constants ? 'constant' : 'register'} operands`, () => {
        for (const [a, b] of cases) {
          const setup = constants ? `li t0, ${a}\nli t1, ${b}` : '';
          const code = assemble(
            `${setup}\ndiv s0, t0, t1\ndivu s1, t0, t1\nrem s2, t0, t1\nremu s3, t0, t1\nli a7, 93\necall`,
            { base: BASE },
          );
          const machine = new Machine({ ramBytes: 65536 });
          machine.load(code.bytes, BASE);
          machine.reset(code.entry, BASE + 0x8000);
          if (!constants) {
            machine.cpu.setReg(5, a);
            machine.cpu.setReg(6, b);
          }
          expect(machine.engine.compileAt(BASE, optimized)).not.toBeNull();
          machine.run(1000);
          expect(machine.cpu.stop).toBe('exit');
          expect(machine.engine.stats.jitInstructions).toBeGreaterThan(0);
          expect(
            [8, 9, 18, 19].map((i) => machine.cpu.reg(i)),
            `a=${a} b=${b}`,
          ).toEqual(expected(a, b));
        }
      });
    }
  }
});
