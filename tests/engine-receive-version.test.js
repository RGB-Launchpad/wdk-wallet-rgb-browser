'use strict'

import { describe, expect, test } from '@jest/globals'

import Engine from '../src/engine.js'
import { SLOTS } from '../src/slots.js'

// Which endpoints a new invoice names, by what it has to interoperate with. The default send
// format `v0` gets the `0.2` endpoints alone, so the engine issues an invoice with no `pk` and a
// `0.11.1` wallet can pay it; `v1` and every `BFA` asset get them all and the invoice is `1.0`.

const V1 = 'rpcs://proxy.example/v1/json-rpc'
const V02 = 'rpcs://proxy.example/json-rpc'

const slot = { utxo: { colorable: true, exists: true, btcAmount: 330, outpoint: { txid: 'aa', vout: 0 } }, rgbAllocations: [], pendingBlinded: 0 }

const engineWith = (config) => {
  const calls = []
  const engine = new Engine({
    WasmInvoice: class {},
    WasmWallet: class {}
  }, {
    network: 'Regtest',
    proxyUrl: V1,
    fallbackProxyUrls: [V02],
    minConfirmations: 1,
    invoiceMinutes: 60,
    slots: SLOTS,
    fee: {},
    ...config
  })
  engine._online = { id: 1 }
  engine._wallet = {
    listUnspents: () => [slot],
    blindReceive: async (...args) => { calls.push(args); return { invoice: 'inv' } },
    witnessReceive: async (...args) => { calls.push(args); return { invoice: 'inv', recipientId: 'wvout:x' } },
    rotateAddress: async () => {},
    flush: async () => {},
    getConsignmentVersion: () => config.consignmentVersion || 'v0'
  }
  return { engine, calls }
}

describe('the endpoints a new invoice names', () => {
  test('the default v0 names the 0.2 endpoint alone', async () => {
    const { engine, calls } = engineWith({ consignmentVersion: 'v0' })
    await engine.blindReceive({ assetId: 'rgb:a' })
    expect(calls[0][3]).toEqual([V02])
  })

  test('v1 names every endpoint', async () => {
    const { engine, calls } = engineWith({ consignmentVersion: 'v1' })
    await engine.blindReceive({ assetId: 'rgb:a' })
    expect(calls[0][3]).toEqual([V1, V02])
  })

  test('a BFA asset names every endpoint under v0 too', async () => {
    const { engine, calls } = engineWith({ consignmentVersion: 'v0' })
    await engine.blindReceive({ assetId: 'rgb:a', bfa: true })
    expect(calls[0][3]).toEqual([V1, V02])
  })

  test('a witness invoice follows the same rule', async () => {
    const v0 = engineWith({ consignmentVersion: 'v0' })
    await v0.engine.witnessReceive({ assetId: 'rgb:a' })
    expect(v0.calls[0][3]).toEqual([V02])

    const v1 = engineWith({ consignmentVersion: 'v1' })
    await v1.engine.witnessReceive({ assetId: 'rgb:a' })
    expect(v1.calls[0][3]).toEqual([V1, V02])
  })

  test('a wallet with only a 1.0 endpoint still names it', async () => {
    const { engine, calls } = engineWith({ consignmentVersion: 'v0', proxyUrl: V1, fallbackProxyUrls: [] })
    await engine.blindReceive({ assetId: 'rgb:a' })
    expect(calls[0][3]).toEqual([V1])
  })
})
