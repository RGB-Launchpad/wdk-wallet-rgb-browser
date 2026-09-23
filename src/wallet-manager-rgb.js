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

import WalletManager from '@tetherto/wdk-wallet'

import Engine from './engine.js'
import WalletAccountRgb from './wallet-account-rgb.js'
import { feeFor } from './fee.js'
import { SLOTS, payableRate } from './slots.js'

/**
 * Public indexers, so the module works out of the box on the test networks. They are
 * mempool.space's own public deployment, not anything this package operates.
 */
const ESPLORA = {
  Mainnet: 'https://mempool.space/api',
  Signet: 'https://mempool.space/signet/api',
  Testnet4: 'https://mempool.space/testnet4/api'
}

/** BIP-44 coin type per network. */
const COIN_TYPE = { Mainnet: 0 }

/**
 * Configuration for an RGB wallet.
 *
 * There is deliberately no default proxy. A proxy relays consignments and therefore sees
 * recipient identifiers, so which one to trust is the consumer's decision, not this
 * package's.
 *
 * @typedef {Object} RgbWalletConfig
 * @property {string} [network] - The Bitcoin network: `Mainnet`, `Signet`, `Testnet4` or `Regtest`. Defaults to `Signet`.
 * @property {string} [esploraUrl] - The Esplora indexer. Defaults to mempool.space's public endpoint for the network; required on Regtest.
 * @property {string} [proxyUrl] - The RGB proxy that carries consignments. Required to receive or to send.
 * @property {Object} [bindings] - The rgb-lib WebAssembly bindings module. Defaults to `@utexo/rgb-lib-wasm`, imported on demand.
 * @property {number} [minConfirmations] - Confirmations an incoming transfer must reach. Defaults to 1.
 * @property {number} [invoiceMinutes] - How long an invoice stays valid. Defaults to 60.
 * @property {import('./fee.js').FeeParameters} [fee] - Fee bidding parameters.
 * @property {import('./slots.js').SlotParameters} [slots] - Allocation slot parameters.
 */

/**
 * A WDK wallet manager for RGB assets on Bitcoin, running in the browser.
 *
 * rgb-lib holds one wallet per recovery phrase and derives its own keychains inside it, so
 * this manager serves a single account, at index 0. Asking for another index is an error
 * rather than a silently different wallet.
 */
export default class WalletManagerRgb extends WalletManager {
  /**
   * @param {string} seedPhrase - The BIP-39 recovery phrase. Raw seed bytes are not enough: rgb-lib derives from the phrase.
   * @param {RgbWalletConfig} [config] - The configuration.
   */
  constructor (seedPhrase, config = {}) {
    super(seedPhrase, config)

    if (typeof seedPhrase !== 'string') {
      throw new TypeError('An RGB wallet needs the recovery phrase itself, not raw seed bytes.')
    }

    const network = config.network || 'Signet'
    const esploraUrl = config.esploraUrl || ESPLORA[network]

    if (!esploraUrl) {
      throw new Error(`No public indexer is known for ${network}; pass esploraUrl.`)
    }

    /** @private */
    this._mnemonic = seedPhrase

    const slots = { ...SLOTS, ...(config.slots || {}) }
    const fee = { ...feeFor(network), ...(config.fee || {}) }

    // The configured cap is an upper bound on what is sensible to pay. What a slot can pay
    // is a hard limit, and the two are set independently, so the lower of them wins. Without
    // this a busy network produces a bid the wallet cannot fund, and rgb-lib reports it as
    // insufficient allocations on a wallet that is plainly holding bitcoin.
    fee.max = Math.min(fee.max, payableRate(slots))

    /** @private */
    this._config = {
      network,
      esploraUrl,
      proxyUrl: config.proxyUrl || null,
      minConfirmations: config.minConfirmations ?? 1,
      invoiceMinutes: config.invoiceMinutes ?? 60,
      fee,
      slots,
      path: `m/86'/${COIN_TYPE[network] ?? 1}'/0'`
    }

    /** @private */
    this._bindings = config.bindings || null

    /** @private */
    this._engine = null

    /** @private */
    this._opening = null
  }

  /**
   * The account this wallet holds.
   *
   * @param {number} [index] - The account index. Only 0 exists.
   * @returns {Promise<WalletAccountRgb>} The account.
   * @throws {Error} If an index other than 0 is asked for.
   */
  async getAccount (index = 0) {
    if (index !== 0) {
      throw new Error(`An RGB wallet has one account; index ${index} does not exist.`)
    }

    if (!this._accounts[this._config.path]) {
      this._accounts[this._config.path] = new WalletAccountRgb(await this._open(), 0)
    }

    return this._accounts[this._config.path]
  }

  /**
   * @param {string} path - The derivation path.
   * @returns {Promise<WalletAccountRgb>} The account at that path.
   * @throws {Error} If the path is not this wallet's.
   */
  async getAccountByPath (path) {
    if (path !== this._config.path) {
      throw new Error(`An RGB wallet has one account, at ${this._config.path}.`)
    }

    return this.getAccount(0)
  }

  /**
   * What to bid now, in sat/vB. `fast` is the same reading with more headroom, capped by the
   * configured maximum; rgb-lib builds the transaction, so neither is a total.
   *
   * @returns {Promise<{ normal: bigint, fast: bigint }>} The fee rates.
   */
  async getFeeRates () {
    const engine = await this._open()
    const normal = await engine.feeRate()
    const fast = BigInt(Math.min(this._config.fee.max, Math.ceil(Number(normal) * 1.5)))

    return { normal, fast: fast > normal ? fast : normal }
  }

  /** Closes the wallet and forgets the recovery phrase held for it. */
  dispose () {
    this._engine?.dispose()
    this._engine = null
    this._opening = null
    this._accounts = {}
    this._mnemonic = null
  }

  /**
   * Opens the engine once, however many callers ask at the same time.
   *
   * @private
   * @returns {Promise<Engine>} The open engine.
   */
  async _open () {
    if (this._engine) return this._engine

    if (!this._opening) {
      this._opening = (async () => {
        if (!this._mnemonic) throw new Error('The wallet manager has been disposed.')

        const bindings = this._bindings || await import('@utexo/rgb-lib-wasm')
        const engine = new Engine(bindings, this._config)

        await engine.open(this._mnemonic)

        this._engine = engine

        return engine
      })()
    }

    return this._opening
  }
}
