/**
 * CFG recovery (ADR-0003): block discovery, truncation, slow-pc splitting and
 * region formation.
 *
 * These are structural properties the translator depends on, so they are tested
 * directly rather than only through end-to-end differential runs: a wrong block
 * boundary shows up as a wrong *result* somewhere else, and by then the cause is
 * several layers away.
 */

import { describe, expect, it } from 'vitest';
import { assemble } from '../src/cpu/asm.ts';
import { GuestMemory } from '../src/machine/memory.ts';
import { buildCfg, formRegion, successorsOf, DEFAULT_MAX_BLOCK_INSNS } from '../src/jit/cfg.ts';
import { RAM_BASE, RAM_BYTES } from './helpers.ts';

/** Assemble `src` into a fresh guest memory and return both. */
function load(src: string): { mem: GuestMemory; entry: number; labels: ReadonlyMap<string, number> } {
  const img = assemble(src, { base: RAM_BASE });
  const mem = new GuestMemory({ ramBytes: RAM_BYTES });
  mem.loadProgram(img.bytes, img.base);
  return { mem, entry: img.entry, labels: img.labels };
}

function cfgFor(src: string, opts?: Parameters<typeof buildCfg>[2]) {
  const { mem, entry, labels } = load(src);
  return { blocks: buildCfg(mem, entry, opts), entry, labels, mem };
}

describe('buildCfg: block discovery', () => {
  it('makes one block for straight-line code ending in ecall', () => {
    const { blocks, entry } = cfgFor('  addi a0, a0, 1\n  addi a0, a0, 2\n  li a7, 93\n  ecall\n');
    expect(blocks.size).toBe(1);
    const b = blocks.get(entry)!;
    expect(b.words.length).toBe(4);
    // ecall is included in the block; the host resumes after it.
    expect(b.exit).toEqual({ kind: 'host', pc: (entry + 16) >>> 0 });
    expect(b.insns.length).toBe(b.words.length);
  });

  it('ends a block at a branch and records both successors', () => {
    const { blocks, entry } = cfgFor('  addi t0, t0, 1\n  beqz t0, done\n  addi t0, t0, 2\ndone:\n  ecall\n');
    const first = blocks.get(entry)!;
    expect(first.exit.kind).toBe('branch');
    expect(successorsOf(first)).toHaveLength(2);
    expect(blocks.size).toBe(3);
  });

  it('ends a block at jal with a single successor', () => {
    const { blocks, entry } = cfgFor('  j far\n  addi t0, t0, 1\nfar:\n  ecall\n');
    const first = blocks.get(entry)!;
    expect(first.exit.kind).toBe('jump');
    expect(successorsOf(first)).toHaveLength(1);
    // The unreachable `addi` after the jump is not discovered from this entry.
    expect(blocks.size).toBe(2);
  });

  it('ends a block at jalr with no static successors', () => {
    const { blocks, entry } = cfgFor('  jalr ra, 0(t1)\n  ecall\n');
    const first = blocks.get(entry)!;
    expect(first.exit.kind).toBe('indirect');
    expect(successorsOf(first)).toHaveLength(0);
  });

  it('marks the loop header but not its preheader', () => {
    const { blocks, entry, labels } = cfgFor(
      '  addi t0, t0, 1\nloop:\n  addi t0, t0, 2\n  bnez t0, loop\n  ecall\n',
    );
    expect(blocks.get(labels.get('loop')!)!.isLoopHeader).toBe(true);
    expect(blocks.get(entry)!.isLoopHeader).toBe(false);
  });

  it('marks a self-loop as its own header', () => {
    const { blocks, entry } = cfgFor('loop:\n  addi t0, t0, 1\n  bnez t0, loop\n  ecall\n');
    expect(blocks.get(entry)!.isLoopHeader).toBe(true);
  });

  it('does not mark forward-branch targets as loop headers', () => {
    const { blocks, labels } = cfgFor('  beqz t0, later\n  addi t0, t0, 1\nlater:\n  ecall\n');
    expect(blocks.get(labels.get('later')!)!.isLoopHeader).toBe(false);
  });

  it('truncates a block when a branch target lands inside it', () => {
    // The scan from `entry` runs straight through `loop` (a label is not a
    // terminator) and stops at the `beqz`; discovering `loop` as a target then
    // has to split that block, or the loop header would not be a block start.
    const { blocks, entry, labels } = cfgFor(
      '  addi t0, t0, 1\nloop:\n  addi t0, t0, 2\n  beqz t1, loop\n  ecall\n',
    );
    const loop = labels.get('loop')!;
    const first = blocks.get(entry)!;
    expect(first.words.length).toBe(1);
    expect(first.exit).toEqual({ kind: 'fall', next: loop });
    expect(successorsOf(first)).toEqual([loop]);
    expect(blocks.get(loop)!.words.length).toBe(2);
    expect(blocks.get(loop)!.isLoopHeader).toBe(true);
  });

  it('stops at an unmapped address', () => {
    const img = assemble('  addi t0, t0, 1\n', { base: RAM_BASE });
    const mem = new GuestMemory({ ramBytes: RAM_BYTES });
    mem.loadProgram(img.bytes, img.base);
    // Start scanning far past the loaded program, inside RAM but zero-filled:
    // zeros decode to illegal, so the scan ends immediately with a host exit.
    const blocks = buildCfg(mem, (RAM_BASE + 0x40000) >>> 0);
    const b = blocks.get((RAM_BASE + 0x40000) >>> 0);
    expect(b === undefined || b.exit.kind === 'host').toBe(true);
  });

  it('returns no blocks for an address outside RAM', () => {
    const { mem } = load('  ecall\n');
    expect(buildCfg(mem, 0x1000).size).toBe(0);
  });

  it('respects maxBlocks', () => {
    const src = '  beqz t0, a\na:\n  beqz t0, b\nb:\n  beqz t0, c\nc:\n  ecall\n';
    const { mem, entry } = load(src);
    expect(buildCfg(mem, entry, { maxBlocks: 2 }).size).toBe(2);
  });

  it('respects maxBlockInsns and falls through to a host exit', () => {
    const lines = Array.from({ length: 12 }, (_, i) => `  addi t0, t0, ${i + 1}`).join('\n');
    const { mem, entry } = load(`${lines}\n  ecall\n`);
    const b = buildCfg(mem, entry, { maxBlockInsns: 5 }).get(entry)!;
    expect(b.words.length).toBe(5);
    expect(b.exit).toEqual({ kind: 'host', pc: (entry + 20) >>> 0 });
    // A block cut short by the limit has no known successor: claiming a
    // fall-through would make the translator compile past the boundary.
    expect(successorsOf(b)).toEqual([]);
  });

  it('has a large default block limit so real loops are not split arbitrarily', () => {
    expect(DEFAULT_MAX_BLOCK_INSNS).toBe(512);
  });
});

describe('buildCfg: host-exit boundaries', () => {
  it('ends the block before a CSR access and excludes it', () => {
    const { blocks, entry } = cfgFor('  addi t0, t0, 1\n  csrr t1, minstret\n  addi t0, t0, 2\n');
    const b = blocks.get(entry)!;
    expect(b.words.length).toBe(1);
    expect(b.exit).toEqual({ kind: 'host', pc: (entry + 4) >>> 0 });
  });

  it('ends the block before fence.i and excludes it', () => {
    const { blocks, entry } = cfgFor('  addi t0, t0, 1\n  fence.i\n  addi t0, t0, 2\n');
    const b = blocks.get(entry)!;
    expect(b.words.length).toBe(1);
    expect(b.exit.kind).toBe('host');
  });

  it('ends the block before an illegal instruction and excludes it', () => {
    const img = assemble('  addi t0, t0, 1\n', { base: RAM_BASE });
    const mem = new GuestMemory({ ramBytes: RAM_BYTES });
    mem.loadProgram(img.bytes, img.base);
    mem.writeU32((RAM_BASE + 4) >>> 0, 0xffffffff); // undecodable
    const b = buildCfg(mem, RAM_BASE).get(RAM_BASE)!;
    expect(b.words.length).toBe(1);
    expect(b.exit).toEqual({ kind: 'host', pc: (RAM_BASE + 4) >>> 0 });
  });

  it('includes ecall, ebreak and wfi, then exits', () => {
    for (const insn of ['ecall', 'ebreak', 'wfi']) {
      const { blocks, entry } = cfgFor(`  addi t0, t0, 1\n  ${insn}\n`);
      const b = blocks.get(entry)!;
      expect(b.words.length, insn).toBe(2);
      expect(b.exit, insn).toEqual({ kind: 'host', pc: (entry + 8) >>> 0 });
    }
  });

  it('splits the block before a pc in slowPcs and leaves the rest compiled', () => {
    const src = 'loop:\n  addi t0, t0, 1\n  lw t1, 0(a1)\n  bnez t1, loop\n  ecall\n';
    const { mem, entry, labels } = load(src);
    const lwPc = (entry + 4) >>> 0;
    const blocks = buildCfg(mem, entry, { slowPcs: new Set([lwPc]) });
    const b = blocks.get(entry)!;
    expect(b.words.length).toBe(1); // only the addi; the lw is left to the host
    expect(b.exit).toEqual({ kind: 'host', pc: lwPc });
    expect(labels.has('loop')).toBe(true);
  });

  it('produces no block when the entry pc itself is slow', () => {
    const { mem, entry } = load('  lw t1, 0(a1)\n  ecall\n');
    const blocks = buildCfg(mem, entry, { slowPcs: new Set([entry]) });
    expect(blocks.has(entry)).toBe(false);
  });
});

describe('successorsOf', () => {
  it('returns [] for host and indirect exits', () => {
    const { blocks, entry } = cfgFor('  jalr ra, 0(t1)\n');
    expect(successorsOf(blocks.get(entry)!)).toEqual([]);
  });

  it('returns no successors for a block cut short by maxBlockInsns', () => {
    // A block that stops because of the instruction limit exits to the host:
    // the scanner cannot know whether the next word continues the block, so it
    // must not claim a fall-through edge the translator would then compile.
    const { mem, entry } = load('  addi t0, t0, 1\n  addi t0, t0, 2\n  addi t0, t0, 3\n  ecall\n');
    const b = buildCfg(mem, entry, { maxBlockInsns: 2 }).get(entry)!;
    expect(b.exit).toEqual({ kind: 'host', pc: (entry + 8) >>> 0 });
    expect(successorsOf(b)).toEqual([]);
  });
});

describe('formRegion', () => {
  const LOOP = 'loop:\n  addi t0, t0, 1\n  addi t1, t1, 2\n  bnez t0, loop\n  ecall\n';

  it('absorbs the whole loop into one region', () => {
    const { blocks, entry } = cfgFor(LOOP);
    const region = formRegion(blocks, entry, { maxRegionBlocks: 24, maxRegionInsns: 512 })!;
    expect(region.entry).toBe(entry);
    expect(region.blocks.length).toBe(2); // loop body + the ecall block
    expect(region.insnCount).toBe(4); // addi, addi, bnez, ecall
    expect(region.externalTargets).toEqual([]);
  });

  it('assigns contiguous localIndex values starting at the entry', () => {
    const { blocks, entry } = cfgFor(LOOP);
    const region = formRegion(blocks, entry, { maxRegionBlocks: 24, maxRegionInsns: 512 })!;
    expect(region.blocks.map((b) => b.localIndex)).toEqual([0, 1]);
    expect(region.blocks[0]!.start).toBe(entry);
  });

  it('honours maxRegionBlocks', () => {
    const { blocks, entry } = cfgFor(LOOP);
    const region = formRegion(blocks, entry, { maxRegionBlocks: 1, maxRegionInsns: 512 })!;
    expect(region.blocks.length).toBe(1);
    expect(region.externalTargets.length).toBeGreaterThan(0);
  });

  it('honours maxRegionInsns', () => {
    const { blocks, entry } = cfgFor(LOOP);
    const region = formRegion(blocks, entry, { maxRegionBlocks: 24, maxRegionInsns: 3 })!;
    expect(region.insnCount).toBeLessThanOrEqual(3 + 3); // one block may overshoot by its own size
    expect(region.blocks.length).toBeGreaterThanOrEqual(1);
  });

  it('lists unabsorbed successors as external targets', () => {
    const { blocks, entry } = cfgFor('  beqz t0, other\n  addi t0, t0, 1\nother:\n  ecall\n');
    const region = formRegion(blocks, entry, { maxRegionBlocks: 1, maxRegionInsns: 512 })!;
    const exit = blocks.get(entry)!.exit;
    expect(exit.kind).toBe('branch');
    if (exit.kind === 'branch') {
      expect(new Set(region.externalTargets)).toEqual(new Set([exit.taken, exit.notTaken]));
    }
  });

  it('returns null for an entry with no block', () => {
    const { blocks } = cfgFor('  ecall\n');
    expect(
      formRegion(blocks, (RAM_BASE + 0x1000) >>> 0, { maxRegionBlocks: 8, maxRegionInsns: 64 }),
    ).toBeNull();
  });

  it('does not steal blocks already assigned to another region', () => {
    const { blocks, entry } = cfgFor(LOOP);
    const first = formRegion(blocks, entry, { maxRegionBlocks: 1, maxRegionInsns: 512 })!;
    expect(first.blocks.length).toBe(1);
    const other = first.blocks[0]!;
    other.region = 0;
    const second = formRegion(blocks, other.start, { maxRegionBlocks: 8, maxRegionInsns: 512 })!;
    // The entry block itself is always allowed, but assigned successors are not.
    expect(second.blocks.length).toBeGreaterThanOrEqual(1);
    const stolen = formRegion(blocks, entry, { maxRegionBlocks: 8, maxRegionInsns: 512 })!;
    expect(stolen.blocks.some((b) => b !== other && b.region >= 0)).toBe(false);
  });

  it('can absorb assigned blocks when skipAssigned is false', () => {
    const { blocks, entry } = cfgFor(LOOP);
    const region = formRegion(blocks, entry, { maxRegionBlocks: 24, maxRegionInsns: 512 })!;
    for (const b of region.blocks) b.region = 0;
    const again = formRegion(blocks, entry, {
      maxRegionBlocks: 24,
      maxRegionInsns: 512,
      skipAssigned: false,
    })!;
    expect(again.blocks.length).toBe(region.blocks.length);
  });
});
