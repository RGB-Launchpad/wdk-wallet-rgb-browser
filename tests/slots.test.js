'use strict'

import { describe, expect, test } from '@jest/globals'

import {
  SLOTS,
  payableRate,
  explainReceiveError,
  explainSendError,
  freeSlots,
  slotBlocker,
  slotCost,
  slotsToCreate,
  usableEmptySlots
} from '../src/slots.js'

const unspent = (overrides = {}) => ({
  utxo: { colorable: true, exists: true, btcAmount: SLOTS.utxoSizeSat, ...(overrides.utxo || {}) },
  rgbAllocations: overrides.rgbAllocations || [],
  pendingBlinded: overrides.pendingBlinded || 0
})

describe('slotCost', () => {
  test('covers the sats parked plus the fee of the splitting transaction', () => {
    expect(slotCost(10, 3)).toBe(BigInt(3 * SLOTS.utxoSizeSat + 10 * SLOTS.prepareVsize))
  })

  test('never reports less than the floor', () => {
    expect(slotCost(1, 0)).toBe(BigInt(SLOTS.minSatToPrepare))
  })
})

describe('slotBlocker', () => {
  test('refuses while any input is unconfirmed, because the batch takes them all', () => {
    const reason = slotBlocker({ settled: 1_000_000, spendable: 1_100_000 }, 10)

    expect(reason).toMatch(/unconfirmed input would put all of them at risk/)
  })

  test('refuses when the confirmed balance cannot pay', () => {
    const reason = slotBlocker({ settled: 100, spendable: 100 }, 10)

    expect(reason).toMatch(/Not enough Bitcoin/)
  })

  test('allows when the balance is confirmed and sufficient', () => {
    expect(slotBlocker({ settled: 1_000_000, spendable: 1_000_000 }, 10)).toBeNull()
  })
})

describe('usableEmptySlots', () => {
  test('counts only empty colored UTXOs big enough to pay for being spent', () => {
    expect(usableEmptySlots([
      unspent(),
      unspent({ utxo: { btcAmount: 1 } }),
      unspent({ rgbAllocations: [{}] }),
      unspent({ pendingBlinded: 1 }),
      unspent({ utxo: { colorable: false } }),
      unspent({ utxo: { exists: false } })
    ])).toBe(1)
  })
})

describe('slotsToCreate', () => {
  test('tops the wallet back up to the configured number', () => {
    expect(slotsToCreate([])).toBe(SLOTS.utxoNum)
    expect(slotsToCreate([unspent(), unspent(), unspent(), unspent()])).toBe(0)
  })
})

describe('freeSlots', () => {
  test('counts the room left on every colored UTXO', () => {
    expect(freeSlots([
      unspent(),
      unspent({ rgbAllocations: [{}, {}] }),
      unspent({ utxo: { colorable: false } })
    ])).toBe(SLOTS.maxAllocationsPerUtxo + (SLOTS.maxAllocationsPerUtxo - 2))
  })
})

describe('explainReceiveError', () => {
  test('says the slots are there but not yet usable', () => {
    const message = explainReceiveError('Insufficient allocations')

    expect(message).toMatch(/confirmation/)
    expect(message).toMatch(/needs no slot/)
  })

  test('leaves any other message alone', () => {
    expect(explainReceiveError('Proxy unreachable')).toBe('Proxy unreachable')
  })
})

describe('payableRate', () => {
  test('is what one slot can pay for a send, not a number chosen on its own', () => {
    expect(payableRate()).toBe(Math.floor(SLOTS.utxoSizeSat / SLOTS.sendVsize))
  })

  test('rises with the slot size, because a bigger slot can pay more', () => {
    const bigger = payableRate({ ...SLOTS, utxoSizeSat: 40000 })

    expect(bigger).toBe(Math.floor(40000 / SLOTS.sendVsize))
    expect(bigger).toBeGreaterThan(payableRate())
  })

  test('a send at the ceiling still fits in one slot', () => {
    expect(payableRate() * SLOTS.sendVsize).toBeLessThanOrEqual(SLOTS.utxoSizeSat)
  })
})

describe('explainSendError', () => {
  test('says what an allocation shortfall means for this wallet', () => {
    const message = explainSendError('Insufficient allocations', 30)

    expect(message).toMatch(/cannot pay the fee at 30 sat\/vB/)
    expect(message).toMatch(/Create slots/)
  })

  test('leaves any other message alone', () => {
    expect(explainSendError('Something else went wrong', 30)).toBe('Something else went wrong')
  })
})
