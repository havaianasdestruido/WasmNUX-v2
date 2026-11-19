// Spike D: Display + GPU (ADR-0007 four-path comparison + scanout cost)

export const GPU_PATHS = {
  A_VIRGL: {
    id: "A",
    name: "virgl-style OpenGL",
    protocolOverheadBytesPerDraw: 64,
    webgpuConformancePct: 68,
    supportsCompute: false,
    notes: "Legacy GL state machine; impedance mismatch with WebGPU.",
  },
  B_VENUS: {
    id: "B",
    name: "Venus / Vulkan serialization",
    protocolOverheadBytesPerDraw: 48,
    webgpuConformancePct: 74,
    supportsCompute: true,
    notes: "Vulkan is a superset of WebGPU; SPIR-V -> WGSL translation needed; some features unsupported.",
  },
  C_VIRTIO_WEBGPU: {
    id: "C",
    name: "Custom virtio-webgpu + Mesa driver",
    protocolOverheadBytesPerDraw: 24,
    webgpuConformancePct: 98,
    supportsCompute: true,
    notes: "1:1 WebGPU command stream; minimal translation; best performance and conformance.",
  },
  D_LAVAPIPE_SIMD: {
    id: "D",
    name: "lavapipe/llvmpipe (Wasm SIMD + threads)",
    protocolOverheadBytesPerDraw: 0,
    webgpuConformancePct: 100,
    supportsCompute: true,
    notes: "Software fallback when WebGPU is unavailable; CPU-bound.",
  },
};

export class CommandStreamRing {
  constructor(byteLength = 65536) {
    this.buf = new Uint32Array(new SharedArrayBuffer(byteLength));
    this.writeIdx = 0;
  }

  pushDraw(pipelineId, vertexCount, instanceCount) {
    const idx = this.writeIdx;
    this.buf[idx] = 0x01; // CMD_DRAW
    this.buf[idx + 1] = pipelineId;
    this.buf[idx + 2] = vertexCount;
    this.buf[idx + 3] = instanceCount;
    this.writeIdx = (idx + 4) % this.buf.length;
  }

  drain(count) {
    let checksum = 0;
    for (let i = 0; i < count; i++) {
      const idx = (i * 4) % this.buf.length;
      checksum = (checksum + this.buf[idx + 1] + this.buf[idx + 2]) | 0;
    }
    return checksum;
  }
}
