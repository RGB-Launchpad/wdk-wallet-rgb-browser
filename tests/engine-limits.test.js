'use strict'

import { afterEach, describe, expect, jest, test } from '@jest/globals'

import Engine from '../src/engine.js'
import WalletAccountRgb from '../src/wallet-account-rgb.js'
import WalletManagerRgb from '../src/wallet-manager-rgb.js'
import { MAINNET_FEE } from '../src/fee.js'
import { SLOTS } from '../src/slots.js'

// What a caller passes in is checked before it reaches rgb-lib, a send gives up at its deadline
// however busy the wallet is, one wallet is open in one place at a time, and a manager's
// lifecycle holds: no seed kept, no wallet brought back after dispose, no failure kept.

const PHRASE = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'

const receiving = (calls, config = {}) => {
  const engine = new Engine({}, {
    network: 'Regtest', proxyUrl: 'rpc://proxy/json-rpc', minConfirmations: 1, invoiceMinutes: 60, slots: SLOTS, fee: {}, ...config
  })
  engine._online = { id: 1 }
  engine._wallet = {
    listUnspents: () => [{ utxo: { colorable: true, exists: true, btcAmount: SLOTS.utxoSizeSat }, rgbAllocations: [], pendingBlinded: 0 }],
    blindReceive: (...args) => { calls.push(args); return { invoice: 'rgb:inv', recipientId: 'id' } },
    flush: async () => {}
  }
  return engine
}

describe('invoice confirmations and duration', () => {
  test('a confirmation count rgb-lib would wrap round is refused, and so is a fraction', async () => {
    for (const minConfirmations of [256, 257, Infinity, -1, 1.5, 'x']) {
      await expect(receiving([]).blindReceive({ minConfirmations })).rejects.toThrow(/0 to 255/)
    }
  })

  test('up to 255 is passed on, as is a count written as a string', async () => {
    const calls = []
    await receiving(calls).blindReceive({ minConfirmations: 255 })
    await receiving(calls).blindReceive({ minConfirmations: '3' })
    expect(calls.map((c) => c[4])).toEqual([255, 3])
  })

  test('a duration that is not a whole number of minutes from 1 to a year is refused', async () => {
    for (const minutes of [0, -1, 1.5, 525_601, '60']) {
      await expect(receiving([]).blindReceive({ minutes })).rejects.toThrow(/minutes must be/)
    }
  })

  test('the default duration, or one asked for, in seconds', async () => {
    const calls = []
    await receiving(calls).blindReceive()
    await receiving(calls).blindReceive({ minutes: 525_600 })
    expect(calls.map((c) => c[2])).toEqual([3600, 31_536_000])
  })
})

describe('a fee rate the caller gives', () => {
  const sending = (calls) => {
    const engine = new Engine({}, { network: 'Mainnet', slots: SLOTS, fee: MAINNET_FEE })
    engine._online = { id: 1 }
    engine._wallet = {
      sync: async () => {},
      sendBtcBegin: async (...args) => { calls.push(args[3]); return 'psbt' },
      signPsbt: async () => 'signed',
      sendBtcEnd: async () => 'txid',
      flush: async () => {}
    }
    return engine
  }

  test('above the most the wallet pays on its network, or not a whole number, is refused unsent', async () => {
    const calls = []
    for (const feeRate of [MAINNET_FEE.max + 1, 1.5, -2, 'fast']) {
      await expect(sending(calls).sendBtc({ address: 'bc1q', amount: 1000, feeRate })).rejects.toThrow(/fee rate/)
    }
    expect(calls).toEqual([])
  })

  test('within it, it is what the transaction pays', async () => {
    const calls = []
    await expect(sending(calls).sendBtc({ address: 'bc1q', amount: 1000, feeRate: MAINNET_FEE.max })).resolves.toEqual({ txid: 'txid', feeRate: BigInt(MAINNET_FEE.max) })
    expect(calls).toEqual([BigInt(MAINNET_FEE.max)])
  })
})

describe('a send with a deadline', () => {
  const realFetch = global.fetch
  afterEach(() => { global.fetch = realFetch })

  test('gives up at it while the wallet is held, with the fee rate left to estimate', async () => {
    const engine = new Engine({
      WasmInvoice: class { invoiceData () { return { recipientId: 'bcrt:utxob:x', assetId: 'rgb:a', network: 'Regtest', transportEndpoints: ['rpc://proxy/json-rpc'] } } }
    }, { network: 'Regtest', esploraUrl: 'http://127.0.0.1:1', proxyUrl: 'rpc://proxy/json-rpc', minConfirmations: 1, slots: SLOTS, fee: {} })
    engine._online = { id: 1 }
    engine._wallet = { getFeeEstimation: async () => 2, listTransfers: async () => [] }
    global.fetch = jest.fn(() => new Promise(() => {})) // an indexer that never answers
    engine.run(() => new Promise(() => {})) // something holds the wallet

    const account = new WalletAccountRgb(engine, 0)
    const outcome = await Promise.race([
      account.transfer({ recipient: 'rgb:invoice', token: 'rgb:a', amount: 1, notAfter: Date.now() + 100 }).then(() => 'sent', (e) => e.message),
      new Promise((resolve) => setTimeout(() => resolve('still waiting'), 2000))
    ])
    expect(outcome).toMatch(/did not start/)
  })
})

// Bindings whose wallets open in memory; `fail` makes the next initialisation fail once.
function bindings (state = {}) {
  return {
    default: async () => { if (state.fail) { state.fail = false; throw new Error('could not fetch the binary') } },
    restoreKeys: () => ({ accountXpubVanilla: 'xv', accountXpubColored: 'xc', masterFingerprint: 'fp' }),
    WasmWallet: {
      create: async () => {
        if (state.slow) await state.slow
        return { flush: async () => {}, free: () => { state.freed = (state.freed || 0) + 1 }, getWalletData: () => ({}) }
      }
    }
  }
}
const config = { network: 'Regtest', esploraUrl: 'http://127.0.0.1:1', deferOnline: true }

describe('one instance per wallet', () => {
  const opened = []
  afterEach(() => { for (const m of opened.splice(0)) m.dispose() })

  test('a second manager on the same phrase and network waits, and is refused while the first stays open', async () => {
    const first = new WalletManagerRgb(PHRASE, { ...config, bindings: bindings() })
    const second = new WalletManagerRgb(PHRASE, { ...config, bindings: bindings() })
    opened.push(first, second)
    await first.getAccount(0)
    await expect(second.getAccount(0)).rejects.toThrow(/open elsewhere/)
  }, 10_000)

  test('once the first is disposed, the second opens', async () => {
    const first = new WalletManagerRgb(PHRASE, { ...config, bindings: bindings() })
    const second = new WalletManagerRgb(PHRASE, { ...config, bindings: bindings() })
    opened.push(first, second)
    await first.getAccount(0)
    const waiting = second.getAccount(0)
    first.dispose()
    await expect(waiting).resolves.toBeInstanceOf(WalletAccountRgb)
  })

  test('another network is another wallet', async () => {
    const regtest = new WalletManagerRgb(PHRASE, { ...config, bindings: bindings() })
    const signet = new WalletManagerRgb(PHRASE, { ...config, network: 'Signet', bindings: bindings() })
    opened.push(regtest, signet)
    await regtest.getAccount(0)
    await expect(signet.getAccount(0)).resolves.toBeInstanceOf(WalletAccountRgb)
  })
})

describe('the manager\'s lifecycle', () => {
  const opened = []
  afterEach(() => { for (const m of opened.splice(0)) m.dispose() })

  test('keeps no seed, and says when it has been disposed', () => {
    const manager = new WalletManagerRgb(PHRASE, { ...config, bindings: bindings() })
    expect(manager.seed).toBeUndefined()
    expect(manager.disposed).toBe(false)
    manager.dispose()
    expect(manager.disposed).toBe(true)
  })

  test('an open that finishes after dispose is closed, not kept', async () => {
    let go
    const state = { slow: new Promise((resolve) => { go = resolve }) }
    const manager = new WalletManagerRgb(PHRASE, { ...config, bindings: bindings(state) })
    opened.push(manager)
    const opening = manager.getAccount(0)
    manager.dispose()
    go()
    await expect(opening).rejects.toThrow(/disposed/)
    expect(state.freed).toBeGreaterThanOrEqual(1)
    await expect(manager.getAccount(0)).rejects.toThrow(/disposed/)
  })

  test('a failed open is tried again on the next call', async () => {
    const state = { fail: true }
    const manager = new WalletManagerRgb(PHRASE, { ...config, bindings: bindings(state) })
    opened.push(manager)
    await expect(manager.getAccount(0)).rejects.toThrow(/could not fetch/)
    await expect(manager.getAccount(0)).resolves.toBeInstanceOf(WalletAccountRgb)
  })

  test('after an account is disposed, the manager opens the wallet afresh', async () => {
    const manager = new WalletManagerRgb(PHRASE, { ...config, bindings: bindings() })
    opened.push(manager)
    const account = await manager.getAccount(0)
    account.dispose()
    expect(account.disposed).toBe(true)
    const again = await manager.getAccount(0)
    expect(again).not.toBe(account)
    expect(again.disposed).toBe(false)
  })
})
