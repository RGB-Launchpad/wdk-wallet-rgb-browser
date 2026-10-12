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
