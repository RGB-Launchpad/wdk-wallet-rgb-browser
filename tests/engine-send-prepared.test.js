'use strict'

import { readFileSync } from 'node:fs'
import { describe, expect, test } from '@jest/globals'

import Engine from '../src/engine.js'
import { SLOTS } from '../src/slots.js'

// A send prepared for the user to check, then signed: nothing is signed while it waits, and it
// is refused when the wallet signed anything in between or an output it spends is gone.

const { psbt: PSBT, inputs: INPUTS } = JSON.parse(readFileSync(new URL('./fixtures/psbt.json', import.meta.url), 'utf8')).rgbSend
const SPENT = `${INPUTS[0].txid}:${INPUTS[0].vout}`

const engineWith = ({ calls = [], unspent = [SPENT] } = {}) => {
  const engine = new Engine({
    WasmInvoice: class { invoiceData () { return { recipientId: 'bcrt:utxob:x', assetId: 'rgb:a', network: 'Regtest', transportEndpoints: ['rpc://proxy/json-rpc'] } } }
  }, { network: 'Regtest', proxyUrl: 'rpc://proxy/json-rpc', minConfirmations: 1, slots: SLOTS, fee: {} })
  engine._online = { id: 1 }
  engine._wallet = {
    sync: async () => { calls.push('sync') },
    sendBegin: async (...args) => { calls.push(['sendBegin', args]); return PSBT },
    signPsbt: async () => { calls.push('sign'); return 'signed' },
    sendEnd: async () => { calls.push('sendEnd'); return { txid: 't', batchTransferIdx: 2 } },
    sendBtcBegin: async () => 'btc-psbt',
    sendBtcEnd: async () => 'btc-txid',
    listUnspents: () => unspent.filter((o) => o === SPENT).map((o) => ({ utxo: { outpoint: { txid: o.split(':')[0], vout: Number(o.split(':')[1]) } } })),
    listUnspentsVanilla: async () => [],
    flush: async () => { calls.push('flush') }
  }
  return engine
}
const ask = { invoice: 'rgb:invoice', assetId: 'rgb:a', amount: 300, feeRate: 2 }

describe('prepareSendAsset / finishSendAsset', () => {
  test('prepared: the PSBT and the outputs it spends, and nothing signed', async () => {
    const calls = []
    const prepared = await engineWith({ calls }).prepareSendAsset(ask)
    expect(prepared).toMatchObject({ psbt: PSBT, inputs: INPUTS, assetId: 'rgb:a', recipientId: 'bcrt:utxob:x', amount: '300', feeRate: 2n })
    expect(calls).not.toContain('sign')
    expect(calls).not.toContain('sendEnd')
  })

  test('finished: signed, posted and saved', async () => {
    const calls = []
    const engine = engineWith({ calls })
    const prepared = await engine.prepareSendAsset(ask)
    await expect(engine.finishSendAsset(prepared)).resolves.toEqual({ txid: 't', batchTransferIdx: 2 })
    expect(calls.slice(-4)).toEqual(['sync', 'sign', 'sendEnd', 'flush'])
  })

  test('refused when the wallet signed something in between', async () => {
    const calls = []
    const engine = engineWith({ calls })
    const prepared = await engine.prepareSendAsset(ask)
    await engine.sendBtc({ address: 'bcrt1q', amount: 1000, feeRate: 2 })
    await expect(engine.finishSendAsset(prepared)).rejects.toThrow(/sent something since/)
    expect(calls).not.toContain('sendEnd')
  })

  test('refused when an output it spends is no longer the wallet\'s', async () => {
    const calls = []
    const engine = engineWith({ calls, unspent: [] })
    const prepared = await engine.prepareSendAsset(ask)
    await expect(engine.finishSendAsset(prepared)).rejects.toThrow(/no longer the wallet's/)
    expect(calls).not.toContain('sign')
  })

  test('a prepared send cannot be finished twice', async () => {
    const engine = engineWith()
    const prepared = await engine.prepareSendAsset(ask)
    await engine.finishSendAsset(prepared)
    await expect(engine.finishSendAsset(prepared)).rejects.toThrow(/sent something since/)
  })

  test('nothing prepared, nothing sent', async () => {
    await expect(engineWith().finishSendAsset({})).rejects.toThrow(/Nothing prepared/)
  })
})
