'use strict'

import { describe, expect, test } from '@jest/globals'

import Engine from '../src/engine.js'
import { SLOTS } from '../src/slots.js'

// An invoice takes one consignment: a send to a recipient this wallet has already sent to, in
// a send that has not failed, is refused before anything is built or signed.

const RECIPIENT = 'bcrt:utxob:x'

const engineWith = ({ calls = [], transfers = [] } = {}) => {
  const engine = new Engine({
    WasmInvoice: class { invoiceData () { return { recipientId: RECIPIENT, assetId: 'rgb:a', network: 'Regtest', transportEndpoints: ['rpc://proxy/json-rpc'] } } }
  }, { network: 'Regtest', proxyUrl: 'rpc://proxy/json-rpc', minConfirmations: 1, slots: SLOTS, fee: {} })
  engine._online = { id: 1 }
  engine._wallet = {
    sync: async () => { calls.push('sync') },
    sendBegin: async () => { calls.push('sendBegin'); return 'psbt' },
    signPsbt: async () => { calls.push('sign'); return 'signed' },
    sendEnd: async () => {
      calls.push('sendEnd')
      transfers.push({ idx: transfers.length + 1, kind: 'Send', recipientId: RECIPIENT, status: 'WaitingCounterparty' })
      return { txid: 't', batchTransferIdx: 1 }
    },
    listTransfers: async () => transfers,
    flush: async () => {}
  }
  return engine
}
const ask = { invoice: 'rgb:invoice', assetId: 'rgb:a', amount: 300, feeRate: 2 }
const PAID = /paid already/

describe('an invoice is paid once', () => {
  test('a send to an invoice this wallet has paid is refused before anything is built', async () => {
    const calls = []
    const engine = engineWith({ calls, transfers: [{ idx: 1, kind: 'Send', recipientId: RECIPIENT, status: 'WaitingCounterparty' }] })
    await expect(engine.sendAsset(ask)).rejects.toThrow(PAID)
    await expect(engine.prepareSendAsset(ask)).rejects.toThrow(PAID)
    expect(calls).toEqual([])
  })

  test('the second of two sends to the same invoice is refused', async () => {
    const calls = []
    const engine = engineWith({ calls })
    await engine.sendAsset(ask)
    await expect(engine.sendAsset(ask)).rejects.toThrow(PAID)
    expect(calls.filter((c) => c === 'sendEnd')).toHaveLength(1)
  })

  test('an invoice whose earlier send failed can be paid again', async () => {
    const calls = []
    const engine = engineWith({ calls, transfers: [{ idx: 1, kind: 'Send', recipientId: RECIPIENT, status: 'Failed' }] })
    await engine.sendAsset(ask)
    expect(calls).toContain('sendEnd')
  })

  test('a receive on the same recipient id, or a send to another one, does not count', async () => {
    const engine = engineWith({
      transfers: [
        { idx: 1, kind: 'ReceiveBlind', recipientId: RECIPIENT, status: 'WaitingCounterparty' },
        { idx: 2, kind: 'Send', recipientId: 'bcrt:utxob:other', status: 'Settled' }
      ]
    })
    await expect(engine.sendAsset(ask)).resolves.toEqual({ txid: 't', batchTransferIdx: 1 })
  })

  test('bindings that list transfers by asset id: a send of a unique token counts too', async () => {
    const engine = engineWith()
    engine._wallet.listAssets = async () => ({ nia: [], uda: [{ assetId: 'rgb:u' }] })
    engine._wallet.listTransfers = async (id) => {
      if (id === 'any') throw new Error('expected a string asset id')
      return id === 'rgb:u' ? [{ idx: 1, kind: 'Send', recipientId: RECIPIENT, status: 'Settled' }] : []
    }
    await expect(engine.sendAsset({ ...ask, nonFungible: true })).rejects.toThrow(PAID)
  })
})
