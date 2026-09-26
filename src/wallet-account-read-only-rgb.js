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

import { UnsupportedOperationError, WalletAccountReadOnly } from '@tetherto/wdk-wallet'

/**
 * The reads of an RGB account, with nothing that signs. This is the view the WDK's policy
 * engine hands to a condition, so it must not expose a way to move anything.
 *
 * Where the WDK's vocabulary and RGB's differ, the WDK's wins and the RGB term is given in
 * the parameter's documentation: a "token" is an RGB asset id, and a transfer's "hash" is
 * the txid of the witness transaction.
 */
export default class WalletAccountReadOnlyRgb extends WalletAccountReadOnly {
  /**
   * @param {import('./engine.js').default} engine - The engine to read through.
   */
  constructor (engine) {
    super()

    /** @protected */
    this._engine = engine
  }

  /** @returns {Promise<string>} The wallet's Bitcoin address. */
  async getAddress () {
    return this._engine.run(() => this._engine.wallet.getAddress())
  }

  /**
   * The spendable Bitcoin balance, in sats.
   *
   * This is the vanilla balance: what a plain Bitcoin send may spend. The sats parked in the
   * UTXOs that carry assets are not here, because they are not free to spend — they pay the
   * fees of the transfers that move those assets. {@link getBtcBalance} returns both.
   *
   * @returns {Promise<bigint>} The balance in sats.
   */
  async getBalance () {
    const balance = await this.getBtcBalance()

    return BigInt(balance.vanilla.spendable)
  }

  /**
   * The full Bitcoin balance, vanilla and colored, settled and spendable.
   *
   * @returns {Promise<Object>} The balance.
   */
  async getBtcBalance () {
    return this._engine.run(() => this._engine.plain(this._engine.wallet.getBtcBalance()))
  }

  /**
   * The balance of one RGB asset.
   *
   * @param {string} tokenAddress - The RGB asset id.
   * @returns {Promise<bigint>} The settled balance, in the asset's own base units.
   */
  async getTokenBalance (tokenAddress) {
    const balance = await this.getAssetBalance(tokenAddress)

    return BigInt(balance.settled)
  }

  /**
   * The balance of one RGB asset, settled, future and spendable.
   *
   * @param {string} assetId - The RGB asset id.
   * @returns {Promise<Object>} The balance.
   */
  async getAssetBalance (assetId) {
    return this._engine.run(() =>
      this._engine.plain(this._engine.wallet.getAssetBalance(assetId)))
  }

  /**
   * The RGB assets this wallet holds, with the precision taken from contract metadata where
   * the list itself does not carry it.
   *
   * @returns {Promise<Array<Object>>} The assets.
   */
  async listAssets () {
    return this._engine.listAssets()
  }

  /**
   * The transfers, newest first, with a confirmation count on the ones still waiting.
   *
   * @param {string} [assetId] - Restrict to one asset; every transfer when omitted.
   * @returns {Promise<Array<Object>>} The transfers.
   */
  async listTransfers (assetId) {
    return this._engine.listTransfers(assetId)
  }

  /**
   * The transfer a witness transaction produced.
   *
   * @param {string} hash - The txid.
   * @returns {Promise<Object | null>} The transfer, or null when this wallet has none.
   */
  async getTransactionReceipt (hash) {
    const transfers = await this._engine.listTransfers()

    return transfers.find((t) => t.txid === hash) ?? null
  }

  /**
   * Not available: an RGB transfer anchors on-chain in a batch with others, so a witness
   * txid does not resolve into a per-transfer finality receipt. {@link getTransactionReceipt}
   * returns what this wallet knows about the transfer itself.
   *
   * @param {string} hash - The txid.
   * @returns {Promise<import('@tetherto/wdk-wallet').TransactionReceipt>} Never returns.
   * @throws {UnsupportedOperationError} Always.
   */
  async getTransaction (hash) { // eslint-disable-line no-unused-vars
    throw new UnsupportedOperationError(
      'getTransaction: RGB transfers anchor in batches, there is no per-transfer on-chain receipt.'
    )
  }

  /**
   * What a Bitcoin send would cost. RGB has no gas: the cost is the miner fee, and the rate
   * is what this wallet would bid now.
   *
   * @returns {Promise<{ fee: bigint }>} The quote.
   */
  async quoteSendTransaction () {
    return { fee: await this._engine.feeRate() }
  }

  /**
   * What an asset transfer would cost, as a fee rate in sat/vB. The transaction's size is
   * not known before rgb-lib builds it, so this is the rate, not the total.
   *
   * @returns {Promise<{ fee: bigint }>} The quote.
   */
  async quoteTransfer () {
    return { fee: await this._engine.feeRate() }
  }

  /**
   * Free allocation slots. Receiving an asset needs at least one.
   *
   * @returns {Promise<number>} How many allocations can still be received.
   */
  async getFreeSlots () {
    return this._engine.freeSlots()
  }

  /**
   * What the wallet knows about its own situation: the network it is on, whether the
   * indexer was reachable when it opened and why not if it was not, and whether the browser
   * granted persistent storage.
   *
   * A wallet opens whether or not the indexer answers, so a consumer that does not check
   * this will show stale balances as though they were current.
   *
   * @returns {Promise<{ network: string, online: boolean, onlineError: string | null, persisted: boolean }>} The status.
   */
  async getStatus () {
    return {
      network: this._engine.network,
      online: this._engine.online,
      onlineError: this._engine.onlineError,
      persisted: this._engine.persisted
    }
  }

  /**
   * Whether the wallet has changed since its last backup. The recovery phrase alone cannot
   * restore RGB assets: the consignments live only on this device.
   *
   * @returns {Promise<boolean | null>} True when a backup is due, null when unknown.
   */
  async isBackupNeeded () {
    return this._engine.run(() => {
      try {
        return this._engine.wallet.backupInfo()
      } catch {
        return null
      }
    })
  }
}
