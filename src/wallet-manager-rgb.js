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

import WalletManager, { UnsupportedOperationError } from '@tetherto/wdk-wallet'

import Engine from './engine.js'
import WalletAccountRgb from './wallet-account-rgb.js'
import { feeFor } from './fee.js'
import { SLOTS, payableRate } from './slots.js'
import { dataDirOf } from './snapshots.js'

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
 * @property {string} [dataDir] - Where the wallet's IndexedDB snapshot is keyed. Defaults to one derived from the network.
 * @property {string} [proxyUrl] - The RGB proxy that carries consignments. Required to receive or to send.
 * @property {string[]} [fallbackProxyUrls] - Further proxies an invoice names after `proxyUrl`, which a sender tries when the first cannot be reached. At most three proxies in all are written into an invoice.
 * @property {Object} [bindings] - The rgb-lib WebAssembly bindings module. Defaults to `@utexo/rgb-lib-wasm`, imported on demand.
 * @property {number} [minConfirmations] - Confirmations an incoming transfer must reach. Defaults to 1.
 * @property {number} [invoiceMinutes] - How long an invoice stays valid. Defaults to 60.
 * @property {number} [witnessSats] - Sats the sender parks on the output a witness transfer creates. Defaults to 1000.
 * @property {number} [vanillaKeychain] - The chain the wallet keeps its bitcoin on, under m/86'/coin'/0'. Defaults to 0, the chain of the identity address m/86'/coin'/0'/0/0. Set it for a phrase another wallet already uses on that address: the wallet then never spends what sits there, and still signs messages as that address.
 * @property {number} [coloredKeychain] - The chain the wallet keeps its RGB outputs on, under m/86'/827166'/0' (827167' off Mainnet). Defaults to 0, the chain rgb-lib uses. Set it for a phrase another rgb-lib wallet already uses: on the same chain each takes the other's asset outputs for empty ones, and spending one destroys the assets on it. Needs bindings that read `coloredKeychain` in their wallet data; opening with ones that do not fails.
 * @property {number} [identityCoinType] - With `vanillaKeychain` set, 0 puts the identity address at m/86'/0'/0'/0/0 on every network, as wallets that use coin type 0 everywhere have it. Defaults to the network's coin type.
 * @property {(task: () => Promise<any>) => Promise<any>} [queue] - Runs each engine command. Defaults to the module's own queue, which runs them one at a time in arrival order. A host that already runs every use of the wallet one at a time passes its own, such as `(task) => task()`.
 * @property {boolean} [deferOnline] - Open on the snapshot alone and reach the indexer later, with the account's `goOnline`. Defaults to false.
 * @property {string[]} [schemas] - The asset schemas the wallet accepts, such as `['Nia', 'Uda', 'Cfa']`. Defaults to `['Nia']` on Mainnet and `['Nia', 'Ifa']` elsewhere, which is what the published engine supports.
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

    // Two chains can both call themselves Regtest, and rgb-lib cannot tell them apart: the
    // snapshot would be loaded for the wrong one and BDK would refuse to sync against it.
    // A consumer that talks to more than one such chain gives each its own key.
    const dataDir = config.dataDir || dataDirOf(network)

    // The chain the wallet keeps its bitcoin on, under m/86'/coin'/0'. By default (0) it is
    // the chain of the identity address, m/86'/coin'/0'/0/0. A phrase that another wallet
    // already uses on that address keeps its bitcoin on another chain instead: this wallet then
    // never spends what sits there, and still signs as that address.
    const vanillaKeychain = config.vanillaKeychain ?? 0
    if (!Number.isInteger(vanillaKeychain) || vanillaKeychain < 0 || vanillaKeychain > 255) {
      throw new RangeError('vanillaKeychain is an integer from 0 to 255.')
    }

    // The chain the wallet keeps its RGB outputs on, under the colored account. By default (0)
    // it is rgb-lib's own. A phrase that another rgb-lib wallet already uses keeps them on
    // another chain: on a shared one each wallet takes the other's asset outputs for empty
    // ones, and spending one destroys the assets on it.
    const coloredKeychain = config.coloredKeychain ?? 0
    if (!Number.isInteger(coloredKeychain) || coloredKeychain < 0 || coloredKeychain > 255) {
      throw new RangeError('coloredKeychain is an integer from 0 to 255.')
    }

    /** @private */
    this._cfg = {
      network,
      dataDir,
      esploraUrl,
      proxyUrl: config.proxyUrl || null,
      fallbackProxyUrls: Array.isArray(config.fallbackProxyUrls) ? config.fallbackProxyUrls : [],
      minConfirmations: config.minConfirmations ?? 1,
      invoiceMinutes: config.invoiceMinutes ?? 60,
      // rgb-lib's own seal size. The sender pays it, which is the trade a witness invoice
      // makes: the recipient needs no slot of their own.
      witnessSats: config.witnessSats ?? 1000,
      // rgb-lib refuses to open a mainnet wallet that lists IFA.
      schemas: config.schemas || (network === 'Mainnet' ? ['Nia'] : ['Nia', 'Ifa']),
      deferOnline: !!config.deferOnline,
      vanillaKeychain,
      coloredKeychain,
      identityCoinType: config.identityCoinType === 0 ? 0 : null,
      // A host that orders work on the wallet itself (a task runtime) hands its own queue in;
      // without one, the module runs its commands one at a time in arrival order.
      queue: typeof config.queue === 'function' ? config.queue : null,
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
    if (typeof index === 'string') {
      throw new UnsupportedOperationError(
        'getAccount(signerName): an RGB wallet has no signers; the engine holds the keys.'
      )
    }
    if (index !== 0) {
      throw new Error(`An RGB wallet has one account; index ${index} does not exist.`)
    }

    if (!this._accounts[this._cfg.path]) {
      this._accounts[this._cfg.path] = new WalletAccountRgb(await this._open(), 0)
    }

    return this._accounts[this._cfg.path]
  }

  /**
   * @param {string} path - The derivation path.
   * @returns {Promise<WalletAccountRgb>} The account at that path.
   * @throws {Error} If the path is not this wallet's.
   */
  async getAccountByPath (path) {
    if (path !== this._cfg.path) {
      throw new Error(`An RGB wallet has one account, at ${this._cfg.path}.`)
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
    const fast = BigInt(Math.min(this._cfg.fee.max, Math.ceil(Number(normal) * 1.5)))

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
        const engine = new Engine(bindings, this._cfg)

        await engine.open(this._mnemonic)

        this._engine = engine

        return engine
      })()
    }

    return this._opening
  }
}
