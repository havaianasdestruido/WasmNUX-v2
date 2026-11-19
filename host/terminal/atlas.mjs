import {probeFont} from './fonts.mjs';
import {layout} from './text.mjs';
const cellW = 13, cellH = 24;
const shader = `
struct Varyings { @builtin(position) position: vec4f, @location(0) uv: vec2f }
@group(0) @binding(0) var atlas: texture_2d<f32>;
@group(0) @binding(1) var atlasSampler: sampler;
@vertex fn vs(@builtin(vertex_index) v: u32, @location(0) rect: vec4f, @location(1) uv: vec4f) -> Varyings {
  let q = array<vec2f,6>(vec2f(0,0),vec2f(1,0),vec2f(0,1),vec2f(0,1),vec2f(1,0),vec2f(1,1))[v];
  return Varyings(vec4f(rect.xy + q * rect.zw,0,1), uv.xy + q * uv.zw);
}
@fragment fn fs(in: Varyings) -> @location(0) vec4f {
  return vec4f(1,1,1,textureSample(atlas, atlasSampler, in.uv).a);
}`;

export async function renderAtlas(device, lines, frames = 12) {
  const tokens = lines.map(line => layout(line));
  const entries = new Map();
  let atlasWidth = 0;
  for (const row of tokens) for (const {text, cells} of row) {
    if (!entries.has(text)) { entries.set(text, [atlasWidth, cells]); atlasWidth += cells * cellW; }
  }
  const atlasCanvas = new OffscreenCanvas(atlasWidth, cellH);
  const ctx = atlasCanvas.getContext('2d');
  ctx.font = probeFont;
  ctx.fillStyle = 'white';
  for (const [text, [x, cells]] of entries) {
    ctx.save(); ctx.beginPath(); ctx.rect(x, 0, cells * cellW, cellH); ctx.clip();
    ctx.fillText(text.normalize('NFC'), x, 19, cells * cellW); ctx.restore();
  }
  const atlas = device.createTexture({size:[atlasWidth,cellH], format:'rgba8unorm',
    usage:GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_DST});
  const atlasPixels = ctx.getImageData(0, 0, atlasWidth, cellH).data;
  device.queue.writeTexture({texture:atlas}, atlasPixels, {bytesPerRow:atlasWidth*4}, [atlasWidth,cellH]);
  const width = 640, height = lines.length * cellH, stride = Math.ceil(width*4/256)*256;
  const format = 'rgba8unorm';
  const output = device.createTexture({size:[width,height], format, usage:GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC});
  const pipeline = await device.createRenderPipelineAsync({layout:'auto', vertex:{module:device.createShaderModule({code:shader}), entryPoint:'vs', buffers:[{
    arrayStride:32, stepMode:'instance', attributes:[{shaderLocation:0,offset:0,format:'float32x4'},{shaderLocation:1,offset:16,format:'float32x4'}]
  }]}, fragment:{module:device.createShaderModule({code:shader}), entryPoint:'fs', targets:[{format,blend:{
    color:{srcFactor:'src-alpha',dstFactor:'one-minus-src-alpha'}, alpha:{srcFactor:'one',dstFactor:'one-minus-src-alpha'}
  }}]}});
  const group = device.createBindGroup({layout:pipeline.getBindGroupLayout(0), entries:[
    {binding:0, resource:atlas.createView()}, {binding:1, resource:device.createSampler()}
  ]});
  const geometry = new Float32Array(tokens.flatMap((row,y) => row.flatMap(({text,col,cells}) => [
    -1+2*col*cellW/width, 1-2*y*cellH/height, 2*cells*cellW/width, -2*cellH/height,
    entries.get(text)[0]/atlasWidth, 0, cells*cellW/atlasWidth, 1
  ])));
  const vertices = device.createBuffer({size:geometry.byteLength,usage:GPUBufferUsage.VERTEX|GPUBufferUsage.COPY_DST});
  device.queue.writeBuffer(vertices,0,geometry);
  const readback = device.createBuffer({size:stride*height, usage:GPUBufferUsage.COPY_DST|GPUBufferUsage.MAP_READ});
  const durationsMs = [];
  try {
    for (let i=0; i<=frames; i++) {
      const start = performance.now();
      const encoder = device.createCommandEncoder();
      const pass = encoder.beginRenderPass({colorAttachments:[{view:output.createView(), clearValue:[0,0,0,1],loadOp:'clear',storeOp:'store'}]});
      pass.setPipeline(pipeline); pass.setBindGroup(0,group); pass.setVertexBuffer(0,vertices);
      pass.draw(6,geometry.length/8); pass.end(); device.queue.submit([encoder.finish()]);
      await device.queue.onSubmittedWorkDone();
      if (i) durationsMs.push(performance.now()-start);
    }
    const copy = device.createCommandEncoder();
    copy.copyTextureToBuffer({texture:output},{buffer:readback,bytesPerRow:stride},[width,height]);
    device.queue.submit([copy.finish()]); await readback.mapAsync(GPUMapMode.READ);
    const bytes = new Uint8Array(readback.getMappedRange());
    const inkByRow = lines.map((_, row) => {
      let pixels = 0;
      for (let y = row*cellH; y < (row+1)*cellH; y++) for (let x = 0; x < width; x++) if (bytes[y*stride+x*4]) pixels++;
      return pixels;
    });
    if (inkByRow.some(n => !n)) throw new Error('empty terminal row after GPU readback');
    return {glyphs:geometry.length/8, uniqueAtlasEntries:entries.size, inkByRow, durationsMs};
  } finally { readback.destroy(); vertices.destroy(); output.destroy(); atlas.destroy(); }
}
