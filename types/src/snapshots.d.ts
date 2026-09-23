/**
 * Deletes the snapshots whose key starts with `prefix`.
 *
 * Nothing may hold the wallet open meanwhile: a running engine writes its snapshot back.
 *
 * @param {string} prefix - The key prefix, from {@link snapshotPrefix}.
 * @returns {Promise<number>} How many snapshots were deleted.
 */
export function deleteSnapshots(prefix: string): Promise<number>;
export const SNAPSHOT_DB: "rgb_lib_wallet";
export const SNAPSHOT_STORE: "snapshots";
export function dataDirOf(network: string): string;
export function snapshotPrefix(network: string): string;
export function isChainMismatch(message: unknown): boolean;
