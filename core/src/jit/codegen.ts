/**
 * Spike A translator: RV32IMA basic blocks -> WebAssembly.
 *
 * Shape of a compiled region (ADR-0003):
 *
 * ```wasm
 * (func $region (param $entry i32) (param $budget i32) (result i32 i32)
 *   (local $b i32) (local $reason i32) (local $t0..$t3 i32)
 *   (block $exitLoop
 *     (loop $top
 *       (block $fault
 *         (block $budgetExit
 *           (block $b_{n-1} ... (block $b_0
 *             (br_table $b_0 ... $b_{n-1} $exitLoop (local.get $entry)))
 *           ... body of $b_0 ...)
 *         ... body of $b_{n-1} ...)
 *         ;; -> budget handler
 *       )
 *       ;; -> fault handler
 *     )
 *   )
 *   (local.get $reason) (local.get $b))
 * ```
 *
 * One `br_table` ladder serves every entry into the region; forward intra-region
 * edges are direct `br`s, backward edges re-dispatch through `$top`, and edges
 * that leave the region either return to the JS dispatcher (`chaining: 'host'`)
 * or `return_call_indirect` straight into the next compiled region through an
 * imported table (`chaining: 'tail'`), which keeps the host out of the loop.
 *
 * The knobs below exist because ADR-0002/0003/0004 are decisions about *cost*:
 * every variant is measured in `benchmarks/suites/jit.ts` and reported in
 * `docs/spikes/spike-a-jit.md`.
 */

import {
  AMO5_ADD,
  AMO5_AND,
  AMO5_LR,
  AMO5_MAX,
  AMO5_MAXU,
  AMO5_MIN,
  AMO5_MINU,
  AMO5_OR,
  AMO5_SC,
  AMO5_SWAP,
  AMO5_XOR,
  type Decoded,
} from '../cpu/encoding.ts';
import { EXIT } from '../cpu/state.ts';
import type { BasicBlock, Region } from './cfg.ts';
import { type FuncEmitter, WasmModuleBuilder } from './wasm/encoder.ts';
import { G, type RegAlloc } from './regfile.ts';

export interface JitConfig {
  /** Where the guest register file lives (ADR-0004). */
  regalloc: RegAlloc;
  /**
   * How out-of-range guest addresses are caught (ADR-0004). `trap` relies on the
   * Wasm out-of-bounds trap, which requires the memory to be sized exactly to
   * guest RAM (hence `regalloc: 'globals'`); `inline` emits an explicit check.
   */
  bounds: 'trap' | 'inline';
  /** How often the pc slot is refreshed: before faulting ops only, per block, or per instruction. */
  pcTracking: 'faulting' | 'block' | 'instruction';
  /** Legacy policy selector; both modes check every block to preserve exact budgets. */
  budgetCheck: 'loop' | 'block';
  /** How control leaves a region: back to the JS dispatcher, or tail-called onward. */
  chaining: 'host' | 'tail';
  /** Tier 2: constant propagation, folded addresses, elided checks (ADR-0002). */
  optimize: boolean;
  ramBase: number;
  ramSize: number;
  /** Control-page byte offset inside the Wasm memory (used when `regalloc === 'memory'`). */
  controlOffset: number;
  /** Emit Wasm atomics for the A extension (requires shared guest RAM). */
  sharedAtomics: boolean;
}

export const DEFAULT_JIT_CONFIG: Omit<JitConfig, 'ramBase' | 'ramSize' | 'controlOffset'> = {
  regalloc: 'globals',
  bounds: 'trap',
  pcTracking: 'faulting',
  budgetCheck: 'loop',
  chaining: 'host',
  optimize: false,
  sharedAtomics: false,
};

/** A compiled region that another region can tail-call into. */
export interface LinkTarget {
  /** Slot in the shared dispatch table. */
  slot: number;
  /** Entry block index inside that region. */
  entryBlock: number;
}

export function validateConfig(cfg: JitConfig): void {
  if (cfg.bounds === 'trap' && cfg.regalloc === 'memory') {
    throw new Error("bounds:'trap' needs emulator state out of guest RAM, so regalloc must be 'globals'");
  }
}

export interface Ctx {
  b: WasmModuleBuilder;
  region: Region;
  cfg: JitConfig;
  links: Map<number, LinkTarget>;
  /** Type index of `(i32, i32) -> (i32, i32)`, shared by every region entry. */
  dispatchType: number;
}

const AMO_F5: Record<string, number> = {
  'lr.w': AMO5_LR,
  'sc.w': AMO5_SC,
  'amoswap.w': AMO5_SWAP,
  'amoadd.w': AMO5_ADD,
  'amoxor.w': AMO5_XOR,
  'amoor.w': AMO5_OR,
  'amoand.w': AMO5_AND,
  'amomin.w': AMO5_MIN,
  'amomax.w': AMO5_MAX,
  'amominu.w': AMO5_MINU,
  'amomaxu.w': AMO5_MAXU,
};

export class RegionCodegen {
  private f!: FuncEmitter;
  private n: number;
  private lBudget = 0;
  private lReason = 0;
  private lT0 = 0;
  private lT1 = 0;
  private lT2 = 0;
  /** Labels opened inside the current block body (if / loop / block). */
  private extra = 0;
  /** Index of the block currently being emitted. */
  private cur = 0;
  /** Per-block constant tracking (tier 2). */
  private consts: (number | undefined)[] = [];
  private terminated = false;

  constructor(private readonly ctx: Ctx) {
    this.n = ctx.region.blocks.length;
  }

  // -- label depths (see the module comment for the nesting order) ----------

  private depthToBlock(targetIndex: number): number {
    return targetIndex - this.cur - 1 + this.extra;
  }
  private depthToBudgetExit(): number {
    return this.n - 1 - this.cur + this.extra;
  }
  private depthToFault(): number {
    return this.n - this.cur + this.extra;
  }
  private depthToTop(): number {
    return this.n - this.cur + 1 + this.extra;
  }
  private depthToExitLoop(): number {
    return this.n - this.cur + 2 + this.extra;
  }

  // -- state access ---------------------------------------------------------

  private slotAddr(slot: number): number {
    return this.ctx.cfg.controlOffset + slot * 4;
  }

  private readReg(r: number): void {
    if (r === 0) {
      this.f.i32(0);
      return;
    }
    if (this.ctx.cfg.regalloc === 'globals') this.f.globalGet(G.REG_BASE + r);
    else this.f.i32(this.slotAddr(0)).i32Load(r * 4, 2);
  }

  /**
   * Consume the value on top of the stack and write it to guest register r.
   *
   * Every register result funnels through here so the stack convention stays
   * uniform: one value on top, nothing pending below it. A load has already
   * consumed its address operand, so pushing a destination slot address in
   * front of the value (as an earlier draft did for the memory register file)
   * silently swaps the operands of the following store.
   */
  private writeReg(r: number, known?: number): void {
    const f = this.f;
    if (r === 0) {
      f.drop(); // x0 is hardwired zero; nothing ever reads its slot
    } else if (this.ctx.cfg.regalloc === 'memory') {
      f.localSet(this.lT2);
      f.i32(this.slotAddr(r));
      f.localGet(this.lT2);
      f.i32Store(0, 2);
    } else {
      f.globalSet(G.REG_BASE + r);
    }
    if (this.ctx.cfg.optimize && r !== 0) this.consts[r] = known === undefined ? undefined : known | 0;
  }

  private setPc(pc: number): void {
    if (this.ctx.cfg.regalloc === 'globals') this.f.i32(pc | 0).globalSet(G.PC);
    else
      this.f
        .i32(this.slotAddr(G.PC))
        .i32(pc | 0)
        .i32Store(0, 2);
  }

  private setPcFromT0(): void {
    if (this.ctx.cfg.regalloc === 'globals') this.f.localGet(this.lT0).globalSet(G.PC);
    else this.f.i32(this.slotAddr(G.PC)).localGet(this.lT0).i32Store(0, 2);
  }

  /** Consume `[value]` and store it into a state slot. */
  private writeSlot(slot: number): void {
    const f = this.f;
    if (this.ctx.cfg.regalloc === 'globals') {
      f.globalSet(slot);
      return;
    }
    f.localSet(this.lT2);
    f.i32(this.slotAddr(slot));
    f.localGet(this.lT2);
    f.i32Store(0, 2);
  }

  private setSlotConst(slot: number, value: number): void {
    if (this.ctx.cfg.regalloc === 'globals') this.f.i32(value | 0).globalSet(slot);
    else
      this.f
        .i32(this.slotAddr(slot))
        .i32(value | 0)
        .i32Store(0, 2);
  }

  private setSlotFromReg(slot: number, r: number): void {
    if (this.ctx.cfg.regalloc === 'globals') {
      this.readReg(r);
      this.f.globalSet(slot);
    } else {
      this.f.i32(this.slotAddr(slot));
      this.readReg(r);
      this.f.i32Store(0, 2);
    }
  }

  private readSlot(slot: number): void {
    if (this.ctx.cfg.regalloc === 'globals') this.f.globalGet(slot);
    else this.f.i32(this.slotAddr(slot)).i32Load(0, 2);
  }

  private known(r: number): number | undefined {
    if (!this.ctx.cfg.optimize) return undefined;
    return this.consts[r];
  }

  // -- region emission ------------------------------------------------------

  emit(funcName: string): number {
    const { b, region, cfg } = this.ctx;
    validateConfig(cfg);
    const f = b.addFunc(funcName, ['i32', 'i32'], ['i32', 'i32']);
    this.f = f;
    this.lBudget = f.addLocals(1, 'i32'); // 2: remaining instruction budget
    this.lReason = f.addLocals(1, 'i32'); // 3
    this.lT0 = f.addLocals(1, 'i32'); // 4
    this.lT1 = f.addLocals(1, 'i32'); // 5
    this.lT2 = f.addLocals(1, 'i32'); // 6

    f.localGet(1).localSet(this.lBudget);
    f.i32(EXIT.INVALID).localSet(this.lReason);

    f.block('void'); // $exitLoop
    f.loop('void'); // $top
    f.block('void'); // $fault
    f.block('void'); // $budgetExit
    for (let i = 0; i < this.n; i++) f.block('void'); // $b_{n-1} .. $b_0
    f.localGet(0);
    f.brTable(
      Array.from({ length: this.n }, (_, i) => i),
      this.n + 3,
    );
    for (let i = 0; i < this.n; i++) {
      f.end(); // closes $b_i; body i follows
      this.cur = i;
      this.emitBlockBody(region.blocks[i]!);
    }
    f.end(); // closes $budgetExit -> budget handler
    if (cfg.pcTracking === 'faulting') this.setPcFromT0(); // $t0 = the block we bailed on
    f.i32(EXIT.BUDGET).localSet(this.lReason);
    f.br(2); // $exitLoop
    f.end(); // closes $fault -> fault handler
    // $t2 holds the Wasm offset that failed the inline bounds check; publish the
    // guest address so the host can emulate the MMIO access.
    if (cfg.bounds === 'inline') {
      f.localGet(this.lT2);
      if (cfg.ramBase !== 0) {
        f.i32(cfg.ramBase | 0);
        f.i32Add();
      }
      this.writeSlot(G.INFO); // clobbers $t2, which is dead on this path
    }
    f.i32(EXIT.FAULT).localSet(this.lReason);
    f.br(1); // $exitLoop
    f.end(); // closes $top; falling out of a loop exits it
    f.end(); // closes $exitLoop
    f.localGet(this.lReason);
    f.localGet(this.lBudget);
    return b.funcIndexByName(funcName);
  }

  private emitBlockBody(block: BasicBlock): void {
    this.extra = 0;
    this.terminated = false;
    this.consts = this.ctx.cfg.optimize ? new Array<number | undefined>(32).fill(undefined) : [];
    if (this.ctx.cfg.optimize) this.consts[0] = 0;

    const cfg = this.ctx.cfg;
    this.setPc(block.start);

    // Both legacy modes check every block so an acyclic block cannot overrun its budget.
    if (cfg.pcTracking === 'faulting') this.f.i32(block.start | 0).localSet(this.lT0);
    this.f.localGet(this.lBudget);
    this.f.i32(block.words.length);
    this.f.i32Sub();
    this.f.localTee(this.lBudget);
    this.f.i32(0);
    this.f.i32LeS();
    this.f.brIf(this.depthToBudgetExit());

    // A Wasm trap loses local variables. Save the charged budget and the
    // current block so the host can count previous blocks and the completed
    // prefix accurately, including across tail-called regions.
    if (cfg.bounds === 'trap') {
      this.f.localGet(this.lBudget).globalSet(G.TRAP_BUDGET);
      this.f.i32(block.start | 0).globalSet(G.TRAP_BLOCK);
      this.f.i32(block.words.length).globalSet(G.TRAP_BLOCK_LEN);
    }

    for (let k = 0; k < block.insns.length; k++) {
      this.emitInsn(block.insns[k]!, (block.start + k * 4) >>> 0);
    }
    this.emitExit(block);
    if (!this.terminated) this.f.unreachable();
  }

  // -- control flow ---------------------------------------------------------

  private emitEdge(target: number): void {
    const { region, cfg, links } = this.ctx;
    const local = region.blocks.findIndex((b) => b.start === target >>> 0);
    if (local >= 0) {
      if (local > this.cur) {
        this.f.br(this.depthToBlock(local));
        this.terminated = true;
        return;
      }
      this.f.i32(local).localSet(0); // re-dispatch through the ladder
      this.f.br(this.depthToTop());
      this.terminated = true;
      return;
    }
    if (cfg.chaining === 'tail') {
      const link = links.get(target >>> 0);
      if (link) {
        this.f.i32(link.entryBlock);
        this.f.localGet(this.lBudget);
        this.f.i32(link.slot);
        this.f.returnCallIndirect(this.ctx.dispatchType, 0);
        this.terminated = true;
        return;
      }
    }
    this.setPc(target >>> 0);
    this.f.i32(EXIT.CHAIN).localSet(this.lReason);
    this.f.br(this.depthToExitLoop());
    this.terminated = true;
  }

  private emitExit(block: BasicBlock): void {
    switch (block.exit.kind) {
      case 'fall':
        this.emitEdge(block.exit.next);
        return;
      case 'jump':
        this.emitEdge(block.exit.target);
        return;
      case 'branch': {
        const last = block.insns[block.insns.length - 1]!;
        this.emitBranch(last, block);
        return;
      }
      case 'indirect':
        this.setPcFromT0();
        this.f.i32(EXIT.CHAIN).localSet(this.lReason);
        this.f.br(this.depthToExitLoop());
        this.terminated = true;
        return;
      case 'host': {
        const last = block.insns[block.insns.length - 1]!;
        this.setPc(block.exit.pc);
        const reason =
          last.mnemonic === 'ecall'
            ? EXIT.SYSCALL
            : last.mnemonic === 'ebreak'
              ? EXIT.BREAK
              : last.mnemonic === 'wfi'
                ? EXIT.IDLE
                : EXIT.RETIRE;
        this.f.i32(reason).localSet(this.lReason);
        this.f.br(this.depthToExitLoop());
        this.terminated = true;
        return;
      }
    }
  }

  private emitBranch(d: Decoded, block: BasicBlock): void {
    const f = this.f;
    if (block.exit.kind !== 'branch') throw new Error('branch is not the block terminator');
    const { taken, notTaken } = block.exit;
    const takenLocal = this.ctx.region.blocks.findIndex((x) => x.start === taken);
    const notTakenLocal = this.ctx.region.blocks.findIndex((x) => x.start === notTaken);

    const a = this.known(d.rs1);
    const b = this.known(d.rs2);
    if (a !== undefined && b !== undefined) {
      this.emitEdge(this.foldBranch(d.mnemonic, a, b) ? taken : notTaken);
      return;
    }

    const cmp = () => {
      this.readReg(d.rs1);
      this.readReg(d.rs2);
      switch (d.mnemonic) {
        case 'beq':
          f.i32Eq();
          break;
        case 'bne':
          f.i32Ne();
          break;
        case 'blt':
          f.i32LtS();
          break;
        case 'bge':
          f.i32GeS();
          break;
        case 'bltu':
          f.i32LtU();
          break;
        case 'bgeu':
          f.i32GeU();
          break;
        default:
          throw new Error(`not a branch: ${d.mnemonic}`);
      }
    };
    const cmpInverted = () => {
      this.readReg(d.rs1);
      this.readReg(d.rs2);
      switch (d.mnemonic) {
        case 'beq':
          f.i32Ne();
          break;
        case 'bne':
          f.i32Eq();
          break;
        case 'blt':
          f.i32GeS();
          break;
        case 'bge':
          f.i32LtS();
          break;
        case 'bltu':
          f.i32GeU();
          break;
        case 'bgeu':
          f.i32LtU();
          break;
        default:
          throw new Error(`not a branch: ${d.mnemonic}`);
      }
    };

    // Tier 2: when one arm is the next block in emission order, a single
    // conditional branch replaces an if/else (one label + one jump saved per
    // loop iteration, which is exactly where guests spend their time).
    if (this.ctx.cfg.optimize && takenLocal === this.cur + 1) {
      cmp();
      f.brIf(this.depthToBlock(takenLocal));
      this.emitEdge(notTaken);
      return;
    }
    if (this.ctx.cfg.optimize && notTakenLocal === this.cur + 1) {
      cmpInverted();
      f.brIf(this.depthToBlock(notTakenLocal));
      this.emitEdge(taken);
      return;
    }

    cmp();
    f.if('void');
    this.extra++;
    this.emitEdge(taken);
    f.else();
    this.emitEdge(notTaken);
    f.end();
    this.extra--;
    this.terminated = true;
  }

  private foldBranch(mnem: string, a: number, b: number): boolean {
    switch (mnem) {
      case 'beq':
        return a === b;
      case 'bne':
        return a !== b;
      case 'blt':
        return a < b;
      case 'bge':
        return a >= b;
      case 'bltu':
        return a >>> 0 < b >>> 0;
      default:
        return a >>> 0 >= b >>> 0;
    }
  }

  // -- instructions ---------------------------------------------------------

  private emitInsn(d: Decoded, addr: number): void {
    const f = this.f;
    const cfg = this.ctx.cfg;
    if (cfg.pcTracking === 'instruction') this.setPc(addr);

    switch (d.mnemonic) {
      case 'lui':
        f.i32(d.imm | 0);
        this.writeReg(d.rd, d.imm | 0);
        return;
      case 'auipc': {
        const v = (addr + d.imm) | 0;
        f.i32(v);
        this.writeReg(d.rd, v);
        return;
      }
      case 'addi': {
        const src = this.known(d.rs1);
        if (src !== undefined) {
          const v = (src + d.imm) | 0;
          f.i32(v);
          this.writeReg(d.rd, v);
          return;
        }
        this.readReg(d.rs1);
        if (d.imm !== 0) {
          f.i32(d.imm);
          f.i32Add();
        }
        this.writeReg(d.rd);
        return;
      }
      case 'slti':
        this.binaryImm(
          d,
          () => f.i32LtS(),
          (x, imm) => (x < imm ? 1 : 0),
        );
        return;
      case 'sltiu':
        this.binaryImm(
          d,
          () => f.i32LtU(),
          (x, imm) => (x >>> 0 < imm >>> 0 ? 1 : 0),
        );
        return;
      case 'xori':
        this.binaryImm(
          d,
          () => f.i32Xor(),
          (x, imm) => x ^ imm,
        );
        return;
      case 'ori':
        this.binaryImm(
          d,
          () => f.i32Or(),
          (x, imm) => x | imm,
        );
        return;
      case 'andi':
        this.binaryImm(
          d,
          () => f.i32And(),
          (x, imm) => x & imm,
        );
        return;
      case 'slli':
      case 'srli':
      case 'srai': {
        const shamt = d.imm & 31;
        const src = this.known(d.rs1);
        if (src !== undefined) {
          const v =
            d.mnemonic === 'slli' ? (src << shamt) | 0 : d.mnemonic === 'srli' ? src >>> shamt : src >> shamt;
          f.i32(v);
          this.writeReg(d.rd, v);
          return;
        }
        this.readReg(d.rs1);
        if (shamt !== 0) {
          f.i32(shamt);
          if (d.mnemonic === 'slli') f.i32Shl();
          else if (d.mnemonic === 'srli') f.i32ShrU();
          else f.i32ShrS();
        }
        this.writeReg(d.rd);
        return;
      }
      case 'add':
        this.binaryReg(
          d,
          () => f.i32Add(),
          (x, y) => (x + y) | 0,
        );
        return;
      case 'sub':
        this.binaryReg(
          d,
          () => f.i32Sub(),
          (x, y) => (x - y) | 0,
        );
        return;
      case 'sll':
        this.binaryReg(
          d,
          () => f.i32Shl(),
          (x, y) => (x << (y & 31)) | 0,
        );
        return;
      case 'srl':
        this.binaryReg(
          d,
          () => f.i32ShrU(),
          (x, y) => x >>> (y & 31),
        );
        return;
      case 'sra':
        this.binaryReg(
          d,
          () => f.i32ShrS(),
          (x, y) => x >> (y & 31),
        );
        return;
      case 'xor':
        this.binaryReg(
          d,
          () => f.i32Xor(),
          (x, y) => x ^ y,
        );
        return;
      case 'or':
        this.binaryReg(
          d,
          () => f.i32Or(),
          (x, y) => x | y,
        );
        return;
      case 'and':
        this.binaryReg(
          d,
          () => f.i32And(),
          (x, y) => x & y,
        );
        return;
      case 'slt':
        this.binaryReg(
          d,
          () => f.i32LtS(),
          (x, y) => (x < y ? 1 : 0),
        );
        return;
      case 'sltu':
        this.binaryReg(
          d,
          () => f.i32LtU(),
          (x, y) => (x >>> 0 < y >>> 0 ? 1 : 0),
        );
        return;
      case 'mul':
        this.binaryReg(
          d,
          () => f.i32Mul(),
          (x, y) => Math.imul(x, y),
        );
        return;
      case 'mulh':
      case 'mulhu':
      case 'mulhsu': {
        const aUnsigned = d.mnemonic === 'mulhu';
        const bUnsigned = d.mnemonic !== 'mulh';
        this.readReg(d.rs1);
        if (aUnsigned) f.i64ExtendI32U();
        else f.i64ExtendI32S();
        this.readReg(d.rs2);
        if (bUnsigned) f.i64ExtendI32U();
        else f.i64ExtendI32S();
        f.i64Mul();
        f.i64(32n);
        f.i64ShrS();
        f.i32WrapI64();
        this.writeReg(d.rd);
        return;
      }
      case 'div':
      case 'divu':
      case 'rem':
      case 'remu':
        this.emitDivRem(d);
        return;
      case 'lb':
      case 'lh':
      case 'lw':
      case 'lbu':
      case 'lhu':
        this.emitLoad(d, addr);
        return;
      case 'sb':
      case 'sh':
      case 'sw':
        this.emitStore(d, addr);
        return;
      case 'jal':
        if (d.rd !== 0) {
          f.i32((addr + 4) | 0);
          this.writeReg(d.rd, (addr + 4) | 0);
        }
        return;
      case 'jalr': {
        // target = (rs1 + imm) & ~1 ; link = addr + 4. Read rs1 first: rd may
        // alias it (`jalr ra, 0(ra)`).
        this.readReg(d.rs1);
        if (d.imm !== 0) {
          f.i32(d.imm);
          f.i32Add();
        }
        f.i32(-2);
        f.i32And();
        f.localSet(this.lT0);
        this.setPc(addr);
        f.localGet(this.lT0).i32(3).i32And().brIf(this.depthToFault());
        if (d.rd !== 0) {
          f.i32((addr + 4) | 0);
          this.writeReg(d.rd, (addr + 4) | 0);
        }
        return;
      }
      case 'beq':
      case 'bne':
      case 'blt':
      case 'bge':
      case 'bltu':
      case 'bgeu':
        return; // emitted by emitExit via emitBranch
      case 'fence':
        return; // JS has nothing to order; cross-worker ordering uses atomics
      case 'ecall':
      case 'ebreak':
      case 'wfi':
        // The block ends here; `emitExit` returns to the host with pc already
        // past the instruction, matching the interpreter's own semantics.
        return;
      default:
        if (AMO_F5[d.mnemonic] !== undefined) {
          this.emitAmo(d, addr);
          return;
        }
        throw new Error(`translator: unhandled instruction '${d.mnemonic}' at 0x${addr.toString(16)}`);
    }
  }

  private binaryImm(d: Decoded, op: () => void, fold: (x: number, imm: number) => number): void {
    const f = this.f;
    const src = this.known(d.rs1);
    if (src !== undefined) {
      const v = fold(src, d.imm) | 0;
      f.i32(v);
      this.writeReg(d.rd, v);
      return;
    }
    this.readReg(d.rs1);
    f.i32(d.imm);
    op();
    this.writeReg(d.rd);
  }

  private binaryReg(d: Decoded, op: () => void, fold: (x: number, y: number) => number): void {
    const f = this.f;
    const a = this.known(d.rs1);
    const b = this.known(d.rs2);
    if (this.ctx.cfg.optimize) {
      if (a !== undefined && b !== undefined) {
        const v = fold(a, b) | 0;
        f.i32(v);
        this.writeReg(d.rd, v);
        return;
      }
      if (d.rs2 === 0) {
        const isCopy = ['add', 'or', 'xor', 'sll', 'srl', 'sra'].includes(d.mnemonic);
        const isZero = ['and', 'mul', 'mulh', 'mulhu', 'mulhsu'].includes(d.mnemonic);
        if (isCopy) {
          this.readReg(d.rs1);
          this.writeReg(d.rd, a);
          return;
        }
        if (isZero) {
          f.i32(0);
          this.writeReg(d.rd, 0);
          return;
        }
      }
      if (d.rs1 === 0 && ['add', 'or', 'xor'].includes(d.mnemonic)) {
        this.readReg(d.rs2);
        this.writeReg(d.rd, b);
        return;
      }
    }
    this.readReg(d.rs1);
    this.readReg(d.rs2);
    op();
    this.writeReg(d.rd);
  }

  /**
   * RISC-V defines division by zero and INT_MIN/-1 as ordinary results, while
   * Wasm traps on both, so the guards are explicit. Tier 2 drops them when the
   * divisor is a known safe constant.
   */
  private emitDivRem(d: Decoded): void {
    const f = this.f;
    const a = this.known(d.rs1);
    const b = this.known(d.rs2);
    if (this.ctx.cfg.optimize && a !== undefined && b !== undefined) {
      const v = this.foldDivRem(d.mnemonic, a, b);
      f.i32(v);
      this.writeReg(d.rd, v);
      return;
    }
    const divisorSafe = this.ctx.cfg.optimize && b !== undefined && b !== 0 && b !== -1;
    const isSigned = d.mnemonic === 'div' || d.mnemonic === 'rem';

    this.readReg(d.rs1);
    f.localSet(this.lT0);
    this.readReg(d.rs2);
    f.localSet(this.lT1);

    if (!divisorSafe) {
      f.localGet(this.lT1);
      f.i32Eqz();
      f.if('i32');
      this.extra++;
      if (d.mnemonic === 'div' || d.mnemonic === 'divu') f.i32(-1);
      else f.localGet(this.lT0);
      f.else();
    }
    if (isSigned && !divisorSafe) {
      f.localGet(this.lT0);
      f.i32(-2147483648);
      f.i32Eq();
      f.localGet(this.lT1);
      f.i32(-1);
      f.i32Eq();
      f.i32And();
      f.if('i32');
      this.extra++;
      if (d.mnemonic === 'div') f.localGet(this.lT0);
      else f.i32(0);
      f.else();
      f.localGet(this.lT0);
      f.localGet(this.lT1);
      if (d.mnemonic === 'div') f.i32DivS();
      else f.i32RemS();
      f.end();
      this.extra--;
    } else {
      f.localGet(this.lT0);
      f.localGet(this.lT1);
      switch (d.mnemonic) {
        case 'div':
          f.i32DivS();
          break;
        case 'divu':
          f.i32DivU();
          break;
        case 'rem':
          f.i32RemS();
          break;
        default:
          f.i32RemU();
      }
    }
    if (!divisorSafe) {
      f.end();
      this.extra--;
    }
    this.writeReg(d.rd);
  }

  private foldDivRem(mnem: string, a: number, b: number): number {
    switch (mnem) {
      case 'div':
        if (b === 0) return -1;
        if (a === -2147483648 && b === -1) return -2147483648;
        return (a / b) | 0;
      case 'divu':
        if (b === 0) return -1;
        return ((a >>> 0) / (b >>> 0)) | 0;
      case 'rem':
        if (b === 0) return a;
        if (a === -2147483648 && b === -1) return 0;
        return a % b;
      default:
        if (b === 0) return a;
        return ((a >>> 0) % (b >>> 0)) | 0;
    }
  }

  // -- memory ---------------------------------------------------------------

  /**
   * Push the address operand for a load/store and return the static memarg
   * offset when tier 2 could fold the address to a constant inside RAM (the
   * "fast-path memory access" case: no address arithmetic, no bounds check).
   */
  private pushAddress(d: Decoded, size: number, addr: number): number | undefined {
    const f = this.f;
    const cfg = this.ctx.cfg;
    const knownBase = this.known(d.rs1);

    if (knownBase !== undefined) {
      const guestAddr = ((knownBase + d.imm) | 0) >>> 0;
      const off = (guestAddr - cfg.ramBase) >>> 0;
      if (off + size <= cfg.ramSize) {
        f.i32(0);
        return off;
      }
      // Constant but outside RAM: keep the pc precise so the host can emulate
      // the MMIO access or raise the fault.
      if (cfg.pcTracking !== 'instruction') this.setPc(addr);
      if (cfg.bounds === 'inline') {
        // $t2 is read by the $fault handler to publish G.INFO.
        f.i32(off | 0);
        f.localSet(this.lT2);
        f.br(this.depthToFault());
        this.terminated = true;
        return undefined;
      }
      f.i32(off | 0); // out of bounds on purpose: Wasm traps, host emulates
      return undefined;
    }

    this.readReg(d.rs1);
    if (d.imm !== 0) {
      f.i32(d.imm);
      f.i32Add();
    }
    if (cfg.pcTracking !== 'instruction') this.setPc(addr);
    if (cfg.ramBase !== 0) {
      f.i32(-cfg.ramBase);
      f.i32Add();
    }
    if (cfg.bounds === 'inline') {
      f.localTee(this.lT2);
      f.i32(cfg.ramSize - size);
      f.i32GtU();
      f.brIf(this.depthToFault());
      f.localGet(this.lT2);
    }
    return undefined;
  }

  private emitLoad(d: Decoded, addr: number): void {
    const f = this.f;
    const size =
      d.mnemonic === 'lb' || d.mnemonic === 'lbu' ? 1 : d.mnemonic === 'lh' || d.mnemonic === 'lhu' ? 2 : 4;
    const folded = this.pushAddress(d, size, addr);
    if (this.terminated) return;
    const off = folded ?? 0;
    switch (d.mnemonic) {
      case 'lb':
        f.i32Load8s(off, 0);
        break;
      case 'lbu':
        f.i32Load8u(off, 0);
        break;
      case 'lh':
        f.i32Load16s(off, 1);
        break;
      case 'lhu':
        f.i32Load16u(off, 1);
        break;
      default:
        f.i32Load(off, 2);
    }
    this.writeReg(d.rd);
  }

  private emitStore(d: Decoded, addr: number): void {
    const f = this.f;
    const size = d.mnemonic === 'sb' ? 1 : d.mnemonic === 'sh' ? 2 : 4;
    const folded = this.pushAddress(d, size, addr); // leaves [ramAddr] on the stack
    if (this.terminated) return;
    this.readReg(d.rs2); // [ramAddr, value] - exactly what i32.store wants
    const off = folded ?? 0;
    switch (d.mnemonic) {
      case 'sb':
        f.i32Store8(off, 0);
        break;
      case 'sh':
        f.i32Store16(off, 1);
        break;
      default:
        f.i32Store(off, 2);
    }
  }

  // -- atomics --------------------------------------------------------------

  private emitAmo(d: Decoded, addr: number): void {
    const f = this.f;
    const cfg = this.ctx.cfg;
    const atomic = cfg.sharedAtomics;

    // Guest address -> Wasm offset in $t0, keeping pc precise for the fault path.
    this.readReg(d.rs1);
    if (cfg.pcTracking !== 'instruction') this.setPc(addr);
    if (cfg.ramBase !== 0) {
      f.i32(-cfg.ramBase);
      f.i32Add();
    }
    if (cfg.bounds === 'inline') {
      f.localTee(this.lT2);
      f.i32(cfg.ramSize - 4);
      f.i32GtU();
      f.brIf(this.depthToFault());
      f.localGet(this.lT2);
    }
    f.localSet(this.lT0);
    f.localGet(this.lT0);
    if (cfg.ramBase !== 0) f.i32(cfg.ramBase).i32Add();
    f.i32(3).i32And().brIf(this.depthToFault());

    if (d.mnemonic === 'lr.w') {
      if (atomic) f.localGet(this.lT0).i32AtomicLoad(0, 2);
      else f.localGet(this.lT0).i32Load(0, 2);
      f.localSet(this.lT1);
      f.localGet(this.lT0);
      if (cfg.ramBase !== 0) f.i32(cfg.ramBase).i32Add();
      this.writeSlot(G.LR_ADDR);
      f.localGet(this.lT1);
      this.writeReg(d.rd);
      this.setSlotFromT1(G.LR_VALUE);
      this.setSlotConst(G.LR_VALID, 1);
      return;
    }

    if (d.mnemonic === 'sc.w') {
      this.emitSc(d, atomic);
      return;
    }

    const f5 = AMO_F5[d.mnemonic]!;
    const isMinMax = f5 === AMO5_MIN || f5 === AMO5_MAX || f5 === AMO5_MINU || f5 === AMO5_MAXU;

    if (atomic && isMinMax) {
      // Wasm has no atomic min/max, so RISC-V AMOMIN/AMOMAX need a CAS retry
      // loop - measurably worse than the single-op AMOs (see spike-a-jit.md).
      this.readReg(d.rs2);
      f.localSet(this.lT2);
      f.block('void');
      this.extra++;
      f.loop('void');
      this.extra++;
      f.localGet(this.lT0).i32AtomicLoad(0, 2).localSet(this.lT1);
      f.localGet(this.lT0); // addr
      f.localGet(this.lT1); // expected
      f.localGet(this.lT1); // a = old
      f.localGet(this.lT2); // b = src
      f.localGet(this.lT1);
      f.localGet(this.lT2);
      this.emitMinmaxCompare(f5);
      f.select();
      f.i32AtomicCmpxchg(0, 2);
      f.localGet(this.lT1);
      f.i32Eq();
      f.brIf(1); // swapped -> leave
      f.br(0); // lost the race -> retry
      this.extra--;
      f.end(); // loop
      this.extra--;
      f.end(); // block
      f.localGet(this.lT1);
      this.writeReg(d.rd);
      return;
    }

    if (atomic) {
      this.readReg(d.rs2);
      f.localSet(this.lT2);
      f.localGet(this.lT0);
      f.localGet(this.lT2);
      switch (f5) {
        case AMO5_ADD:
          f.i32AtomicAdd(0, 2);
          break;
        case AMO5_SWAP:
          f.i32AtomicXchg(0, 2);
          break;
        case AMO5_XOR:
          f.i32AtomicXor(0, 2);
          break;
        case AMO5_OR:
          f.i32AtomicOr(0, 2);
          break;
        case AMO5_AND:
          f.i32AtomicAnd(0, 2);
          break;
        default:
          throw new Error(`unsupported atomic ${d.mnemonic}`);
      }
      f.localSet(this.lT1); // old value -> rd
    } else {
      // Non-shared guest RAM: plain read-modify-write. Only correct because a
      // single vCPU touches the memory; the shared build always uses atomics.
      f.localGet(this.lT0).i32Load(0, 2).localSet(this.lT1); // old
      f.localGet(this.lT0); // addr for the store
      if (f5 === AMO5_SWAP) {
        this.readReg(d.rs2);
      } else if (isMinMax) {
        f.localGet(this.lT1);
        this.readReg(d.rs2);
        f.localGet(this.lT1);
        this.readReg(d.rs2);
        this.emitMinmaxCompare(f5);
        f.select();
      } else {
        f.localGet(this.lT1);
        this.readReg(d.rs2);
        switch (f5) {
          case AMO5_ADD:
            f.i32Add();
            break;
          case AMO5_XOR:
            f.i32Xor();
            break;
          case AMO5_OR:
            f.i32Or();
            break;
          case AMO5_AND:
            f.i32And();
            break;
          default:
            throw new Error(`unsupported amo ${d.mnemonic}`);
        }
      }
      f.i32Store(0, 2);
    }

    f.localGet(this.lT1);
    this.writeReg(d.rd);
  }

  private emitMinmaxCompare(f5: number): void {
    if (f5 === AMO5_MIN) this.f.i32LtS();
    else if (f5 === AMO5_MAX) this.f.i32GtS();
    else if (f5 === AMO5_MINU) this.f.i32LtU();
    else this.f.i32GtU();
  }

  /** SC.W: conditional store against the LR.W reservation. */
  private emitSc(d: Decoded, atomic: boolean): void {
    const f = this.f;
    // $t1 holds the result: 0 = success, 1 = failure.
    f.i32(1).localSet(this.lT1);
    this.readSlot(G.LR_VALID);
    f.i32Eqz();
    this.readSlot(G.LR_ADDR);
    this.readReg(d.rs1);
    f.i32Ne();
    f.i32Or();
    f.i32Eqz(); // reservation still valid?
    f.if('void');
    this.extra++;
    if (atomic) {
      f.localGet(this.lT0);
      this.readSlot(G.LR_VALUE);
      this.readReg(d.rs2);
      f.i32AtomicCmpxchg(0, 2);
      this.readSlot(G.LR_VALUE);
      f.i32Ne(); // mismatch -> failure
      f.localSet(this.lT1);
    } else {
      this.readReg(d.rs2);
      f.localSet(this.lT2);
      f.localGet(this.lT0).i32Load(0, 2);
      this.readSlot(G.LR_VALUE);
      f.i32Eq();
      f.if('void');
      this.extra++;
      f.localGet(this.lT0);
      f.localGet(this.lT2);
      f.i32Store(0, 2);
      f.i32(0).localSet(this.lT1);
      f.else();
      f.i32(1).localSet(this.lT1);
      f.end();
      this.extra--;
    }
    f.end();
    this.extra--;
    this.setSlotConst(G.LR_VALID, 0);
    f.localGet(this.lT1);
    this.writeReg(d.rd);
  }

  private setSlotFromT1(slot: number): void {
    const f = this.f;
    if (this.ctx.cfg.regalloc === 'globals') {
      f.localGet(this.lT1).globalSet(slot);
    } else {
      f.i32(this.slotAddr(slot)).localGet(this.lT1).i32Store(0, 2);
    }
  }

  /** True when the region can use Wasm atomics (shared guest RAM). */
  get usesAtomics(): boolean {
    return this.ctx.cfg.sharedAtomics;
  }
}

/** Compile one region into a fresh module builder (used by the engine). */
export function translateRegion(ctx: Ctx, funcName: string): number {
  return new RegionCodegen(ctx).emit(funcName);
}
