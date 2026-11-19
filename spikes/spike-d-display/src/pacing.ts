/**
 * Frame-pacing model for the display worker (Spike D).
 * Pure functions; unit-tested. A frame is produced on each rAF/vsync tick;
 * the guest is only advanced to completion when the previous frame landed.
 */

export const HZ_60 = 60;
export const HZ_120 = 120;

export function frameBudgetMs(hz: number): number {
  if (hz <= 0) throw new RangeError('hz must be positive');
  return 1000 / hz;
}

/** Drop policy: if render+scanout exceeds the budget, skip compositing rather than queue. */
export function shouldDropFrame(renderMs: number, scanoutMs: number, hz: number): boolean {
  return renderMs + scanoutMs > frameBudgetMs(hz);
}

/** Steady-state input-to-photon estimate: input polling -> vCPU exec -> render -> scanout -> present. */
export interface LatencyModel {
  inputPollMs: number;
  vcpuAdvanceMs: number;
  renderMs: number;
  scanoutMs: number;
  presentMs: number;
}
export function inputToPhotonMs(m: LatencyModel): number {
  return m.inputPollMs + m.vcpuAdvanceMs + m.renderMs + m.scanoutMs + m.presentMs;
}

/** Worst case with zero overlap: polling interval aligned to the worst vsync phase. */
export function worstCaseInputToPhotonMs(m: LatencyModel, hz: number): number {
  return inputToPhotonMs(m) + frameBudgetMs(hz);
}

export interface FpsMeter { frames: number; dropped: number }
export function fps(meter: FpsMeter): number {
  const total = meter.frames + meter.dropped;
  return total === 0 ? 0 : meter.frames;
}
