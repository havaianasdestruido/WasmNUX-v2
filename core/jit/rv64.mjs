import {leb, wasm} from './wasm.mjs';

export function decodeBlock(words, pc = 0) {
  if (!(words instanceof Uint32Array) || !words.length || words.length > 256 ||
      !Number.isInteger(pc) || pc < 0 || pc > 0x7ffff000 || pc % 4) throw new RangeError('invalid block');
  return Array.from(words, (w, i) => {
    const rd = w >>> 7 & 31, rs = w >>> 15 & 31, rt = w >>> 20 & 31;
    const f3 = w >>> 12 & 7, f7 = w >>> 25;
    switch (w & 127) {
      case 0x13:
        if (f3 === 0) return {op:'addi', rd, rs, imm:w >> 20};
        break;
      case 0x33:
        if (f3 === 0 && f7 === 0) return {op:'add', rd, rs, rt};
        if (f3 === 0 && f7 === 0x20) return {op:'sub', rd, rs, rt};
        if (f3 === 0 && f7 === 1) return {op:'mul', rd, rs, rt};
        if (f3 === 4 && f7 === 0) return {op:'xor', rd, rs, rt};
        break;
      case 0x63:
        if (i === words.length - 1 && (f3 === 0 || f3 === 1)) {
          const offset = ((w >> 31) << 12) | ((w & 128) << 4) | ((w >>> 25 & 63) << 5) | (w >>> 7 & 30);
          const target = pc + i * 4 + offset;
          if (target >= 0 && target <= 0x7fffffff && target % 4 === 0) return {op:f3 === 0 ? 'beq' : 'bne', rs, rt, target};
        }
        break;
    }
    throw new Error(`unsupported or misplaced RV64 instruction at ${pc + 4*i}: 0x${w.toString(16)}`);
  });
}

const i32 = n => [0x41, ...leb(n, true)];
const i64 = n => [0x42, ...leb(n, true)];
const alu = {addi:0x7c, add:0x7c, sub:0x7d, mul:0x7e, xor:0x85};
const get = r => r === 0 ? i64(0) : [...i32(0), 0x29, 3, ...leb(r*8)];
function emitAlu({op, rd, rs, rt, imm}) {
  return rd ? [...i32(0), ...get(rs), ...(op === 'addi' ? i64(imm) : get(rt)), alu[op], 0x37, 3, ...leb(rd*8)] : [];
}
const condition = ({op,rs,rt}) => [...get(rs), ...get(rt), op === 'beq' ? 0x51 : 0x52];
export function emitBlock(words, pc = 0) {
  const ops = decodeBlock(words, pc);
  const end = pc + words.length * 4;
  const code = [];
  for (const instruction of ops) {
    if (instruction.target !== undefined) {
      code.push(...i32(instruction.target), ...i32(end), ...condition(instruction), 0x1b);
      return wasm([{name:'run', params:[], results:[0x7f], code}]);
    }
    code.push(...emitAlu(instruction));
  }
  return wasm([{name:'run', params:[], results:[0x7f], code:[...code, ...i32(end)]}]);
}

// One self-edge only. Fuel bounds execution between scheduler safepoints.
// A general multi-block region with side exits/dispatch is future work.
export function emitLoopRegion(words, pc = 0) {
  const ops = decodeBlock(words, pc);
  const branch = ops.pop();
  if (branch.target !== pc) throw new Error('region requires a terminal self-edge');
  const stopAtEntry = [0x20,0, ...i32(0), 0x4c, 0x04,0x40, ...i32(pc), 0x0f,0x0b]; // fuel <= 0
  const end = pc + words.length * 4;
  const code = [...stopAtEntry, 0x03,0x40, ...ops.flatMap(emitAlu),
    ...condition(branch), 0x04,0x40,
    0x20,0, ...i32(1), 0x6b, 0x22,0, 0x0d,1, // --fuel; branch to loop when nonzero
    ...i32(pc), 0x0f, 0x0b,0x0b, ...i32(end)];
  return wasm([{name:'run', params:[0x7f], results:[0x7f], code}]);
}

export function makeInterpreter(words, pc = 0) {
  const ops = decodeBlock(words, pc);
  return r => {
    const get = i => i === 0 ? 0n : r[i];
    for (const {op, rd, rs, rt, imm, target} of ops) {
      const a = get(rs), b = rt === undefined ? 0n : get(rt);
      let value;
      switch (op) {
        case 'addi': value = a + BigInt(imm); break;
        case 'add': value = a + b; break;
        case 'sub': value = a - b; break;
        case 'mul': value = a * b; break;
        case 'xor': value = a ^ b; break;
        case 'beq': if (a === b) return target; break;
        case 'bne': if (a !== b) return target; break;
      }
      if (rd) r[rd] = value;
    }
    return pc + words.length * 4;
  };
}

// mul x2,x2,x3; add x2,x2,x1; xor x2,x2,x3; addi x1,x1,-1; bne x1,x0,-16
export const workload = new Uint32Array([0x02310133, 0x00110133, 0x00314133, 0xfff08093, 0xfe0098e3]);
export function measureJit(iterations = 100_000, samples = 5) {
  if (!Number.isInteger(iterations) || iterations <= 0 || iterations > 0x7fffffff ||
      !Number.isInteger(samples) || samples <= 0) throw new RangeError('invalid benchmark dimensions');
  const mem = new WebAssembly.Memory({initial:1, maximum:1});
  const r = new BigInt64Array(mem.buffer, 0, 32);
  const t = performance.now();
  const bytes = emitBlock(workload);
  const wasmRun = new WebAssembly.Instance(new WebAssembly.Module(bytes), {env:{mem}}).exports.run;
  const compileInstantiateMs = performance.now() - t;
  const regionStart = performance.now();
  const regionBytes = emitLoopRegion(workload);
  const region = new WebAssembly.Instance(new WebAssembly.Module(regionBytes), {env:{mem}}).exports.run;
  const regionCompileInstantiateMs = performance.now() - regionStart;
  const ir = makeInterpreter(workload);
  const measures = {interpreterMs:[], jitMs:[], regionMs:[]};
  function run(fn, n) {
    r.fill(0n); r[1] = BigInt(n); r[2] = 3n; r[3] = 17n;
    const start = performance.now();
    let pc = 0, blocks = 0;
    do { pc = fn(); blocks++; } while (pc === 0 && blocks <= n);
    if (pc !== workload.length*4 || blocks !== n) throw new Error('wrong block control flow');
    return [performance.now() - start, r[2]];
  }
  function runRegion(n) {
    r.fill(0n); r[1] = BigInt(n); r[2] = 3n; r[3] = 17n;
    const start = performance.now();
    const pc = region(n);
    const elapsed = performance.now() - start;
    if (pc !== workload.length*4 || r[1] !== 0n) throw new Error('wrong region exit');
    return [elapsed, r[2]];
  }
  run(() => ir(r), 1000); run(wasmRun, 1000); runRegion(1000);
  let checksum;
  for (let i = 0; i < samples; i++) {
    const trials = [['interpreterMs', n => run(() => ir(r), n)], ['jitMs', n => run(wasmRun, n)], ['regionMs', runRegion]];
    for (let j = 0; j < trials.length; j++) {
      const [key, fn] = trials[(i+j)%trials.length];
      const [ms, sum] = fn(iterations);
      if (checksum !== undefined && checksum !== sum) throw new Error('JIT checksum mismatch');
      checksum = sum;
      measures[key].push(ms);
    }
  }
  return {iterations, instructionsPerBlock:workload.length, moduleBytes:bytes.length, compileInstantiateMs, regionBytes:regionBytes.length, regionCompileInstantiateMs, ...measures, checksum:String(checksum)};
}
