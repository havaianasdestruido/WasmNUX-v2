/**
 * Control-flow recovery for the JIT (Spike A).
 *
 * Guest code is a flat image in RAM; before anything can be translated we need
 * basic blocks and regions. This module implements:
 *
 *  - block discovery by traversal from an entry pc, truncating a block whenever
 *    a branch target lands in the middle of it;
 *  - region formation (ADR-0003): a region is a set of blocks compiled into one
 *    Wasm function with a `br_table` dispatch ladder, bounded by
 *    `maxRegionBlocks` / `maxRegionInsns`;
 *  - loop-header detection, because the instruction-budget check is emitted on
 *    backward edges only (checking every block costs ~30% on tight loops, see
 *    `docs/spikes/spike-a-jit.md`).
 */

import { decode, type Decoded } from '../cpu/encoding.ts';
import type { GuestMemory } from '../machine/memory.ts';

export type BlockExit =
  | { kind: 'fall'; next: number }
  | { kind: 'branch'; taken: number; notTaken: number }
  | { kind: 'jump'; target: number }
  /** jalr / ret: the target is only known at runtime. */
  | { kind: 'indirect'; link: number }
  /** ecall, ebreak, wfi, csr, fence.i, illegal or "ran off the end": leave to the host. */
  | { kind: 'host'; pc: number };

export interface BasicBlock {
  /** Guest pc of the first instruction. */
  start: number;
  /** Instruction words, in order. */
  words: number[];
  /** Decoded forms, parallel to `words` (so the translator never re-decodes). */
  insns: Decoded[];
  exit: BlockExit;
  /** Execution counter used by the tiering heuristic (ADR-0002). */
  heat: number;
  /** True when some backward edge targets this block. */
  isLoopHeader: boolean;
  /** Region this block was compiled into, or -1. */
  region: number;
  /** Index of the block inside its region. */
  localIndex: number;
}

export interface Region {
  /** Guest pc of the region entry block. */
  entry: number;
  blocks: BasicBlock[];
  /** Total instruction count; used for budget accounting and code-size metrics. */
  insnCount: number;
  /** Successor addresses reachable from this region that were not absorbed. */
  externalTargets: number[];
}

export interface CfgOptions {
  /** Stop scanning after this many blocks. */
  maxBlocks?: number;
  /** Stop scanning a block after this many instructions (safety valve). */
  maxBlockInsns?: number;
  /**
   * Guest pcs that must never be translated: an access that repeatedly faults
   * (MMIO polling, an unmapped probe) is learned at runtime and recorded here so
   * the next translation ends the block *before* it and the host single-steps
   * it. Everything else in the loop stays compiled, which is what keeps a UART
   * or CLINT polling loop fast instead of ping-ponging into the interpreter.
   */
  slowPcs?: ReadonlySet<number>;
}

export const DEFAULT_MAX_BLOCK_INSNS = 512;

/**
 * Discover basic blocks reachable from `entry`.
 *
 * Scanning stops at unmapped addresses, at host-exit instructions and at the
 * configured limits. Blocks that a jump lands inside of are truncated so every
 * block starts at a real control-flow target.
 */
export function buildCfg(mem: GuestMemory, entry: number, opts: CfgOptions = {}): Map<number, BasicBlock> {
  const maxBlocks = opts.maxBlocks ?? 4096;
  const maxBlockInsns = opts.maxBlockInsns ?? DEFAULT_MAX_BLOCK_INSNS;
  const blocks = new Map<number, BasicBlock>();
  const queue: number[] = [entry >>> 0];

  while (queue.length && blocks.size < maxBlocks) {
    const start = queue.shift()! >>> 0;
    if (blocks.has(start)) continue;
    // A target inside an already-scanned block splits it.
    for (const [otherStart, other] of blocks) {
      const end = (otherStart + other.words.length * 4) >>> 0;
      if (otherStart < start && start < end) truncateBlock(other, (start - otherStart) / 4);
    }
    const block = scanBlock(mem, start, maxBlockInsns, opts.slowPcs);
    if (!block) continue;
    blocks.set(start, block);
    for (const t of successorsOf(block)) {
      if (!blocks.has(t)) queue.push(t);
    }
  }

  // Loop headers: blocks targeted by a backward edge.
  for (const [, b] of blocks) {
    for (const t of successorsOf(b)) {
      const target = blocks.get(t);
      if (target && t <= b.start) target.isLoopHeader = true;
    }
  }
  return blocks;
}

function scanBlock(
  mem: GuestMemory,
  start: number,
  maxInsns: number,
  slowPcs?: ReadonlySet<number>,
): BasicBlock | null {
  const words: number[] = [];
  const insns: Decoded[] = [];
  let pc = start >>> 0;
  let exit: BlockExit | null = null;

  for (let i = 0; i < maxInsns; i++) {
    const off = mem.ramOffset(pc);
    if (off < 0 || (off & 3) !== 0 || off + 4 > mem.ramSize) break;
    const word = mem.view.getUint32(off, true);
    const d = decode(word, pc);
    if (d.illegal) {
      // Leave the illegal word out: the interpreter traps on it.
      exit = { kind: 'host', pc };
      break;
    }
    // CSR and FENCE.I stay in the interpreter. The block ends *before* them so
    // the host can single-step the instruction with exact semantics (including
    // flushing the code cache for self-modifying code).
    if (d.isSlowPath && d.mnemonic !== 'ecall' && d.mnemonic !== 'ebreak' && d.mnemonic !== 'wfi') {
      exit = { kind: 'host', pc };
      break;
    }
    // A pc the runtime learned to keep out of compiled code (see CfgOptions).
    if (slowPcs && slowPcs.has(pc)) {
      exit = { kind: 'host', pc };
      break;
    }
    words.push(word);
    insns.push(d);
    pc = (pc + 4) >>> 0;

    if (d.mnemonic === 'jal') {
      exit = { kind: 'jump', target: d.target };
      break;
    }
    if (d.mnemonic === 'jalr') {
      exit = { kind: 'indirect', link: pc };
      break;
    }
    if (d.isBranch) {
      exit = { kind: 'branch', taken: d.target, notTaken: pc };
      break;
    }
    if (d.isSlowPath) {
      // ecall / ebreak / wfi: the interpreter advances pc past them, so the host
      // resumes at `pc` (already incremented).
      exit = { kind: 'host', pc };
      break;
    }
  }
  if (!words.length) return null;
  if (!exit) exit = { kind: 'host', pc };

  return { start: start >>> 0, words, insns, exit, heat: 0, isLoopHeader: false, region: -1, localIndex: -1 };
}

/** Keep only the first `keep` instructions of a block; the rest is rescanned. */
function truncateBlock(block: BasicBlock, keep: number): void {
  if (keep >= block.words.length) return;
  block.words = block.words.slice(0, keep);
  block.insns = block.insns.slice(0, keep);
  block.exit = { kind: 'fall', next: (block.start + keep * 4) >>> 0 };
}

export function successorsOf(block: BasicBlock): number[] {
  switch (block.exit.kind) {
    case 'fall':
      return [block.exit.next];
    case 'branch':
      return [block.exit.taken, block.exit.notTaken];
    case 'jump':
      return [block.exit.target];
    default:
      return [];
  }
}

export interface RegionOptions {
  maxRegionBlocks: number;
  maxRegionInsns: number;
  /** Refuse to steal blocks that are already compiled into another region. */
  skipAssigned?: boolean;
}

/**
 * Grow a region from `entry` by breadth-first absorption of successors.
 *
 * Region size matters twice over: it amortises module instantiation (ADR-0003)
 * and it keeps control flow inside Wasm instead of bouncing through the JS
 * dispatcher - the single largest overhead the spike measures.
 */
export function formRegion(blocks: Map<number, BasicBlock>, entry: number, opts: RegionOptions): Region | null {
  const start = blocks.get(entry >>> 0);
  if (!start) return null;
  const region: BasicBlock[] = [];
  const inRegion = new Set<number>();
  const queue: BasicBlock[] = [start];
  let insnCount = 0;

  while (queue.length && region.length < opts.maxRegionBlocks && insnCount < opts.maxRegionInsns) {
    const b = queue.shift()!;
    if (inRegion.has(b.start)) continue;
    if (opts.skipAssigned !== false && b.region >= 0 && b !== start) continue;
    inRegion.add(b.start);
    b.localIndex = region.length;
    region.push(b);
    insnCount += b.words.length;
    for (const succ of successorsOf(b)) {
      const sb = blocks.get(succ);
      if (sb && !inRegion.has(sb.start)) queue.push(sb);
    }
  }
  if (!region.length) return null;

  const external = new Set<number>();
  for (const b of region) {
    for (const succ of successorsOf(b)) {
      if (!inRegion.has(succ)) external.add(succ);
    }
  }
  return { entry: start.start, blocks: region, insnCount, externalTargets: [...external] };
}
