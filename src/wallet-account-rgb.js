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

import { IWalletAccount, UnsupportedOperationError } from '@tetherto/wdk-wallet'

import WalletAccountReadOnlyRgb from './wallet-account-read-only-rgb.js'

/**
 * An RGB account, backed by rgb-lib's WebAssembly bindings and the snapshot they keep in
 * IndexedDB.
 *
 * Two things read differently here than on an account-based chain. A recipient is an RGB
 * invoice rather than an address, because the receiver has to say which UTXO the asset lands
 * on. And a transfer is not complete when the transaction confirms: the consignment has to
 * reach the recipient through a proxy and be validated there. `listTransfers` shows that
 * state; `refresh` advances it.
 */
export default class WalletAccountRgb extends IWalletAccount {
  /**
   * @param {import('./engine.js').default} engine - The open engine.
   * @param {number} index - The account index.
   */
  constructor (engine, index) {
    super()

    /** @private */
    this._engine = engine

    /** @private */
    this._index = index

    /** @private */
    this._readOnly = new WalletAccountReadOnlyRgb(engine)
  }

  /** @returns {number} The account index. */
  get index () {
    return this._index
  }

  /** @returns {string} The derivation path. */
  get path () {
    return this._engine.path
  }

  /**
   * Not available. The recovery phrase stays inside the WebAssembly engine, which signs
   * without handing the key back out; there is nothing to return that would not be a copy
   * of the secret in JavaScript memory.
   *
   * @throws {UnsupportedOperationError} Always.
   */
  get keyPair () {
    throw new UnsupportedOperationError('keyPair is not exposed by the RGB engine.')
  }

  /** @returns {Promise<string>} The wallet's Bitcoin address. */
  async getAddress () {
    return this._readOnly.getAddress()
  }

  /** @returns {Promise<bigint>} The spendable Bitcoin balance, in sats. */
  async getBalance () {
    return this._readOnly.getBalance()
  }

  /** @returns {Promise<Object>} The full Bitcoin balance, vanilla and colored. */
  async getBtcBalance () {
    return this._readOnly.getBtcBalance()
  }

  /**
   * @param {string} tokenAddress - The RGB asset id.
   * @returns {Promise<bigint>} The settled balance.
   */
  async getTokenBalance (tokenAddress) {
    return this._readOnly.getTokenBalance(tokenAddress)
  }

  /**
   * @param {string} assetId - The RGB asset id.
   * @returns {Promise<Object>} The balance, settled, future and spendable.
   */
  async getAssetBalance (assetId) {
    return this._readOnly.getAssetBalance(assetId)
  }

  /** @returns {Promise<Array<Object>>} The RGB assets this wallet holds. */
  async listAssets () {
    return this._readOnly.listAssets()
  }

  /**
   * @param {string} [assetId] - Restrict to one asset.
   * @returns {Promise<Array<Object>>} The transfers, newest first.
   */
  async listTransfers (assetId) {
    return this._readOnly.listTransfers(assetId)
  }

  /**
   * @param {string} hash - The txid.
   * @returns {Promise<Object | null>} The transfer that transaction produced.
   */
  async getTransactionReceipt (hash) {
    return this._readOnly.getTransactionReceipt(hash)
  }

  /** @returns {Promise<{ fee: bigint }>} The rate a Bitcoin send would bid, in sat/vB. */
  async quoteSendTransaction () {
    return this._readOnly.quoteSendTransaction()
  }

  /** @returns {Promise<{ fee: bigint }>} The rate an asset transfer would bid, in sat/vB. */
  async quoteTransfer () {
    return this._readOnly.quoteTransfer()
  }

  /** @returns {Promise<number>} Free allocation slots. */
  async getFreeSlots () {
    return this._readOnly.getFreeSlots()
  }

  /**
   * @returns {Promise<{ network: string, online: boolean, onlineError: string | null, persisted: boolean }>} What the wallet knows about its own situation.
   */
  async getStatus () {
    return this._readOnly.getStatus()
  }

  /** @returns {Promise<boolean | null>} Whether a backup is due. */
  async isBackupNeeded () {
    return this._readOnly.isBackupNeeded()
  }

  /**
   * Sends plain Bitcoin. Spends the vanilla keychain only, never a UTXO carrying an asset.
   *
   * @param {Object} tx - The transaction.
   * @param {string} tx.to - The destination address.
   * @param {number | bigint | string} tx.value - The amount in sats.
   * @param {number | bigint} [tx.feeRate] - The fee rate in sat/vB; estimated when omitted.
   * @returns {Promise<{ hash: string, fee: bigint }>} The transaction id and the rate it paid.
   */
  async sendTransaction (tx) {
    const feeRate = tx.feeRate ? BigInt(tx.feeRate) : await this._engine.feeRate()
    const { txid } = await this._engine.sendBtc({
      address: tx.to,
      amount: tx.value,
      feeRate
    })

    return { hash: txid, fee: feeRate }
  }

  /**
   * Transfers an RGB asset.
   *
   * `recipient` is an RGB invoice, not an address: the receiver decides which UTXO the asset
   * lands on, and the invoice is how they say so. It also names where the consignment is to
   * be delivered, and that endpoint takes precedence over the configured proxy.
   *
   * @param {Object} options - The transfer.
   * @param {string} options.token - The RGB asset id.
   * @param {string} options.recipient - The recipient's RGB invoice.
   * @param {number | bigint | string} options.amount - The amount, in the asset's base units.
   * @param {number | bigint} [options.feeRate] - The fee rate in sat/vB; estimated when omitted.
   * @returns {Promise<{ hash: string, fee: bigint, transfer: Object }>} The result.
   */
  async transfer (options) {
    const feeRate = options.feeRate ? BigInt(options.feeRate) : await this._engine.feeRate()
    const transfer = await this._engine.sendAsset({
      invoice: options.recipient,
      assetId: options.token,
      amount: options.amount,
      feeRate
    })

    return { hash: transfer.txid, fee: feeRate, transfer }
  }

  /**
   * Creates an invoice to receive an asset into a blinded UTXO, which tells the sender
   * nothing about this wallet beyond the identifier itself.
   *
   * @param {Object} [options] - The invoice.
   * @param {string} [options.assetId] - Restrict the invoice to one asset; any asset when omitted.
   * @param {number} [options.minutes] - How long the invoice stays valid.
   * @returns {Promise<Object>} The invoice, its recipient id and its expiry.
   */
  async receiveAsset (options = {}) {
    return this._engine.blindReceive(options)
  }

  /**
   * Creates an address to receive an asset through a witness transaction, which needs no
   * free allocation slot: the sender creates the output the asset lands on, and pays for it.
   *
   * @param {Object} [options] - The invoice.
   * @param {string} [options.assetId] - Restrict the invoice to one asset; any asset when omitted.
   * @param {number} [options.minutes] - How long the invoice stays valid.
   * @returns {Promise<Object>} The invoice.
   */
  async receiveAssetToWitness (options = {}) {
    return this._engine.witnessReceive(options)
  }

  /**
   * Issues a new asset, with the whole supply allocated to this wallet.
   *
   * @param {Object} options - The asset. See the engine's `issueAsset` for the fields.
   * @returns {Promise<Object>} The issued asset.
   */
  async issueAsset (options) {
    return this._engine.issueAsset(options)
  }

  /**
   * Signs a message as a BIP-322 simple signature, with the wallet's own address.
   *
   * @param {string} message - The message, signed verbatim.
   * @returns {Promise<string>} The signature, base64 encoded.
   */
  async sign (message) {
    const { signature } = await this._engine.signMessage(message)

    return signature
  }

  /**
   * The address a signature from {@link sign} is checked against, and the signature itself.
   *
   * @param {string} message - The message.
   * @returns {Promise<{ address: string, signature: string }>} Both halves.
   */
  async signMessage (message) {
    return this._engine.signMessage(message)
  }

  /**
   * Creates the empty colored UTXOs that receiving requires. Receiving with no free slot
   * fails, and slots take a confirmed on-chain transaction to make.
   *
   * @param {number | bigint} [feeRate] - The fee rate in sat/vB; estimated when omitted.
   * @returns {Promise<{ created: number, slots: number }>} What was created.
   */
  async createUtxos (feeRate) {
    return this._engine.createUtxos(feeRate)
  }

  /**
   * Brings the wallet's view of the chain up to date without touching RGB state. Cheap, and
   * what a balance reads after if it is to be current.
   *
   * @returns {Promise<void>} When the wallet is in step with the chain.
   */
  async sync () {
    return this._engine.sync()
  }

  /**
   * Picks up consignments and advances the transfers waiting on them. This is the step that
   * turns a transfer someone sent into an asset this wallet holds.
   *
   * @returns {Promise<Object>} What changed.
   */
  async refresh (assetId) {
    return this._engine.refresh(assetId)
  }

  /**
   * Fails the expired invoices and deletes the ones that never received anything, which
   * releases the allocation slots they were holding.
   *
   * @returns {Promise<Object>} What was released.
   */
  async cleanup () {
    return this._engine.cleanup()
  }

  /**
   * An encrypted backup of the whole wallet, including the consignments. The recovery phrase
   * alone cannot restore RGB assets.
   *
   * @param {string} password - The password to encrypt with.
   * @returns {Promise<Uint8Array>} The backup.
   */
  async createBackup (password) {
    return this._engine.backup(password)
  }

  /**
   * Restores a backup over this wallet. The recovery phrase must be the same one.
   *
   * @param {Uint8Array} bytes - The backup.
   * @param {string} password - The password it was encrypted with.
   * @returns {Promise<void>} When the backup is restored.
   */
  async restoreBackup (bytes, password) {
    return this._engine.restoreBackup(bytes, password)
  }

  /**
   * Runs a task against the rgb-lib wallet directly, in the same queue everything else uses.
   *
   * This is the escape hatch for capabilities this module does not wrap: a consumer that
   * ships its own build of the bindings, with methods upstream does not have, reaches them
   * here. The queue is the part that matters — every binding takes a mutable borrow for the
   * whole call, so a task that runs outside it can panic the engine mid-sync and leave it
   * unusable.
   *
   * The `online` handle is null when the wallet opened with no indexer; a task that needs
   * the chain must say so itself.
   *
   * @template T
   * @param {(wallet: Object, online: Object | null) => Promise<T> | T} task - The task.
   * @returns {Promise<T>} What it returned.
   */
  async runExclusive (task) {
    return this._engine.run(() => task(this._engine.wallet, this._engine.onlineHandle))
  }

  /**
   * The rgb-lib wallet this account is built on.
   *
   * Prefer {@link runExclusive}: a call made on this object directly does not go through the
   * queue, and two of those at once panic the engine.
   *
   * @returns {Object} The wallet.
   */
  getRgbWallet () {
    return this._engine.wallet
  }

  /** @returns {Promise<WalletAccountReadOnlyRgb>} A read-only view of this account. */
  async toReadOnlyAccount () {
    return this._readOnly
  }

  /** Closes the wallet and drops the engine's handle on the recovery phrase. */
  dispose () {
    this._engine.dispose()
  }
}
