export interface SmpRunOptions {
  harts: number;
  program: Uint8Array;
  entry: number;
  stackTop: number;
  budget: number;
  ramBytes?: number;
  ramBase?: number;
  /** Maximum wall-clock time including worker startup, in milliseconds (default 60 seconds). */
  timeoutMs?: number;
}

export interface SmpHartResult {
  hartId: number;
  stop: string;
  exitCode: number;
  instret: number;
  regs: number[];
}

export interface SmpRunResult {
  harts: SmpHartResult[];
  /** The shared guest RAM, so callers can verify shared-memory effects. */
  memory: WebAssembly.Memory;
}
