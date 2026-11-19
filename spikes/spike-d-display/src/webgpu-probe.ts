/**
 * WebGPU capability probe (Spike D). Import-safe outside the browser.
 * In a browser it can measure the actual one-frame upload cost a display
 * worker would pay via queue.writeTexture (the scanout path).
 */
export interface WebGPUProbeReport {
  environment: 'browser' | 'node';
  available: boolean;
  adapterName: string | null;
  backend: string | null;
  limits: Record<string, number>;
  textureUploadMBps: number | null;   // measured via queue.writeTexture, 1080p RGBA frame
  notes: string[];
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyNav = any;

export async function probeWebGPU(): Promise<WebGPUProbeReport> {
  const nav: AnyNav | undefined = (globalThis as AnyNav).navigator;
  const gpu: AnyNav | undefined = nav?.gpu;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const isNode = !!(globalThis as any).process?.versions?.node;
  if (!gpu) {
    return {
      environment: isNode ? 'node' : 'browser',
      available: false,
      adapterName: null,
      backend: null,
      limits: {},
      textureUploadMBps: null,
      notes: ['navigator.gpu is not present. Tier-2 fallback (Canvas2D/WebGL) or software scanout required.'],
    };
  }
  const notes: string[] = [];
  const adapter = await gpu.requestAdapter({ powerPreference: 'high-performance' });
  if (!adapter) {
    return {
      environment: 'browser', available: false, adapterName: null, backend: null, limits: {}, textureUploadMBps: null,
      notes: ['requestAdapter() returned null: WebGPU present but no usable adapter (blocked GPU, VM, or missing drivers).'],
    };
  }
  const info = adapter.info ?? {};
  const device = await adapter.requestDevice();
  const limits: Record<string, number> = {};
  for (const key of ['maxTextureDimension2D', 'maxBufferSize', 'maxComputeWorkgroupStorageSize', 'maxStorageBufferBindingSize']) {
    if (typeof adapter.limits?.[key] === 'number') limits[key] = adapter.limits[key];
  }
  // Measure upload of one 1920x1080 RGBA frame (the browser-side scanout cost).
  const WIDTH = 1920, HEIGHT = 1080;
  const frameBytes = WIDTH * HEIGHT * 4;
  let textureUploadMBps: number | null = null;
  try {
    const texture = device.createTexture({
      size: { width: WIDTH, height: HEIGHT, depthOrArrayLayers: 1 },
      format: 'rgba8unorm',
      usage: 2 | 4, // COPY_DST | RENDER_ATTACHMENT
    });
    const data = new Uint8Array(frameBytes);
    for (let i = 0; i < data.length; i += 4096) data[i] = (i * 131) & 0xff;
    const REPS = 60;
    const t0 = performance.now();
    for (let i = 0; i < REPS; i++) {
      device.queue.writeTexture(
        { texture },
        data,
        { offset: 0, bytesPerRow: WIDTH * 4, rowsPerImage: HEIGHT },
        { width: WIDTH, height: HEIGHT, depthOrArrayLayers: 1 },
      );
    }
    await device.queue.onSubmittedWorkDone();
    const dt = performance.now() - t0;
    textureUploadMBps = (frameBytes * REPS) / (dt / 1000) / 1e6;
    notes.push(`writeTexture of a ${WIDTH}x${HEIGHT} RGBA frame x${REPS}: ${textureUploadMBps.toFixed(0)} MB/s`);
  } catch (e) {
    notes.push(`texture upload probe failed: ${String(e)}`);
  }
  if (device.destroy) device.destroy();
  return {
    environment: 'browser',
    available: true,
    adapterName: info.description ?? info.device ?? null,
    backend: info.backendType != null ? String(info.backendType) : null,
    limits,
    textureUploadMBps,
    notes,
  };
}
