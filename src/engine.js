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
 * What a wallet binding throws while other code on the same wallet instance holds it, such as
 * a Lightning node built into the same WebAssembly module. Bindings without such a neighbour
 * never throw it.
 */
const WALLET_BUSY = 'RGB wallet is busy with another operation'

/** How long one call keeps retrying a busy wallet, and how often. */
const BUSY_RETRY_FOR_MS = 60_000
const BUSY_RETRY_EVERY_MS = 100

const isBusy = (error) => String(error?.message ?? error).includes(WALLET_BUSY)

/**
 * The wallet, with every method retried while the wallet is busy. Only the one call is
 * retried, never the task around it: a binding checks for the wallet before doing anything,
 * so a busy call changed nothing, while re-running a whole task could repeat a step that
 * already happened (a second `sendBegin`). A call that is not refused returns as it would
 * unwrapped, synchronously for a synchronous method; a refused one returns a promise, which
 * is why every call site awaits.
 *
 * @param {Object} wallet - The rgb-lib wallet.
 * @returns {Object} The same wallet behind the retry.
 */
export function retryWhenBusy (wallet) {
  const later = async (method, args) => {
    const deadline = Date.now() + BUSY_RETRY_FOR_MS

    for (;;) {
      await new Promise((resolve) => setTimeout(resolve, BUSY_RETRY_EVERY_MS))

      try {
        return await method.apply(wallet, args)
      } catch (error) {
        if (!isBusy(error) || Date.now() > deadline) throw error
      }
    }
  }

  return new Proxy(wallet, {
    get (target, key) {
      const value = Reflect.get(target, key)

      if (typeof value !== 'function') return value

      return (...args) => {
        let result

        try {
          result = value.apply(target, args)
        } catch (error) {
          if (isBusy(error)) return later(value, args)
          throw error
        }

        return typeof result?.then === 'function'
          ? result.catch((error) => (isBusy(error) ? later(value, args) : Promise.reject(error)))
          : result
      }
    }
  })
}

/**
 * How long one round of confirmation reads is shared. A history screen asks for the full
 * list, each asset's list and the transaction list back to back; within this window they
 * share one tip lookup and one status lookup per txid instead of repeating them each time.
 * Short enough that the next refresh sees a new block.
 */
const CHAIN_READ_MS = 5000

/** Status lookups in flight at once. */
const CHAIN_READ_PARALLEL = 4

/**
 * How many coloured addresses to rotate through looking for a recipient id the proxy does not
 * already hold. Each attempt is one round trip, so this is also a bound on how long the engine
 * is held for one invoice.
 */
const WITNESS_ADDRESS_ATTEMPTS = 10

/** What a send that waited past its `notAfter` answers. Nothing was built or signed. */
const NOT_SENT_BUSY = 'The wallet was busy with another operation and this send did not start. Nothing was sent; try again.'

/**
 * Refuses a send whose turn in the queue came after `notAfter` (ms since the epoch). A caller
 * that stops waiting gives up on the send; one that still ran after that would move funds the
 * caller had already reported as not sent.
 *
 * @param {number} [notAfter] - The last moment the send may start.
 */
function startBy (notAfter) {
  if (notAfter && Date.now() > notAfter) throw new Error(NOT_SENT_BUSY)
}

/**
 * Runs a send in the queue, answering NOT_SENT_BUSY at `notAfter` if it has not started by then,
 * whether or not the queue ever frees: an operation that never lets go of the wallet would
 * otherwise keep the caller waiting forever. The send itself still refuses to start late
 * (`startBy`), so the answer stays true once the queue moves.
 *
 * @template T
 * @param {Engine} engine - The engine.
 * @param {number} [notAfter] - The last moment the send may start.
 * @param {() => Promise<T>} task - The send.
 * @returns {Promise<T>} What the send returned.
 */
function runSend (engine, notAfter, task) {
  let started = false
  const queued = engine.run(async () => {
    startBy(notAfter)
    started = true
    return task()
  })
  if (!notAfter) return queued
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { if (!started) reject(new Error(NOT_SENT_BUSY)) }, Math.max(0, notAfter - Date.now()) + 50)
    queued.then((v) => { clearTimeout(timer); resolve(v) }, (e) => { clearTimeout(timer); reject(e) })
  })
}

/** The most consignment endpoints rgb-lib writes into one invoice. */
const MAX_TRANSPORT_ENDPOINTS = 3

/**
 * Whether a recipient id names an output of the sender's transaction rather than a blinded
 * UTXO of the recipient's. rgb-lib encodes it in the id: `wvout` against `utxob`.
 *
 * @param {string} recipientId - The recipient id from the invoice.
 * @returns {boolean} True for a witness recipient.
 */
const isWitnessRecipient = (recipientId) => /(?:^|:)wvout:/.test(String(recipientId || ''))

/**
 * What an invoice asks for: any amount, or a fixed one in base units. rgb-lib takes the amount
 * as a number, so one past 2^53 cannot be asked for exactly and is refused rather than rounded.
 *
 * @param {bigint | number | string} [amount] - The amount; any when omitted.
 * @returns {string | Object} The assignment.
 */
function receiveAssignment (amount) {
  if (amount === undefined || amount === null || amount === '') return 'Any'
  const value = BigInt(amount)
  if (value <= 0n) throw new Error('The amount must be greater than 0.')
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('The amount exceeds 2^53 and cannot be put in an invoice exactly.')
  return { Fungible: Number(value) }
}

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

    /** @private */
    this._chainReads = null
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

    this._wallet = retryWhenBusy(await WasmWallet.create(JSON.stringify({
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
      supportedSchemas: this._config.schemas,
      // Pins the address index, so the wallet's address is stable across sessions.
      reuseAddresses: true
    })))

    await this._wallet.flush()

    this._persisted = await this._requestPersistence()

    // A consumer that opens the wallet on its snapshot alone reaches the indexer later, with
    // `goOnline`, so the opening never waits on the network.
    if (!this._config.deferOnline) await this.goOnline()
  }

  /**
   * Reaches the indexer, or tries again after a failure. Every online command needs this to
   * have succeeded once; a wallet opened with `deferOnline` calls it when it is ready to wait.
   *
   * @returns {Promise<boolean>} Whether the indexer answered.
   */
  async goOnline () {
    if (!this._wallet) throw new Error('The wallet is not open.')

    try {
      this._online = await this._wallet.goOnline(true, this._config.esploraUrl)
      this._onlineError = null
    } catch (error) {
      this._online = null
      this._onlineError = String(error?.message || error)
    }

    return !!this._online
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
    return this.run(async () => {
      const list = this.plain(await this.wallet.listAssets([]))
      const out = []

      for (const asset of [...(list.nia || []), ...(list.ifa || [])]) {
        let precision = asset.precision ?? null

        try {
          precision = this.plain(await this.wallet.getAssetMetadata(asset.assetId)).precision ?? precision
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
    const transfers = await this.run(async () =>
      this.plain(await this._listTransfers(assetId)).slice().reverse())

    return this._withConfirmations(transfers)
  }

  /**
   * Everything the wallet's activity is made of, read from its own records in one turn of the
   * queue and without asking the network: the assets, each asset's transfers (tagged with its
   * id), and the wallet's own Bitcoin transactions. Confirmation counts are not here; see
   * {@link confirmations}, which asks the indexer and does not hold the wallet.
   *
   * @returns {Promise<{ assets: Object, transfers: Array<Object>, transactions: Array<Object> }>} The records.
   */
  async activity () {
    return this.run(async () => {
      const assets = this.plain(await this.wallet.listAssets([])) || {}
      const transfers = []
      for (const asset of [...(assets.nia || []), ...(assets.ifa || []), ...(assets.uda || []), ...(assets.cfa || [])]) {
        for (const transfer of this.plain(await this._listTransfers(asset.assetId)) || []) {
          transfers.push({ ...transfer, assetId: asset.assetId })
        }
      }
      const transactions = (this.plain(await this.wallet.listTransactions()) || []).map((tx) => ({
        ...tx,
        status: tx.confirmationTime ? 'Settled' : 'WaitingConfirmations'
      }))
      return { assets, transfers, transactions }
    })
  }

  /**
   * The rows given, with a confirmation count on those still waiting, read from the indexer.
   * Does not hold the wallet.
   *
   * @param {Array<Object>} rows - Transfers or transactions carrying a `txid`.
   * @returns {Promise<Array<Object>>} The same rows.
   */
  async confirmations (rows) {
    return this._withConfirmations(rows)
  }

  /**
   * The wallet's own transactions, newest first: plain Bitcoin sends and receives, slot
   * housekeeping, and the transactions RGB sends anchored. Amounts in sats. Unconfirmed ones
   * carry a `confirmations` count; a confirmed one reports `Settled`, since one confirmation
   * is where this wallet settles.
   *
   * @returns {Promise<Array<Object>>} The transactions.
   */
  async listTransactions () {
    const txs = await this.run(async () => this.plain(await this.wallet.listTransactions()))
    const shaped = txs.map((tx) => ({
      ...tx,
      status: tx.confirmationTime ? 'Settled' : 'WaitingConfirmations'
    }))

    // `_withConfirmations` is async: sort the rows, not the promise they arrive on.
    return (await this._withConfirmations(shaped)).sort((a, b) =>
      (b.confirmationTime?.timestamp ?? Number.MAX_SAFE_INTEGER) -
      (a.confirmationTime?.timestamp ?? Number.MAX_SAFE_INTEGER))
  }

  /**
   * Free allocation slots. Receiving needs at least one.
   *
   * @returns {Promise<number>} How many allocations can still be received.
   */
  async freeSlots () {
    return this.run(async () => freeSlots(await this.wallet.listUnspents(false), this._config.slots))
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
   * @param {number} [num] - How many to create; by default as many as bring the usable empty slots up to the configured number.
   * @returns {Promise<{ created: number, slots: number }>} What was created.
   */
  async createUtxos (feeRate, num) {
    const online = this.needOnline()
    const rate = feeRate ? BigInt(feeRate) : await this.feeRate()

    return this.run(async () => {
      await this.wallet.sync(online)

      const count = num
        ? Math.max(1, Math.floor(Number(num)))
        : slotsToCreate(this.plain(await this.wallet.listUnspents(false)), this._config.slots)

      if (count === 0) {
        return { created: 0, slots: freeSlots(await this.wallet.listUnspents(false), this._config.slots) }
      }

      const blocked = slotBlocker(await this.wallet.getBtcBalance().vanilla, rate, count, this._config.slots)

      if (blocked) throw new Error(blocked)

      // `upTo` is false. With it true, rgb-lib counts every UTXO that still has room for an
      // allocation, including ones already holding assets, and creates nothing.
      const psbt = await this.wallet.createUtxosBegin(
        online, false, count, this._config.slots.utxoSizeSat, rate, false)
      const signed = await this.wallet.signPsbt(psbt)
      const created = await this.wallet.createUtxosEnd(online, signed, false)

      await this.wallet.flush()

      return { created, slots: freeSlots(await this.wallet.listUnspents(false), this._config.slots) }
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
   * @param {bigint | number | string} [options.amount] - A fixed amount in base units; any amount when omitted.
   * @param {number} [options.minConfirmations] - Confirmations the transfer must reach; never fewer than the configured value.
   * @returns {Promise<Object>} The invoice.
   */
  async blindReceive ({ assetId, minutes, amount, minConfirmations } = {}) {
    this.needOnline()

    if (!this._config.proxyUrl) {
      throw new Error('No proxyUrl is configured. An invoice must name where the consignment goes.')
    }

    const assignment = receiveAssignment(amount)
    const confirmations = Math.max(this._config.minConfirmations, Number(minConfirmations) || 0)

    return this.run(async () => {
      if (freeSlots(await this.wallet.listUnspents(false), this._config.slots) < 1) {
        throw new Error('No free allocation slot. Create slots before receiving.')
      }

      let invoice

      try {
        // `undefined` means any asset; the bindings reject null.
        invoice = await this.wallet.blindReceive(
          assetId || undefined,
          assignment,
          (minutes || this._config.invoiceMinutes) * 60,
          this._proxyUrls(),
          confirmations
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
   * @param {bigint | number | string} [options.amount] - A fixed amount in base units; any amount when omitted.
   * @param {number} [options.minConfirmations] - Confirmations the transfer must reach; never fewer than the configured value.
   * @returns {Promise<Object>} The invoice.
   */
  async witnessReceive ({ assetId, minutes, amount, minConfirmations } = {}) {
    this.needOnline()

    if (!this._config.proxyUrl) {
      throw new Error('No proxyUrl is configured. An invoice must name where the consignment goes.')
    }

    const assignment = receiveAssignment(amount)
    const confirmations = Math.max(this._config.minConfirmations, Number(minConfirmations) || 0)

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
        await this.wallet.rotateAddress(0)

        const invoice = this.plain(await this.wallet.witnessReceive(
          assetId || undefined,
          assignment,
          (minutes || this._config.invoiceMinutes) * 60,
          this._proxyUrls(),
          confirmations
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
    // An id held by any proxy the invoice names is taken. Only the main proxy has to answer:
    // a fallback that cannot be reached holds nothing a sender could have delivered there.
    const [main, ...fallbacks] = this._proxyUrls()
    for (const url of fallbacks) {
      if (await this._proxyHoldsAt(url, recipientId).catch(() => false)) return true
    }
    return this._proxyHoldsAt(main, recipientId)
  }

  /**
   * The proxies an invoice names, in the order a sender tries them: the configured one, then the
   * fallbacks, without repeats and no more than rgb-lib accepts.
   *
   * @private
   * @returns {string[]} The endpoints.
   */
  _proxyUrls () {
    const all = [this._config.proxyUrl, ...(this._config.fallbackProxyUrls || [])].filter(Boolean)
    return [...new Set(all)].slice(0, MAX_TRANSPORT_ENDPOINTS)
  }

  /**
   * Whether one proxy holds a consignment for this recipient id.
   *
   * @private
   * @param {string} proxyUrl - The proxy.
   * @param {string} recipientId - The recipient id.
   * @returns {Promise<boolean>} True when the id is taken there.
   */
  async _proxyHoldsAt (proxyUrl, recipientId) {
    const url = String(proxyUrl)
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
      if (freeSlots(await this.wallet.listUnspents(false), this._config.slots) < amounts.length) {
        throw new Error(`Issuing ${amounts.length} allocations needs ${amounts.length} free slots. Create slots first.`)
      }

      const values = amounts.map((a) => BigInt(a))

      const asset = schema === 'Ifa'
        ? await this.wallet.issueAssetIfa(
          ticker,
          name,
          precision,
          values,
          (options.inflationAmounts || []).map((a) => BigInt(a)),
          options.rejectListUrl ?? undefined
        )
        : await this.wallet.issueAssetNia(ticker, name, precision, values)

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
      const address = await this.wallet.getAddress()
      const psbt = await buildToSignPsbt(address, message)
      const signed = await this.wallet.signPsbt(psbt)

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

      // Whatever the chain said before this refresh is older than what it says now.
      this._chainReads = null

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
        deleted = await this.wallet.deleteTransfers(undefined, true)
      } catch {
        // Nothing to delete.
      }

      await this.wallet.flush()

      return {
        failed,
        deleted,
        slots: freeSlots(await this.wallet.listUnspents(false), this._config.slots)
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

    return this.run(async () => await this.wallet.backup(password))
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
      await this.wallet.restoreBackup(new Uint8Array(bytes), password)

      await this.wallet.flush()
    })
  }

  /**
   * Sends an asset to an invoice.
   *
   * 🚨 This does not put anything on the chain. RGB posts the consignment to the proxy and
   * waits: the recipient fetches it, validates it and acknowledges, and only then does the
   * sender broadcast. Broadcasting earlier would risk an asset the recipient could not
   * validate. The returned `hash` is therefore the id of a transaction that is not yet on
   * the network, and {@link refresh} is what eventually puts it there. See
   * {@link pendingHandovers}.
   *
   * The invoice's own transport endpoints take precedence over the configured one: the
   * consignment has to land where the recipient looks for it.
   *
   * @param {Object} options - The send.
   * @param {string} options.invoice - The RGB invoice.
   * @param {string} [options.assetId] - The asset; taken from the invoice when omitted.
   * @param {bigint | number | string} [options.amount] - The amount, in the asset's own precision. Not used for a non-fungible asset.
   * @param {number | bigint} [options.feeRate] - The fee rate; estimated when omitted.
   * @param {boolean} [options.nonFungible] - The asset is a unique token (UDA): the whole of it moves, and rgb-lib takes the assignment as non-fungible rather than an amount.
   * @returns {Promise<Object>} The transfer rgb-lib recorded.
   */
  async sendAsset ({ invoice, assetId, amount, feeRate, nonFungible = false, notAfter }) {
    const online = this.needOnline()
    const data = this.plain(new this._bindings.WasmInvoice(String(invoice || '').trim()).invoiceData())

    if (data.network && String(data.network).toLowerCase() !== String(this.network).toLowerCase()) {
      throw new Error(`The invoice is for ${data.network}, the wallet is on ${this.network}.`)
    }

    if (data.assetId && assetId && data.assetId !== assetId) {
      throw new Error('The invoice names a different asset.')
    }

    const value = nonFungible ? 1n : BigInt(amount)

    if (value <= 0n) throw new Error('The amount must be greater than 0.')

    const endpoints = data.transportEndpoints?.length
      ? data.transportEndpoints
      : (this._config.proxyUrl ? [this._config.proxyUrl] : [])

    if (!endpoints[0]) {
      throw new Error('The invoice carries no consignment endpoint and no proxyUrl is configured.')
    }

    const rate = feeRate ? BigInt(feeRate) : await this.feeRate()

    return runSend(this, notAfter, async () => {
      await this.wallet.sync(online)

      // A witness recipient has no UTXO yet: the transfer creates the output the asset lands
      // on, and has to be told how many sats to put on it. A blinded one already owns its
      // output and carries no witness data at all — passing some is an error, and leaving it
      // out for a witness recipient is the same error the other way round.
      //
      // The sats go as a string and `blinding` has to be present even when empty: rgb-lib
      // reads these through a deserialiser that takes a string, an unsigned number or null,
      // and a plain JavaScript integer arrives as a signed one, which it refuses.
      const witnessData = isWitnessRecipient(data.recipientId)
        ? { amountSat: String(this._config.witnessSats), blinding: null }
        : undefined

      const recipient = (fungible) => ({
        [assetId || data.assetId]: [{
          recipientId: data.recipientId,
          witnessData,
          assignment: nonFungible ? 'NonFungible' : { Fungible: fungible },
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

      const signed = await this.wallet.signPsbt(psbt)
      const result = this.plain(await this.wallet.sendEnd(online, signed, false))

      await this.wallet.flush()

      return result
    })
  }

  /**
   * The transfers this wallet has sent that are still waiting on their recipient.
   *
   * A transfer is not on the chain when `sendAsset` returns. RGB posts the consignment first
   * and the recipient validates it; only then does the sender broadcast, because a
   * transaction broadcast before the recipient could validate can leave the asset
   * unrecoverable. {@link refresh} is what notices the acknowledgement and broadcasts.
   *
   * So a wallet that sends and never refreshes again has not sent anything. Anything driving
   * this to completion — a timer, an event on opening — asks here whether it still needs to.
   *
   * @returns {Promise<Array<Object>>} The outgoing transfers still waiting.
   */
  async pendingHandovers () {
    const transfers = await this.listTransfers()

    return transfers.filter((t) => t.kind === 'Send' && t.status === 'WaitingCounterparty')
  }

  /**
   * Sends plain Bitcoin. Spends the vanilla keychain only, never a UTXO carrying assets.
   *
   * @param {Object} options - The send.
   * @param {string} options.address - The destination address.
   * @param {bigint | number | string} options.amount - The amount in sats.
   * @param {number | bigint} [options.feeRate] - The fee rate; estimated when omitted.
   * @param {number} [options.notAfter] - The last moment (ms since the epoch) the send may start; past it the send is refused unsent.
   * @returns {Promise<{ txid: string }>} The transaction id.
   */
  async sendBtc ({ address, amount, feeRate, notAfter }) {
    const online = this.needOnline()
    const value = BigInt(amount)

    if (value <= 0n) throw new Error('The amount must be greater than 0.')

    const rate = feeRate ? BigInt(feeRate) : await this.feeRate()

    return runSend(this, notAfter, async () => {
      await this.wallet.sync(online)

      const psbt = await this.wallet.sendBtcBegin(online, String(address).trim(), value, rate, false)
      const signed = await this.wallet.signPsbt(psbt)
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
  async _listTransfers (assetId) {
    if (this._transferArgument === 'assetId') return this._listTransfersByAsset(assetId)

    try {
      const transfers = await this.wallet.listTransfers(assetId ? { id: assetId } : 'any')

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
  async _listTransfersByAsset (assetId) {
    if (assetId) return await this.wallet.listTransfers(assetId)

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

    const list = await this.wallet.listAssets([])

    for (const asset of [...(list.nia || []), ...(list.ifa || [])]) {
      add(await this.wallet.listTransfers(asset.assetId))
    }

    add(await this.wallet.listTransfers(undefined))

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
   * status lookup per pending txid, shared with every other call in the same
   * {@link CHAIN_READ_MS} window. A lookup that fails leaves the count undefined, which beats
   * failing the whole list because the indexer hiccuped.
   *
   * @private
   * @param {Array<Object>} transfers - The transfers.
   * @returns {Promise<Array<Object>>} The transfers, some with `confirmations`.
   */
  async _withConfirmations (transfers) {
    const pending = transfers.filter(
      (t) => t.txid && t.status !== 'Settled' && t.status !== 'Failed')

    if (!pending.length) return transfers

    const reads = this._chainReadsNow()

    let tip

    try {
      tip = await reads.tip()
    } catch {
      return transfers
    }

    if (!Number.isFinite(tip)) return transfers

    const txids = [...new Set(pending.map((t) => t.txid))]
    const depth = new Map()
    let next = 0

    const worker = async () => {
      while (next < txids.length) {
        const txid = txids[next++]

        try {
          const status = await reads.status(txid)

          // Being in a block at the tip is one confirmation, not zero.
          depth.set(txid, status.confirmed ? Math.max(0, tip - status.block_height + 1) : 0)
        } catch {
          // Leave this one unknown.
        }
      }
    }

    await Promise.all(Array.from({ length: Math.min(CHAIN_READ_PARALLEL, txids.length) }, worker))

    return transfers.map((t) => (depth.has(t.txid) ? { ...t, confirmations: depth.get(t.txid) } : t))
  }

  /**
   * The indexer reads of the current {@link CHAIN_READ_MS} window. Each read is made at most
   * once per window and its promise shared, a failed one included: a lookup that just timed
   * out would only time out again for the next caller.
   *
   * @private
   * @returns {{ tip: function(): Promise<number>, status: function(string): Promise<Object> }} The reads.
   */
  _chainReadsNow () {
    const now = Date.now()

    if (this._chainReads && now - this._chainReads.at < CHAIN_READ_MS) return this._chainReads

    const base = this._config.esploraUrl.replace(/\/+$/, '')
    const get = (path) => fetch(`${base}${path}`, { ...NO_CACHE, signal: AbortSignal.timeout(8000) })
    const held = new Map()
    const once = (key, read) => {
      if (!held.has(key)) held.set(key, read())

      return held.get(key)
    }

    this._chainReads = {
      at: now,
      tip: () => once('tip', async () => Number(await (await get('/blocks/tip/height')).text())),
      status: (txid) => once(txid, async () => (await get(`/tx/${txid}/status`)).json())
    }

    return this._chainReads
  }
}
