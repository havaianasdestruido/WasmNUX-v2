import {serveWorker} from '../worker-rpc.mjs';
import {openGpu, scanout} from './gpu.mjs';
import {loadProbeFonts, rasterControls} from '../terminal/fonts.mjs';
import {renderAtlas} from '../terminal/atlas.mjs';
serveWorker(async () => {
  let gpu = await openGpu();
  if (!gpu) return {status:'unavailable', reason:'WebGPU adapter not exposed'};
  let canvasError;
  try {
    let scanoutResult;
    try { scanoutResult = await scanout(gpu.device); }
    catch (error) {
      // Headless shells can expose WebGPU compute but lack the shared-image
      // compositor. Keep upload+copy timing, label its different endpoint.
      if (error.name !== 'OperationError') throw error;
      canvasError = error.message;
      gpu.device.destroy();
      gpu = await openGpu();
      if (!gpu) throw error;
      scanoutResult = await scanout(gpu.device, 1920, 1080, 16, true);
    }
    await loadProbeFonts();
    const raster = rasterControls();
    if (!Object.values(raster).every(Boolean)) throw new Error(`font raster controls failed: ${JSON.stringify(raster)}`);
    const atlas = await renderAtlas(gpu.device, ['ASCII -> ffi !=', 'Wide: 界 日本', 'Combining: e\u0301', 'IME sample: 日本語']);
    return {status:'measured', adapter:gpu.adapter, scanout:{...scanoutResult, canvasError}, atlas:{...atlas, raster}};
  } finally { gpu?.device.destroy(); }
});
