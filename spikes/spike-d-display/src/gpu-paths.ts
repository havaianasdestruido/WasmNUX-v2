/**
 * Spike D — the four GPU acceleration paths from ADR-0007, scored on the two
 * axes the ADR must decide between: conformance (guest API coverage) and
 * expected performance class (relative, from capability modelling — the real
 * speed run happens in the browser harness `web/index.html`).
 *
 *   A. virgl-style GL          — virtio-gpu + Gallium relaying GL calls
 *   B. Venus/Vulkan            — virtio-gpu venus protocol (Vulkan serialization)
 *   C. WebGPU-shaped command stream via custom Mesa driver (leading option)
 *   D. lavapipe/llvmpipe       — software fallback, Wasm SIMD + threads
 */

export interface GpuFeature {
  id: string;
  name: string;
  /** Weight in the conformance score (rare/critical features weigh more). */
  weight: number;
}

export interface GpuPathAssessment {
  id: "A-gl-virgl" | "B-venus" | "C-webgpu-cmdstream" | "D-lavapipe";
  label: string;
  /** feature id → supported (2), partial (1), unsupported (0). */
  support: Record<string, number>;
  /** Estimated perf class 1 (slowest) .. 5 (native-like). */
  perfClass: number;
  /** Engineering effort 1 (small) .. 5 (large). */
  effort: number;
  notes: string;
}

export const FEATURES: GpuFeature[] = [
  { id: "gl33", name: "OpenGL 3.3 core", weight: 3 },
  { id: "gl45", name: "OpenGL 4.5", weight: 2 },
  { id: "vulkan11", name: "Vulkan 1.1", weight: 3 },
  { id: "vulkan13", name: "Vulkan 1.3", weight: 2 },
  { id: "compute", name: "Compute shaders", weight: 3 },
  { id: "xcb", name: "X11/Wayland interop", weight: 2 },
  { id: "headless", name: "Headless CI runs", weight: 1 },
  { id: "wayland", name: "Wayland direct render", weight: 2 },
  { id: "webgpuHost", name: "Host GPU via WebGPU (zero-copy targets)", weight: 3 },
  { id: "fallback", name: "Works with WebGPU disabled", weight: 2 },
];

export const PATHS: GpuPathAssessment[] = [
  {
    id: "A-gl-virgl",
    label: "(A) virgl-style GL relay",
    support: { gl33: 2, gl45: 1, vulkan11: 0, vulkan13: 0, compute: 1, xcb: 2, headless: 2, wayland: 1, webgpuHost: 1, fallback: 2 },
    perfClass: 3,
    effort: 3,
    notes: "Mature guest-side (QEMU+Crosvm use it); GL-only, no Vulkan, extra serialization hops.",
  },
  {
    id: "B-venus",
    label: "(B) Venus Vulkan serialization",
    support: { gl33: 0, gl45: 0, vulkan11: 2, vulkan13: 1, compute: 2, xcb: 2, headless: 2, wayland: 2, webgpuHost: 1, fallback: 2 },
    perfClass: 3,
    effort: 4,
    notes: "Vulkan 1.x coverage beats GL; Venus is ChromiumOS-proven but the driver surface is large.",
  },
  {
    id: "C-webgpu-cmdstream",
    label: "(C) WebGPU-shaped virtio-gpu + Mesa driver",
    support: { gl33: 2, gl45: 1, vulkan11: 1, vulkan13: 0, compute: 2, xcb: 2, headless: 2, wayland: 2, webgpuHost: 2, fallback: 2 },
    perfClass: 4,
    effort: 5,
    notes: "Maps guest commands close to host WebGPU: fewest translation layers, zero-copy scanout path; needs a new Mesa driver (largest effort).",
  },
  {
    id: "D-lavapipe",
    label: "(D) lavapipe/llvmpipe software (Wasm SIMD + threads)",
    support: { gl33: 2, gl45: 2, vulkan11: 2, vulkan13: 1, compute: 2, xcb: 2, headless: 2, wayland: 2, webgpuHost: 0, fallback: 2 },
    perfClass: 2,
    effort: 2,
    notes: "Highest conformance (it IS the guest driver), no host GPU; perf bounded by Wasm SIMD/threads.",
  },
];

export interface PathScore {
  id: GpuPathAssessment["id"];
  conformance: number;   // 0..100
  perfClass: number;
  effort: number;
  composite: number;     // conformance/10 weighted with perf, effort-penalised
}

export function scorePaths(paths: GpuPathAssessment[] = PATHS, features: GpuFeature[] = FEATURES): PathScore[] {
  const totalWeight = features.reduce((s, f) => s + f.weight, 0);
  return paths.map((p) => {
    let weighted = 0;
    for (const f of features) {
      weighted += (p.support[f.id] ?? 0) / 2 * f.weight;
    }
    const conformance = (weighted / totalWeight) * 100;
    const composite = (conformance / 100) * 0.5 * p.perfClass + (conformance / 100) * 0.5 * 5 - (p.effort / 5) * 0.5;
    return {
      id: p.id,
      conformance: Math.round(conformance * 10) / 10,
      perfClass: p.perfClass,
      effort: p.effort,
      composite: Math.round(composite * 1000) / 1000,
    };
  });
}

/**
 * WebGPU scanout availability probe — browser harness uses this to decide
 * between WebGPU upload and the Canvas2D fallback (capability detection rule
 * from ROADMAP §6).
 */
export type ScanoutBackend = "webgpu" | "canvas2d" | "none";

export function pickScanoutBackend(hasWebgpu: boolean, hasOffscreenCanvas: boolean): ScanoutBackend {
  const hasOffscreenCtor = hasOffscreenCanvas ||
    (typeof globalThis !== "undefined" && "OffscreenCanvas" in globalThis);
  if (hasWebgpu && hasOffscreenCtor) return "webgpu";
  if (hasOffscreenCtor) return "canvas2d";
  if (hasWebgpu) return "webgpu";
  return "none";
}
