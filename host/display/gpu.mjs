export async function openGpu() {
  const adapter = await navigator.gpu?.requestAdapter();
  if (!adapter) return null;
  return {device:await adapter.requestDevice(), adapter:{...Object.fromEntries(
    ['vendor','architecture','device','description','isFallbackAdapter'].map(key => [key, adapter.info[key]]))}};
}
export async function scanout(device, width = 1920, height = 1080, frames = 16, offscreenTexture = false) {
  const context = offscreenTexture ? null : new OffscreenCanvas(width, height).getContext('webgpu');
  const format = navigator.gpu.getPreferredCanvasFormat();
  const textureSize = {width, height};
  context?.configure({device, format, usage:GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT});
  const source = device.createTexture({size:textureSize, format, usage:GPUTextureUsage.COPY_SRC | GPUTextureUsage.COPY_DST});
  const destination = context ? null : device.createTexture({size:textureSize, format, usage:GPUTextureUsage.COPY_DST});
  const stride = Math.ceil(width * 4 / 256) * 256;
  const frame = new Uint8Array(stride * height).fill(127);
  const durationsMs = [];
  try {
    device.pushErrorScope('validation');
    for (let i = 0; i <= frames; i++) {
      const start = performance.now();
      frame[0] = i;
      device.queue.writeTexture({texture:source}, frame, {bytesPerRow:stride}, textureSize);
      const encoder = device.createCommandEncoder();
      encoder.copyTextureToTexture({texture:source}, {texture:(context?.getCurrentTexture() ?? destination)}, textureSize);
      device.queue.submit([encoder.finish()]);
      await device.queue.onSubmittedWorkDone();
      if (i) durationsMs.push(performance.now() - start);
    }
    const error = await device.popErrorScope();
    if (error) throw new Error(error.message);
    return {width, height, frames, durationsMs, format, destination:context ? 'canvas' : 'offscreen-texture'};
  } finally { source.destroy(); destination?.destroy(); context?.unconfigure(); }
}
