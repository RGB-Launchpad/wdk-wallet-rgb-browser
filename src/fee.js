// Copyright 2026 RGB Launchpad
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

'use strict'

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
export const TEST_NETWORK_FEE = { safety: 3, min: 30, max: 500, blockVsize: 1_000_000 }

/** @type {FeeParameters} */
export const MAINNET_FEE = { safety: 1.25, min: 2, max: 100, blockVsize: 1_000_000 }

/**
 * The bidding parameters this module uses for a network when the caller passes none.
 *
 * @param {string} network - The Bitcoin network.
 * @returns {FeeParameters} The parameters.
 */
export const feeFor = (network) => (network === 'Mainnet' ? MAINNET_FEE : TEST_NETWORK_FEE)

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
export function clearingRate (histogram, fee = TEST_NETWORK_FEE) {
  let vsize = 0

  for (const [rate, size] of histogram || []) {
    vsize += size
    if (vsize >= fee.blockVsize) return rate
  }

  return 0
}

/**
 * What to bid, in sat/vB, from whatever rate signals were collected. Non-numbers are dropped
 * rather than poisoning the maximum, so a missing signal costs nothing.
 *
 * @param {number[]} rates - The collected rate signals.
 * @param {FeeParameters} fee - The bidding parameters.
 * @returns {number} The rate to bid.
 */
export function bid (rates, fee = TEST_NETWORK_FEE) {
  const usable = (rates || []).filter((n) => Number.isFinite(n) && n > 0)
  const top = Math.max(0, ...usable)

  return Math.min(fee.max, Math.max(fee.min, Math.ceil(top * fee.safety)))
}
