'use strict'

import { describe, expect, test } from '@jest/globals'

import Engine from '../src/engine.js'
import { SLOTS } from '../src/slots.js'

// What an invoice asks rgb-lib for: any amount unless one is given, and never fewer
// confirmations than the wallet is configured with, whatever a caller asks.

const engineWith = (calls) => {
  const engine = new Engine({}, {
    network: 'Regtest', proxyUrl: 'rpc://proxy/json-rpc', minConfirmations: 1, invoiceMinutes: 60, slots: SLOTS, fee: {}
  })
  engine._online = { id: 1 }
  engine._wallet = {
    listUnspents: () => [{ utxo: { colorable: true, exists: true, btcAmount: SLOTS.utxoSizeSat }, rgbAllocations: [], pendingBlinded: 0 }],
    blindReceive: (...args) => { calls.push(args); return { invoice: 'rgb:inv', recipientId: 'id' } },
    flush: async () => {}
  }
  return engine
}

describe('blindReceive', () => {
  test('any amount and the configured confirmations by default', async () => {
    const calls = []
    await engineWith(calls).blindReceive()
    expect(calls[0][1]).toBe('Any')
    expect(calls[0][4]).toBe(1)
  })

  test('a fixed amount, and a higher confirmation count, are passed on', async () => {
    const calls = []
    await engineWith(calls).blindReceive({ amount: '250', minConfirmations: 3 })
    expect(calls[0][1]).toEqual({ Fungible: 250 })
    expect(calls[0][4]).toBe(3)
  })

  test('fewer confirmations than configured are raised to the configured value', async () => {
    const calls = []
    await engineWith(calls).blindReceive({ minConfirmations: 0 })
    expect(calls[0][4]).toBe(1)
  })

  test('an amount of zero, or past 2^53, is refused', async () => {
    await expect(engineWith([]).blindReceive({ amount: '0' })).rejects.toThrow(/greater than 0/)
    await expect(engineWith([]).blindReceive({ amount: '9007199254740993' })).rejects.toThrow(/2\^53/)
  })
})

describe('fallback proxies', () => {
  const withProxies = (calls, fallbackProxyUrls) => {
    const engine = engineWith(calls)
    engine._config = { ...engine._config, fallbackProxyUrls }
    return engine
  }

  test('an invoice names the configured proxy first, then the fallbacks', async () => {
    const calls = []
    await withProxies(calls, ['rpcs://backup/0.2/json-rpc']).blindReceive()
    expect(calls[0][3]).toEqual(['rpc://proxy/json-rpc', 'rpcs://backup/0.2/json-rpc'])
  })

  test('repeats are dropped and no more than three are written', async () => {
    const calls = []
    await withProxies(calls, ['rpc://proxy/json-rpc', 'rpcs://a', 'rpcs://b', 'rpcs://c']).blindReceive()
    expect(calls[0][3]).toEqual(['rpc://proxy/json-rpc', 'rpcs://a', 'rpcs://b'])
  })

  test('without fallbacks the invoice names the configured proxy alone', async () => {
    const calls = []
    await engineWith(calls).blindReceive()
    expect(calls[0][3]).toEqual(['rpc://proxy/json-rpc'])
  })
})

describe('a send that waited too long', () => {
  const busyEngine = (calls) => {
    const engine = engineWith(calls)
    engine._wallet = { ...engine._wallet, sync: async () => { calls.push('sync') }, sendBtcBegin: async () => { calls.push('begin'); return 'psbt' } }
    return engine
  }

  test('is refused unsent when its turn comes after notAfter', async () => {
    const calls = []
    await expect(busyEngine(calls).sendBtc({ address: 'tb1q', amount: '1000', feeRate: 2, notAfter: Date.now() - 1 }))
      .rejects.toThrow(/Nothing was sent/)
    expect(calls).toEqual([])
  })
})

describe('a send behind an operation that never ends', () => {
  test('is answered unsent at notAfter, and never runs afterwards', async () => {
    const calls = []
    const engine = engineWith(calls)
    engine._wallet = { ...engine._wallet, sync: async () => { calls.push('sync') }, sendBtcBegin: async () => { calls.push('begin'); return 'psbt' } }
    let release
    engine.run(() => new Promise((resolve) => { release = resolve }))   // holds the queue
    const t0 = Date.now()
    await expect(engine.sendBtc({ address: 'tb1q', amount: '1000', feeRate: 2, notAfter: Date.now() + 150 }))
      .rejects.toThrow(/Nothing was sent/)
    expect(Date.now() - t0).toBeLessThan(1000)
    release()
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(calls).toEqual([])
  })
})

describe('activity', () => {
  test('one read: assets, each transfer tagged with its asset, transactions with a status, no indexer', async () => {
    const calls = []
    const engine = engineWith(calls)
    engine._transferArgument = 'assetId'
    engine._wallet = {
      ...engine._wallet,
      listAssets: () => ({ nia: [{ assetId: 'rgb:a' }], uda: [{ assetId: 'rgb:u' }] }),
      listTransfers: (id) => (id === 'rgb:a' ? [{ idx: 1, kind: 'Send' }] : id === 'rgb:u' ? [{ idx: 2, kind: 'ReceiveBlind' }] : []),
      listTransactions: () => [{ txid: 't1', confirmationTime: { timestamp: 1 } }, { txid: 't2', confirmationTime: null }]
    }
    engine._chainReadsNow = () => { throw new Error('the indexer must not be asked') }
    const a = await engine.activity()
    expect(a.transfers).toEqual([{ idx: 1, kind: 'Send', assetId: 'rgb:a' }, { idx: 2, kind: 'ReceiveBlind', assetId: 'rgb:u' }])
    expect(a.transactions.map((t) => t.status)).toEqual(['Settled', 'WaitingConfirmations'])
  })
})
