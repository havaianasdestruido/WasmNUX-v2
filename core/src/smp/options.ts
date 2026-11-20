import type { SmpRunOptions } from './types.ts';

/** Validate before memory allocation or worker startup. Node keeps its historical page rounding. */
export function normalizeSmpOptions(opts: SmpRunOptions, browser = false) {
  const maxHarts = browser ? 16 : 64;
  if (!Number.isInteger(opts.harts) || opts.harts < 1 || opts.harts > maxHarts)
    throw new RangeError(`invalid hart count (1..${maxHarts})`);
  if (!Number.isSafeInteger(opts.budget) || opts.budget < 0)
    throw new RangeError('budget must be a non-negative safe integer');
  const timeoutMs = opts.timeoutMs ?? 60_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 0x7fffffff)
    throw new RangeError('invalid timeoutMs');
  const requested = opts.ramBytes ?? 16 << 20;
  if (!Number.isSafeInteger(requested) || requested < 1)
    throw new RangeError(browser ? 'RAM must be page aligned and positive' : 'invalid RAM size');
  const ramBytes = Math.ceil(requested / 65536) * 65536;
  if (browser && (requested !== ramBytes || ramBytes > 256 * 1024 * 1024))
    throw new RangeError('browser RAM must be page aligned and at most 256 MiB');
  const ramBase = opts.ramBase ?? 0x80000000;
  if (!Number.isSafeInteger(ramBase) || ramBase < 0 || ramBase % 4 !== 0 || ramBase + ramBytes > 0x100000000)
    throw new RangeError('invalid RV32 RAM address (base must be word-aligned)');
  if (
    !Number.isInteger(opts.entry) ||
    opts.entry % 4 !== 0 ||
    opts.entry < ramBase ||
    opts.entry >= ramBase + ramBytes
  )
    throw new RangeError('invalid entry');
  if (
    !Number.isInteger(opts.stackTop) ||
    opts.stackTop < ramBase ||
    opts.stackTop > ramBase + ramBytes ||
    opts.stackTop > 0xffffffff
  )
    throw new RangeError('invalid stackTop');
  if (opts.program.byteLength > ramBytes) throw new RangeError('program exceeds RAM');
  return { ...opts, ramBase, ramBytes, timeoutMs };
}
