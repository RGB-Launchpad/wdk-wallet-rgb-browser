'use strict'

import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals'

import Engine from '../src/engine.js'

// A history screen asks for the full list, each asset's list and the transaction list back to
// back. Each of those used to ask the indexer for the tip and for every pending txid again, one
// request after another; these pin that one window shares the reads and runs them together.

const TIP = 100
const CONFIRMED_AT = { a: 99, b: null, c: 100 }

let calls
let inFlight
let peak

const fetchMock = async (url) => {
  calls.push(url)
  inFlight += 1
  peak = Math.max(peak, inFlight)
  await new Promise((resolve) => setTimeout(resolve, 5))
  inFlight -= 1

  if (url.endsWith('/blocks/tip/height')) return { text: async () => String(TIP) }

  const txid = url.match(/\/tx\/([^/]+)\/status$/)[1]
  const height = CONFIRMED_AT[txid]

  return { json: async () => (height == null ? { confirmed: false } : { confirmed: true, block_height: height }) }
}

const engine = () => new Engine({}, { network: 'Regtest', esploraUrl: 'https://indexer.test/api/', slots: {}, fee: {} })

const PENDING = [
  { txid: 'a', status: 'WaitingConfirmations' },
  { txid: 'b', status: 'WaitingConfirmations' },
  { txid: 'a', status: 'WaitingConfirmations' },
  { txid: 'c', status: 'WaitingCounterparty' },
  { txid: 'd', status: 'Settled' }
]

beforeEach(() => {
  calls = []
  inFlight = 0
  peak = 0
  global.fetch = jest.fn(fetchMock)
})

afterEach(() => {
  delete global.fetch
})

describe('confirmation counts', () => {
  test('counts from the tip, one request per distinct pending txid', async () => {
    const out = await engine()._withConfirmations(PENDING)

    expect(out.map((t) => t.confirmations)).toEqual([2, 0, 2, 1, undefined])
    expect(calls.filter((u) => u.endsWith('/blocks/tip/height'))).toHaveLength(1)
    expect(calls.filter((u) => u.includes('/tx/')).sort()).toEqual([
      'https://indexer.test/api/tx/a/status',
      'https://indexer.test/api/tx/b/status',
      'https://indexer.test/api/tx/c/status'
    ])
  })

  test('status lookups run side by side, not one after another', async () => {
    await engine()._withConfirmations(PENDING)

    expect(peak).toBeGreaterThan(1)
  })

  test('calls in the same window share the reads', async () => {
    const e = engine()

    await e._withConfirmations(PENDING)
    await e._withConfirmations(PENDING.slice(0, 2))
    await Promise.all([e._withConfirmations(PENDING), e._withConfirmations(PENDING)])

    expect(calls).toHaveLength(4)
  })

  test('a refresh starts a new window', async () => {
    const e = engine()

    await e._withConfirmations(PENDING)
    e._chainReads = null
    await e._withConfirmations(PENDING)

    expect(calls).toHaveLength(8)
  })

  test('an unreachable indexer leaves the counts unknown', async () => {
    global.fetch = jest.fn(async () => { throw new Error('offline') })

    const out = await engine()._withConfirmations(PENDING)

    expect(out.every((t) => t.confirmations === undefined)).toBe(true)
  })
})
