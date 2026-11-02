'use strict'

import { readFileSync } from 'node:fs'
import { describe, expect, test } from '@jest/globals'

import Engine from '../src/engine.js'
import { SLOTS } from '../src/slots.js'
import { TEST_NETWORK_FEE } from '../src/fee.js'

// A send prepared for the user to check, then signed: nothing is signed while it waits, and it
// is refused when the wallet signed anything in between or an output it spends is gone.

const { psbt: PSBT, inputs: INPUTS } = JSON.parse(readFileSync(new URL('./fixtures/psbt.json', import.meta.url), 'utf8')).rgbSend
const SPENT = `${INPUTS[0].txid}:${INPUTS[0].vout}`

const engineWith = ({ calls = [], unspent = [SPENT], transfers = [] } = {}) => {
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
    listTransfers: async () => transfers,
    flush: async () => { calls.push('flush') }
  }
  return engine
}

// The same wallet opened again: its records and outputs as they were, a new engine.
const reopened = (engine, calls) => {
  const again = engineWith({ calls })
  again._wallet = engine._wallet
  return again
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

  test('refused after the wallet was reopened, even with nothing signed in between', async () => {
    const calls = []
    const engine = engineWith({ calls })
    const prepared = await engine.prepareSendAsset(ask)
    engine._signed() // a send the earlier engine signed and the new one cannot know of
    const again = reopened(engine, calls)
    await expect(again.finishSendAsset(prepared)).rejects.toThrow(/before the wallet was last opened/)
    expect(calls).not.toContain('sign')
  })

  test('refused when the PSBT or what it sends is not what this engine prepared', async () => {
    const calls = []
    const engine = engineWith({ calls })
    const prepared = await engine.prepareSendAsset(ask)
    await expect(engine.finishSendAsset({ ...prepared, psbt: prepared.psbt.slice(0, -4) + 'AAAA' })).rejects.toThrow(/not a send this wallet prepared/)
    await expect(engine.finishSendAsset({ ...prepared, recipientId: 'bcrt:utxob:other' })).rejects.toThrow(/not a send this wallet prepared/)
    await expect(engine.finishSendAsset({ ...prepared, amount: '999' })).rejects.toThrow(/not a send this wallet prepared/)
    expect(calls).not.toContain('sign')
  })

  test('refused when the invoice was paid after the send was prepared', async () => {
    const calls = []
    const transfers = []
    const engine = engineWith({ calls, transfers })
    const prepared = await engine.prepareSendAsset(ask)
    transfers.push({ idx: 1, kind: 'Send', recipientId: 'bcrt:utxob:x', status: 'WaitingCounterparty' })
    await expect(engine.finishSendAsset(prepared)).rejects.toThrow(/paid already/)
    expect(calls).not.toContain('sign')
  })

  test('the fee rate, when none is given, is worked out in the send\'s own turn', async () => {
    const engine = engineWith()
    engine._config = { ...engine._config, fee: TEST_NETWORK_FEE }
    engine._wallet.getFeeEstimation = async () => 7
    engine._mempoolHistogram = async () => []
    const prepared = await engine.prepareSendAsset({ ...ask, feeRate: undefined })
    expect(prepared.feeRate).toBe(BigInt(TEST_NETWORK_FEE.min))
  })
})
