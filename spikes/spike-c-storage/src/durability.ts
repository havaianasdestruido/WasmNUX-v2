/**
 * Durability & quota policy helpers (Spike C).
 *
 * Browser-side probing of the APIs that decide whether the guest disk survives
 * eviction. Import-safe outside the browser; every probe feature-detects.
 */
export interface DurabilityReport {
  persistAvailable: boolean;
  persisted: boolean | null;      // null when unknown (prompt/permission or unavailable)
  estimateAvailable: boolean;
  quotaBytes: number | null;
  usageBytes: number | null;
  storageBucketsAvailable: boolean;
  opfsAvailable: boolean;
  recommendations: string[];
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Nav = any;

export async function probeDurability(): Promise<DurabilityReport> {
  const nav: Nav | undefined = (globalThis as Nav).navigator;
  const report: DurabilityReport = {
    persistAvailable: false,
    persisted: null,
    estimateAvailable: false,
    quotaBytes: null,
    usageBytes: null,
    storageBucketsAvailable: false,
    opfsAvailable: false,
    recommendations: [],
  };
  if (!nav) {
    report.recommendations.push('Not running in a browser: durability probing is a no-op here.');
    return report;
  }
  try {
    if (nav.storage?.persist) {
      report.persistAvailable = true;
      try { report.persisted = await nav.storage.persist(); } catch { report.persisted = null; }
    }
    if (nav.storage?.estimate) {
      report.estimateAvailable = true;
      const est = await nav.storage.estimate();
      report.quotaBytes = typeof est.quota === 'number' ? est.quota : null;
      report.usageBytes = typeof est.usage === 'number' ? est.usage : null;
    }
    report.storageBucketsAvailable = !!nav.storageBuckets;
    report.opfsAvailable = !!nav.storage?.getDirectory;
  } catch {
    report.recommendations.push('navigator.storage probing threw; treat storage as best-effort in this context.');
  }
  if (!report.persisted) {
    report.recommendations.push('Storage is not guaranteed persistent: request navigator.storage.persist() at first run and warn in-terminal when it is refused.');
  }
  if (report.quotaBytes !== null && report.usageBytes !== null && report.quotaBytes - report.usageBytes < 512 * 1024 * 1024) {
    report.recommendations.push('Less than 512 MiB of quota headroom: surface a low-space warning from the wnx CLI and suggest pruning/snapshot export.');
  }
  if (!report.storageBucketsAvailable) {
    report.recommendations.push('Storage Buckets API unavailable: durability of the base image vs. user data cannot be separated; treat ALL data as equally evictable and warn accordingly.');
  }
  if (!report.opfsAvailable) {
    report.recommendations.push('OPFS unavailable: block device cannot be backed by sync access handles; fall back to IndexedDB-backed blocks (slower) or refuse with a clear message.');
  }
  return report;
}

/**
 * Eviction-behavior decision table, encoded for `wnx doctor` / docs.
 * Sources: WHATWG Storage spec + Storage Buckets explainer; see docs/spikes/spike-c-storage.md.
 */
export const EVICTION_POLICY = {
  bestEffort: 'May be evicted under storage pressure; no user prompt. Default for transient caches.',
  persistent: 'navigator.storage.persist() granted: evicted only by explicit user action. Required for the guest root disk.',
  buckets: 'navigator.storageBuckets: separates durability classes within an origin (e.g. base image cache vs. instance data); not yet cross-browser.',
} as const;
