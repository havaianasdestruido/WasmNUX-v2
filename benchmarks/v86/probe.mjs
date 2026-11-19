import {V86} from '/assets/libv86.mjs';

export async function measureV86(expected, iterations) {
  if (iterations !== 1_000_000) throw new Error('v86 fixture requires one million iterations');
  const v86 = new V86({wasm_path:'/assets/v86.wasm', bios:{url:'/assets/seabios.bin'},
    multiboot:{url:'/assets/loop.elf'}, memory_size:16*1024**2, autostart:true,
    disable_speaker:true, disable_mouse:true, disable_keyboard:true});
  try {
    const samples = await new Promise((resolve, reject) => {
      let start;
      const durations = [];
      const timer = setTimeout(() => reject(new Error('v86 guest serial probe timed out')), 45_000);
      v86.add_listener('serial0-output-byte', byte => {
        if (byte === 83) start = performance.now();
        if (byte !== 68 || start === undefined) return;
        durations.push(performance.now() - start);
        start = undefined;
        const bytes = v86.read_memory(0x101000, 4);
        const result = new DataView(bytes.buffer, bytes.byteOffset, 4).getInt32(0, true);
        if (result !== Number(BigInt.asIntN(32, BigInt(expected)))) {
          clearTimeout(timer); reject(new Error(`v86 checksum mismatch: ${result}`));
        }
        if (durations.length === 5) { clearTimeout(timer); resolve(durations); }
      });
    });
    return {isa:'i386', iterations, instructionsPerBlock:5, warmupMs:samples[0], jitMs:samples.slice(1),
      checksumLow32:Number(BigInt.asIntN(32, BigInt(expected)))};
  } finally {
    // Initialization failures can leave v86 waiting on a start event. Do not
    // let cleanup mask the serial watchdog; the harness closes the page.
    let cleanupTimer;
    try { await Promise.race([v86.destroy(), new Promise(resolve => { cleanupTimer = setTimeout(resolve, 2000); })]); }
    finally { clearTimeout(cleanupTimer); }
  }
}
