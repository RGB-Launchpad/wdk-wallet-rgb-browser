/**
 * Rate that clears the front of the mempool: walk the histogram down until one block is
 * full. Esplora returns `fee_histogram` as `[[sat/vB, vsize], …]`, highest rate first.
 *
 * Returns 0 when the whole queue fits in one block — nothing has to be outbid, so the floor
 * in {@link bid} decides.
 *
 * @param {Array<[number, number]>} histogram - The mempool histogram.
 * @param {FeeParameters} fee - The bidding parameters.
 * @returns {number} The clearing rate in sat/vB.
 */
export function clearingRate(histogram: Array<[number, number]>, fee?: FeeParameters): number;
/**
 * What to bid, in sat/vB, from whatever rate signals were collected. Non-numbers are dropped
 * rather than poisoning the maximum, so a missing signal costs nothing.
 *
 * @param {number[]} rates - The collected rate signals.
 * @param {FeeParameters} fee - The bidding parameters.
 * @returns {number} The rate to bid.
 */
export function bid(rates: number[], fee?: FeeParameters): number;
/**
 * Bidding parameters. A caller that knows its network better should say so; these are the
 * values this module bids with when nothing is passed.
 *
 * `min` does the real work. Measured on signet in September 2026: blocks were clearing at
 * 4.07 sat/vB while the indexer's own estimate returned 0.1, and a transaction built on that
 * estimate sat in the mempool. A floor costs little on a test network and prevents that.
 *
 * @typedef {Object} FeeParameters
 * @property {number} safety - Multiplier on what the front of the mempool is clearing at.
 * @property {number} min - Floor, in sat/vB.
 * @property {number} max - Cap, in sat/vB, so a spam burst cannot price the wallet out.
 * @property {number} blockVsize - One block's worth of transactions, for walking the histogram.
 */
/** @type {FeeParameters} */
export const TEST_NETWORK_FEE: FeeParameters;
/** @type {FeeParameters} */
export const MAINNET_FEE: FeeParameters;
export function feeFor(network: string): FeeParameters;
/**
 * Bidding parameters. A caller that knows its network better should say so; these are the
 * values this module bids with when nothing is passed.
 *
 * `min` does the real work. Measured on signet in September 2026: blocks were clearing at
 * 4.07 sat/vB while the indexer's own estimate returned 0.1, and a transaction built on that
 * estimate sat in the mempool. A floor costs little on a test network and prevents that.
 */
export type FeeParameters = {
    /**
     * - Multiplier on what the front of the mempool is clearing at.
     */
    safety: number;
    /**
     * - Floor, in sat/vB.
     */
    min: number;
    /**
     * - Cap, in sat/vB, so a spam burst cannot price the wallet out.
     */
    max: number;
    /**
     * - One block's worth of transactions, for walking the histogram.
     */
    blockVsize: number;
};
