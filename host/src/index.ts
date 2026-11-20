/** Browser host primitives. No guest disk, shared devices, GPU or network backend yet. */
export { runBrowserSmp } from './smp.ts';
export {
  SnapshotStore,
  openOpfsSnapshot,
  MAX_SNAPSHOT_BYTES,
  MAX_PENDING_SNAPSHOTS,
} from './storage/snapshot.ts';
/** @deprecated Kept for source compatibility; host subsystems remain incomplete. */
export const HOST_PLACEHOLDER = true;
export { SnapshotBlockDevice, openOpfsBlockDevice, SECTOR_BYTES, MAX_DISK_SECTORS } from './storage/block.ts';
