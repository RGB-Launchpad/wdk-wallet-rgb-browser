'use strict'

import { readFileSync } from 'node:fs'
import { describe, expect, test } from '@jest/globals'

import Engine from '../src/engine.js'
import { SLOTS } from '../src/slots.js'

// A send to a `1.0` invoice: the invoice carries `pk`, so the send reserves the transfer on the
// sender's own `1.0` endpoint and hands the recipient key to rgb-lib. An invoice without `pk`
// (a `0.2` one) takes the plain path. Both the popup's prepare/commit and the site's sendAsset
// reach the engine through `_sendBegin`; this pins the rules it applies.

const { psbt: PSBT, inputs: INPUTS } = JSON.parse(readFileSync(new URL('./fixtures/psbt.json', import.meta.url), 'utf8')).rgbSend
const SPENT = `${INPUTS[0].txid}:${INPUTS[0].vout}`
const PK = 'ab'.repeat(32)
const V1 = 'rpcs://proxy.example/v1/json-rpc'
const V02 = 'rpcs://proxy.example/json-rpc'

const engineWith = (invoiceData, config = {}) => {
  const calls = []
  const engine = new Engine({
    WasmInvoice: class { invoiceData () { return invoiceData } }
  }, {
    network: 'Regtest',
    proxyUrl: V1,
    fallbackProxyUrls: [V02],
    minConfirmations: 1,
    slots: SLOTS,
    fee: {},
    ...config
  })
  engine._online = { id: 1 }
  engine._wallet = {
    sync: async () => {},
    sendBegin: async (...args) => { calls.push(args); return PSBT },
    listUnspents: () => [{ utxo: { outpoint: { txid: SPENT.split(':')[0], vout: Number(SPENT.split(':')[1]) } } }],
    listUnspentsVanilla: async () => [],
    listTransfers: async () => [],
    flush: async () => {}
  }
  return { engine, calls }
}

const invoice = (extra = {}) => ({
  recipientId: 'bcrt:utxob:x',
  assetId: 'rgb:a',
  network: 'Regtest',
  transportEndpoints: [V1],
  ...extra
})

const ask = { invoice: 'rgb:invoice', assetId: 'rgb:a', amount: 300, feeRate: 2 }

describe('a send to a 1.0 invoice', () => {
  test('carries pk and sends through the wallet\'s own 1.0 endpoint', async () => {
    const { engine, calls } = engineWith(invoice({ publicKey: PK }))
    await engine.prepareSendAsset(ask)
    expect(calls).toHaveLength(1)
    const args = calls[0]
    // Nine arguments: the sender endpoint the sender's side of the transfer is reserved on.
    expect(args).toHaveLength(9)
    expect(String(args[6])).toMatch(/\/v1\/json-rpc$/)
    expect(args[1]['rgb:a'][0]).toMatchObject({ publicKey: PK, encryption: 'Required' })
    expect(args[1]['rgb:a'][0].transportEndpoints).toEqual([V1])
  })

  test('an invoice naming only a 0.2 endpoint takes the plain path even with pk', async () => {
    const { engine, calls } = engineWith(invoice({ publicKey: PK, transportEndpoints: [V02] }))
    await engine.prepareSendAsset(ask)
    expect(calls[0]).toHaveLength(5)
  })

  test('without pk the plain path is taken and no key is passed', async () => {
    const { engine, calls } = engineWith(invoice())
    await engine.prepareSendAsset(ask)
    expect(calls[0]).toHaveLength(5)
    expect(calls[0][1]['rgb:a'][0].publicKey).toBeUndefined()
  })

  test('a malformed pk is refused rather than sent as plain 0.2', async () => {
    const { engine } = engineWith(invoice({ publicKey: 'not-hex' }))
    await expect(engine.prepareSendAsset(ask)).rejects.toThrow(/pk/i)
  })
})
