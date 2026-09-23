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

import { bid, clearingRate } from './fee.js'
import { buildToSignPsbt, extractWitness, signatureFromWitness } from './bip322.js'
import { explainReceiveError, explainSendError, freeSlots, slotBlocker, slotsToCreate } from './slots.js'
import serialQueue from './serial-queue.js'

/**
 * wasm-bindgen's initialiser is not safe to enter twice at once: the second call runs the
 * same one-shot closure and fails with "FnOnce called more than once". Two wallets on one
 * page is an ordinary thing to want, so the first caller's promise is shared with the rest.
 *
 * Keyed by the bindings module, so injecting a different build still initialises it.
 *
 * @type {WeakMap<Object, Promise<unknown>>}
 */
const initialising = new WeakMap()

/**
 * Indexers set cache headers — blockstream/esplora sends `max-age=10` — and a browser obeys
 * them. A wallet asking "is this transfer confirmed now" that is answered from the cache
 * reports a stale chain, and polling faster than the cache lifetime never sees the answer
 * change. These reads always go to the network.
 *
 * rgb-lib's own requests are outside this module's reach, so a wallet can never be more
 * current than the indexer's headers allow.
 */
const NO_CACHE = { cache: 'no-store' }

/**
 * How many coloured addresses to rotate through looking for a recipient id the proxy does not
 * already hold. Each attempt is one round trip, so this is also a bound on how long the engine
 * is held for one invoice.
 */
const WITNESS_ADDRESS_ATTEMPTS = 10

/**
 * The wallet as rgb-lib sees it, plus everything a browser needs around it: one command at
 * a time, the snapshot key the network demands, and the reads that go to the indexer rather
 * than to the engine.
 *
 * The accounts are thin wrappers over this. It is not exported from the package: consumers
 * hold an account, not an engine.
 */
export default class Engine {
  /**
   * @param {Object} bindings - The rgb-lib WebAssembly bindings module.
   * @param {Object} config - The resolved wallet configuration.
   */
  constructor (bindings, config) {
    /** @private */
    this._bindings = bindings

    /** @private */
    this._config = config

    /** @private */
    this._queue = serialQueue()

    /** @private */
    this._wallet = null

    /** @private */
    this._online = null

    /** @private */
    this._onlineError = null

    /** @private */
    this._persisted = false

    /** @private */
    this._transferArgument = null
  }

  /** @returns {Object} The rgb-lib wallet. */
  get wallet () {
    if (!this._wallet) throw new Error('The wallet is not open.')
    return this._wallet
  }

  /** @returns {string} The derivation path this account reports. */
  get path () {
    return this._config.path
  }

  /** @returns {string} The Bitcoin network. */
  get network () {
    return this._config.network
  }

  /** @returns {boolean} Whether the indexer was reachable when the wallet opened. */
  get online () {
    return !!this._online
  }

  /**
   * The indexer handle as rgb-lib wants it, or null when the wallet opened offline.
   *
   * @returns {Object | null} The handle.
   */
  get onlineHandle () {
    return this._online
  }

  /** @returns {string | null} Why going online failed, when it did. */
  get onlineError () {
    return this._onlineError
  }

  /**
   * Whether the browser granted persistent storage. Without it the snapshot — and with it
   * the consignments that are the assets — can be evicted under storage pressure, and the
   * recovery phrase alone cannot bring them back.
   *
   * @returns {boolean} True when storage is persistent.
   */
  get persisted () {
    return this._persisted
  }

  /**
   * Runs one engine command, alone.
   *
   * @template T
   * @param {() => Promise<T> | T} task - The command.
   * @returns {Promise<T>} What it returned.
   */
  run (task) {
    return this._queue(task)
  }

  /**
   * Converts BigInt to string, so a result can cross a structured-clone boundary such as a
   * worker or an extension message channel.
   *
   * @param {unknown} value - The value.
   * @returns {unknown} The converted value.
   */
  plain (value) {
    return JSON.parse(JSON.stringify(value, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)))
  }

  /**
   * Opens the wallet: initialises the WebAssembly module, restores the keys, builds the
   * rgb-lib wallet on its IndexedDB snapshot and tries to reach the indexer.
   *
   * Going online is allowed to fail. Balances, the asset list and a backup all work from the
   * snapshot, and a wallet that refuses to open because someone else's server is down is
   * worse than one that opens read-only.
   *
   * @param {string} mnemonic - The BIP-39 recovery phrase.
   * @returns {Promise<void>} When the wallet is open.
   */
  async open (mnemonic) {
    // The module's default export is wasm-bindgen's initialiser, which fetches and
    // instantiates the binary. The named `init` is rgb-lib's own and needs that to have run
    // first, so it is not what goes here.
    const { default: initWasm, restoreKeys, WasmWallet } = this._bindings

    if (!initialising.has(this._bindings)) {
      initialising.set(this._bindings, initWasm())
    }

    await initialising.get(this._bindings)

    const keys = restoreKeys(this._config.network, mnemonic)

    this._wallet = await WasmWallet.create(JSON.stringify({
      // The IndexedDB key is `dataDir/<master fingerprint>`. It carries the network by
      // default, because a shared key loads the other chain's snapshot and BDK rejects it.
      dataDir: this._config.dataDir,
      bitcoinNetwork: this._config.network,
      databaseType: 'Sqlite',
      maxAllocationsPerUtxo: this._config.slots.maxAllocationsPerUtxo,
      accountXpubVanilla: keys.accountXpubVanilla,
      accountXpubColored: keys.accountXpubColored,
      mnemonic,
      masterFingerprint: keys.masterFingerprint,
      vanillaKeychain: null,
      // rgb-lib refuses to open a mainnet wallet that lists IFA.
      supportedSchemas: this._config.network === 'Mainnet' ? ['Nia'] : ['Nia', 'Ifa'],
      // Pins the address index, so the wallet's address is stable across sessions.
      reuseAddresses: true
    }))

    await this._wallet.flush()

    this._persisted = await this._requestPersistence()

    try {
      this._online = await this._wallet.goOnline(true, this._config.esploraUrl)
      this._onlineError = null
    } catch (error) {
      this._online = null
      this._onlineError = String(error?.message || error)
    }
  }

  /**
   * The indexer handle, for the calls that need one.
   *
   * @returns {Object} The handle.
   * @throws {Error} If the indexer could not be reached.
   */
  needOnline () {
    if (!this._wallet) throw new Error('The wallet is not open.')

    if (!this._online) {
      throw new Error(`The indexer is unreachable${this._onlineError ? `: ${this._onlineError}` : ''}.`)
    }

    return this._online
  }

  /**
   * The asset list, with the precision taken from contract metadata where the list itself
   * does not carry it.
   *
   * @returns {Promise<Array<Object>>} The assets.
   */
  async listAssets () {
    return this.run(() => {
      const list = this.plain(this.wallet.listAssets([]))
      const out = []

      for (const asset of [...(list.nia || []), ...(list.ifa || [])]) {
        let precision = asset.precision ?? null

        try {
          precision = this.plain(this.wallet.getAssetMetadata(asset.assetId)).precision ?? precision
        } catch {
          // The list's own value stands; metadata is an improvement, not a requirement.
        }

        out.push({
          assetId: asset.assetId,
          ticker: asset.ticker,
          name: asset.name,
          precision,
          balance: asset.balance
        })
      }

      return out
    })
  }

  /**
   * The transfers, newest first, with a confirmation count on the ones still waiting.
   *
   * @param {string} [assetId] - Restrict to one asset.
   * @returns {Promise<Array<Object>>} The transfers.
   */
  async listTransfers (assetId) {
    const transfers = await this.run(() =>
      this.plain(this._listTransfers(assetId)).slice().reverse())

    return this._withConfirmations(transfers)
  }

  /**
   * Free allocation slots. Receiving needs at least one.
   *
   * @returns {Promise<number>} How many allocations can still be received.
   */
  async freeSlots () {
    return this.run(() => freeSlots(this.wallet.listUnspents(false), this._config.slots))
  }

  /**
   * What to bid, in sat/vB, from the mempool's own queue and the indexer's estimate.
   *
   * @returns {Promise<bigint>} The rate.
   */
  async feeRate () {
    const fee = this._config.fee
    const signals = []

    try {
      signals.push(clearingRate(await this._mempoolHistogram(), fee))
    } catch {
      // An indexer without /mempool tells us nothing; the floor still applies.
    }

    try {
      signals.push(Number(await this.wallet.getFeeEstimation(this.needOnline(), 1)))
    } catch {
      // A fresh chain has no estimate to give.
    }

    return BigInt(bid(signals, fee))
  }

  /**
   * Creates the empty colored UTXOs that receiving requires.
   *
   * @param {number | bigint} [feeRate] - The fee rate; estimated when omitted.
   * @returns {Promise<{ created: number, slots: number }>} What was created.
   */
  async createUtxos (feeRate) {
    const online = this.needOnline()
    const rate = feeRate ? BigInt(feeRate) : await this.feeRate()

    return this.run(async () => {
      await this.wallet.sync(online)

      const count = slotsToCreate(this.plain(this.wallet.listUnspents(false)), this._config.slots)

      if (count === 0) {
        return { created: 0, slots: freeSlots(this.wallet.listUnspents(false), this._config.slots) }
      }

      const blocked = slotBlocker(this.wallet.getBtcBalance().vanilla, rate, count, this._config.slots)

      if (blocked) throw new Error(blocked)

      // `upTo` is false. With it true, rgb-lib counts every UTXO that still has room for an
      // allocation, including ones already holding assets, and creates nothing.
      const psbt = await this.wallet.createUtxosBegin(
        online, false, count, this._config.slots.utxoSizeSat, rate, false)
      const signed = this.wallet.signPsbt(psbt)
      const created = await this.wallet.createUtxosEnd(online, signed, false)

      await this.wallet.flush()

      return { created, slots: freeSlots(this.wallet.listUnspents(false), this._config.slots) }
    })
  }

  /**
   * Creates an invoice to receive an asset into a blinded UTXO.
   *
   * A proxy is required: the invoice has to name where the sender delivers the consignment,
   * and without one the sender has nowhere to put it.
   *
   * @param {Object} [options] - The invoice.
   * @param {string} [options.assetId] - Restrict to one asset; any asset when omitted.
   * @param {number} [options.minutes] - How long the invoice stays valid.
   * @returns {Promise<Object>} The invoice.
   */
  async blindReceive ({ assetId, minutes } = {}) {
    this.needOnline()

    if (!this._config.proxyUrl) {
      throw new Error('No proxyUrl is configured. An invoice must name where the consignment goes.')
    }

    return this.run(async () => {
      if (freeSlots(this.wallet.listUnspents(false), this._config.slots) < 1) {
        throw new Error('No free allocation slot. Create slots before receiving.')
      }

      let invoice

      try {
        // `undefined` means any asset; the bindings reject null.
        invoice = this.wallet.blindReceive(
          assetId || undefined,
          'Any',
          (minutes || this._config.invoiceMinutes) * 60,
          [this._config.proxyUrl],
          this._config.minConfirmations
        )
      } catch (error) {
        throw new Error(explainReceiveError(error?.message || error))
      }

      await this.wallet.flush()

      return this.plain(invoice)
    })
  }

  /**
   * Creates an address to receive an asset through a witness transaction, which needs no
   * free allocation slot: the sender creates the output that carries the asset.
   *
   * The sender pays for that output, so a witness receive costs the sender more than a blind
   * one. It is what a wallet with no slots can still do.
   *
   * @param {Object} [options] - The invoice.
   * @param {string} [options.assetId] - Restrict to one asset; any asset when omitted.
   * @param {number} [options.minutes] - How long the invoice stays valid.
   * @returns {Promise<Object>} The invoice.
   */
  async witnessReceive ({ assetId, minutes } = {}) {
    this.needOnline()

    if (!this._config.proxyUrl) {
      throw new Error('No proxyUrl is configured. An invoice must name where the consignment goes.')
    }

    return this.run(async () => {
      // A wallet pins its addresses so its identity stays put, which means a witness invoice
      // would name the same output script — and so the same recipient id — every time. A
      // proxy holds one consignment per recipient id and refuses the second, so every
      // invoice after the first would be unusable.
      //
      // Rotating once is not enough either: a wallet restored from its recovery phrase
      // starts the index again, and an invoice that expired unused leaves no trace on the
      // chain, only on the proxy. So the proxy is the one asked. Only the coloured keychain
      // rotates; the identity address is on the vanilla one and does not move.
      for (let attempt = 0; attempt < WITNESS_ADDRESS_ATTEMPTS; attempt++) {
        this.wallet.rotateAddress(0)

        const invoice = this.plain(this.wallet.witnessReceive(
          assetId || undefined,
          'Any',
          (minutes || this._config.invoiceMinutes) * 60,
          [this._config.proxyUrl],
          this._config.minConfirmations
        ))

        if (!await this._proxyHolds(invoice.recipientId ?? invoice.recipient_id)) {
          await this.wallet.flush()

          return invoice
        }
      }

      throw new Error('Could not find an unused receiving address. Try again later.')
    })
  }

  /**
   * Whether the proxy already holds a consignment for this recipient id, which makes the id
   * unusable: it keeps one per id and refuses to replace it.
   *
   * @private
   * @param {string} recipientId - The recipient id.
   * @returns {Promise<boolean>} True when the id is taken.
   */
  async _proxyHolds (recipientId) {
    const url = String(this._config.proxyUrl)
      .replace(/^rpcs:\/\//, 'https://')
      .replace(/^rpc:\/\//, 'http://')

    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'consignment.get',
        params: { recipient_id: recipientId }
      }),
      signal: AbortSignal.timeout(8000)
    })

    if (!response.ok) throw new Error(`The RGB proxy answered ${response.status}.`)

    const body = await response.json()

    if (body.result?.consignment) return true

    // -400 is "consignment file not found", which is what a free id looks like.
    if (body.error?.code === -400) return false

    throw new Error(`The RGB proxy said: ${body.error?.message || 'something unexpected'}.`)
  }

  /**
   * Issues a new asset. The whole supply is allocated to this wallet, spread over the
   * amounts given, and each amount takes an allocation slot.
   *
   * @param {Object} options - The asset.
   * @param {string} options.ticker - The ticker.
   * @param {string} options.name - The name.
   * @param {number} options.precision - Decimal places.
   * @param {Array<number | bigint | string>} options.amounts - The issued amounts, one per allocation.
   * @param {'Nia' | 'Ifa'} [options.schema] - `Nia` is fixed supply, `Ifa` can be inflated later. Defaults to `Nia`.
   * @param {Array<number | bigint | string>} [options.inflationAmounts] - Inflation allowances, for `Ifa` only.
   * @param {string} [options.rejectListUrl] - Reject list, for `Ifa` only.
   * @returns {Promise<Object>} The issued asset.
   */
  async issueAsset (options) {
    const { ticker, name, precision, amounts, schema = 'Nia' } = options

    if (!ticker || !name) throw new Error('An asset needs a ticker and a name.')
    if (!Array.isArray(amounts) || !amounts.length) throw new Error('An asset needs an amount.')
    if (!Number.isInteger(precision)) throw new Error('Precision must be an integer.')

    if (schema === 'Ifa' && this.network === 'Mainnet') {
      throw new Error('rgb-lib does not open a mainnet wallet that supports IFA, so it cannot issue one.')
    }

    return this.run(async () => {
      if (freeSlots(this.wallet.listUnspents(false), this._config.slots) < amounts.length) {
        throw new Error(`Issuing ${amounts.length} allocations needs ${amounts.length} free slots. Create slots first.`)
      }

      const values = amounts.map((a) => BigInt(a))

      const asset = schema === 'Ifa'
        ? this.wallet.issueAssetIfa(
          ticker,
          name,
          precision,
          values,
          (options.inflationAmounts || []).map((a) => BigInt(a)),
          options.rejectListUrl ?? undefined
        )
        : this.wallet.issueAssetNia(ticker, name, precision, values)

      await this.wallet.flush()

      return this.plain(asset)
    })
  }

  /**
   * Signs a message with the wallet's own address, as a BIP-322 simple signature.
   *
   * rgb-lib exposes no message signing, so the message is wrapped in the pair of virtual
   * transactions BIP-322 defines and the wallet signs that PSBT. The signature is the
   * resulting witness stack.
   *
   * @param {string} message - The message, signed verbatim.
   * @returns {Promise<{ address: string, signature: string }>} The address and the signature.
   */
  async signMessage (message) {
    if (typeof message !== 'string' || !message) throw new Error('A message is required.')

    return this.run(async () => {
      const address = this.wallet.getAddress()
      const psbt = await buildToSignPsbt(address, message)
      const signed = this.wallet.signPsbt(psbt)

      return { address, signature: signatureFromWitness(extractWitness(signed)) }
    })
  }

  /**
   * Brings the wallet's view of the chain up to date, without touching RGB state.
   *
   * This is the cheap half of {@link refresh}: balances and UTXOs become current, but nothing
   * fetches or validates a consignment. Reading a balance without it shows the last figures
   * the wallet happened to see.
   *
   * @returns {Promise<void>} When the wallet is in step with the chain.
   */
  async sync () {
    const online = this.needOnline()

    return this.run(async () => {
      await this.wallet.sync(online)
    })
  }

  /**
   * Picks up consignments and advances the transfer state machine. The cost grows with the
   * transfer history, because every consignment is validated on the device.
   *
   * @param {string} [assetId] - Restrict to one asset.
   * @returns {Promise<Object>} What changed.
   */
  async refresh (assetId) {
    const online = this.needOnline()

    return this.run(async () => {
      const started = Date.now()

      await this.wallet.sync(online)

      const changed = this.plain(await this.wallet.refresh(online, assetId ?? undefined, [], false))

      await this.wallet.flush()

      return { ms: Date.now() - started, changed }
    })
  }

  /**
   * Fails the expired invoices and deletes the ones that never received anything, which
   * releases the allocation slots they were holding.
   *
   * The sweep only reaches transfers that are waiting for the counterparty and have expired.
   * A dangling invoice holds its slot until then.
   *
   * @returns {Promise<Object>} What was released.
   */
  async cleanup () {
    const online = this.needOnline()

    return this.run(async () => {
      const failed = await this.wallet.failTransfers(online, undefined, false, false)
      let deleted = false

      try {
        deleted = this.wallet.deleteTransfers(undefined, true)
      } catch {
        // Nothing to delete.
      }

      await this.wallet.flush()

      return {
        failed,
        deleted,
        slots: freeSlots(this.wallet.listUnspents(false), this._config.slots)
      }
    })
  }

  /**
   * An encrypted backup of the whole wallet. The recovery phrase alone cannot restore RGB
   * assets: the consignments are held only here.
   *
   * @param {string} password - The password to encrypt with.
   * @returns {Promise<Uint8Array>} The backup.
   */
  async backup (password) {
    if (!password) throw new Error('A backup password is required.')

    return this.run(() => this.wallet.backup(password))
  }

  /**
   * Restores a backup over this wallet.
   *
   * @param {Uint8Array} bytes - The backup.
   * @param {string} password - The password it was encrypted with.
   * @returns {Promise<void>} When the backup is restored.
   */
  async restoreBackup (bytes, password) {
    if (!bytes?.length) throw new Error('The backup is empty.')

    return this.run(async () => {
      this.wallet.restoreBackup(new Uint8Array(bytes), password)

      await this.wallet.flush()
    })
  }

  /**
   * Sends an asset to an invoice.
   *
   * The invoice's own transport endpoints take precedence over the configured one: the
   * consignment has to land where the recipient looks for it.
   *
   * @param {Object} options - The send.
   * @param {string} options.invoice - The RGB invoice.
   * @param {string} [options.assetId] - The asset; taken from the invoice when omitted.
   * @param {bigint | number | string} options.amount - The amount, in the asset's own precision.
   * @param {number | bigint} [options.feeRate] - The fee rate; estimated when omitted.
   * @returns {Promise<Object>} The transfer rgb-lib recorded.
   */
  async sendAsset ({ invoice, assetId, amount, feeRate }) {
    const online = this.needOnline()
    const data = this.plain(new this._bindings.WasmInvoice(String(invoice || '').trim()).invoiceData())

    if (data.network && String(data.network).toLowerCase() !== String(this.network).toLowerCase()) {
      throw new Error(`The invoice is for ${data.network}, the wallet is on ${this.network}.`)
    }

    if (data.assetId && assetId && data.assetId !== assetId) {
      throw new Error('The invoice names a different asset.')
    }

    const value = BigInt(amount)

    if (value <= 0n) throw new Error('The amount must be greater than 0.')

    const endpoints = data.transportEndpoints?.length
      ? data.transportEndpoints
      : (this._config.proxyUrl ? [this._config.proxyUrl] : [])

    if (!endpoints[0]) {
      throw new Error('The invoice carries no consignment endpoint and no proxyUrl is configured.')
    }

    const rate = feeRate ? BigInt(feeRate) : await this.feeRate()

    return this.run(async () => {
      await this.wallet.sync(online)

      const recipient = (fungible) => ({
        [assetId || data.assetId]: [{
          recipientId: data.recipientId,
          witnessData: undefined, // blind mode carries no witness data
          assignment: { Fungible: fungible },
          transportEndpoints: endpoints
        }]
      })

      let psbt

      try {
        try {
          psbt = await this.wallet.sendBegin(
            online, recipient(value), false, rate, this._config.minConfirmations)
        } catch (error) {
          // Amounts pass as BigInt. Number loses precision past 2^53 and real supplies sit
          // above it, so the Number path is only taken when the value fits exactly.
          if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
            throw new Error(`The amount exceeds 2^53 and the bindings rejected BigInt: ${error?.message || error}`)
          }

          psbt = await this.wallet.sendBegin(
            online, recipient(Number(value)), false, rate, this._config.minConfirmations)
        }
      } catch (error) {
        throw new Error(explainSendError(error?.message || error, rate))
      }

      const signed = this.wallet.signPsbt(psbt)
      const result = this.plain(await this.wallet.sendEnd(online, signed, false))

      await this.wallet.flush()

      return result
    })
  }

  /**
   * Sends plain Bitcoin. Spends the vanilla keychain only, never a UTXO carrying assets.
   *
   * @param {Object} options - The send.
   * @param {string} options.address - The destination address.
   * @param {bigint | number | string} options.amount - The amount in sats.
   * @param {number | bigint} [options.feeRate] - The fee rate; estimated when omitted.
   * @returns {Promise<{ txid: string }>} The transaction id.
   */
  async sendBtc ({ address, amount, feeRate }) {
    const online = this.needOnline()
    const value = BigInt(amount)

    if (value <= 0n) throw new Error('The amount must be greater than 0.')

    const rate = feeRate ? BigInt(feeRate) : await this.feeRate()

    return this.run(async () => {
      await this.wallet.sync(online)

      const psbt = await this.wallet.sendBtcBegin(online, String(address).trim(), value, rate, false)
      const signed = this.wallet.signPsbt(psbt)
      const txid = await this.wallet.sendBtcEnd(online, signed, false)

      await this.wallet.flush()

      return { txid }
    })
  }

  /** Closes the wallet. */
  dispose () {
    try {
      this._wallet?.free?.()
    } catch {
      // Already freed, or freed by the engine on its own.
    }

    this._wallet = null
    this._online = null
  }

  /**
   * rgb-lib changed what this argument is. The published WebAssembly bindings take an asset
   * id; builds from a later commit take an AssetFilter, whose variants are lowercase —
   * "any", "noAsset" or `{ id }`. Both are in circulation, and a consumer may inject either,
   * so the first call settles which one this build wants and the answer is kept.
   *
   * @private
   * @param {string} [assetId] - The asset to restrict to.
   * @returns {Array<Object>} The transfers, as rgb-lib returns them.
   */
  _listTransfers (assetId) {
    if (this._transferArgument === 'assetId') return this._listTransfersByAsset(assetId)

    try {
      const transfers = this.wallet.listTransfers(assetId ? { id: assetId } : 'any')

      this._transferArgument = 'filter'

      return transfers
    } catch (error) {
      if (this._transferArgument === 'filter') throw error

      this._transferArgument = 'assetId'

      return this._listTransfersByAsset(assetId)
    }
  }

  /**
   * The asset-id form of `listTransfers`, including the case the argument cannot express.
   *
   * Passing no asset id does not mean "every transfer": it returns only the transfers that
   * belong to no asset, which on a wallet holding assets is an empty list. Asking for
   * everything therefore means asking once per asset and adding the assetless ones.
   *
   * @private
   * @param {string} [assetId] - The asset to restrict to.
   * @returns {Array<Object>} The transfers.
   */
  _listTransfersByAsset (assetId) {
    if (assetId) return this.wallet.listTransfers(assetId)

    const seen = new Set()
    const all = []

    const add = (transfers) => {
      for (const transfer of transfers || []) {
        const key = `${transfer.batchTransferIdx}/${transfer.idx ?? ''}/${transfer.txid ?? ''}`

        if (seen.has(key)) continue

        seen.add(key)
        all.push(transfer)
      }
    }

    const list = this.wallet.listAssets([])

    for (const asset of [...(list.nia || []), ...(list.ifa || [])]) {
      add(this.wallet.listTransfers(asset.assetId))
    }

    add(this.wallet.listTransfers(undefined))

    return all.sort((a, b) => Number(a.batchTransferIdx) - Number(b.batchTransferIdx))
  }

  /**
   * @private
   * @returns {Promise<boolean>} Whether storage is persistent.
   */
  async _requestPersistence () {
    try {
      return (await navigator.storage.persisted()) || (await navigator.storage.persist())
    } catch {
      return false
    }
  }

  /**
   * @private
   * @returns {Promise<Array<[number, number]>>} The mempool histogram.
   */
  async _mempoolHistogram () {
    const response = await fetch(`${this._config.esploraUrl.replace(/\/+$/, '')}/mempool`, NO_CACHE)

    if (!response.ok) throw new Error(`mempool ${response.status}`)

    return (await response.json()).fee_histogram || []
  }

  /**
   * Adds a confirmation count to the transfers still waiting on the chain. rgb-lib's
   * transfer carries no such field, so it comes from the indexer: one tip lookup plus one
   * status lookup per pending txid. A lookup that fails leaves the count undefined, which
   * beats failing the whole list because the indexer hiccuped.
   *
   * @private
   * @param {Array<Object>} transfers - The transfers.
   * @returns {Promise<Array<Object>>} The transfers, some with `confirmations`.
   */
  async _withConfirmations (transfers) {
    const pending = transfers.filter(
      (t) => t.txid && t.status !== 'Settled' && t.status !== 'Failed')

    if (!pending.length) return transfers

    const base = this._config.esploraUrl.replace(/\/+$/, '')
    const get = (path) => fetch(`${base}${path}`, { ...NO_CACHE, signal: AbortSignal.timeout(8000) })

    let tip

    try {
      tip = Number(await (await get('/blocks/tip/height')).text())
    } catch {
      return transfers
    }

    if (!Number.isFinite(tip)) return transfers

    const depth = new Map()

    for (const txid of new Set(pending.map((t) => t.txid))) {
      try {
        const status = await (await get(`/tx/${txid}/status`)).json()

        // Being in a block at the tip is one confirmation, not zero.
        depth.set(txid, status.confirmed ? Math.max(0, tip - status.block_height + 1) : 0)
      } catch {
        // Leave this one unknown.
      }
    }

    return transfers.map((t) => (depth.has(t.txid) ? { ...t, confirmations: depth.get(t.txid) } : t))
  }
}
