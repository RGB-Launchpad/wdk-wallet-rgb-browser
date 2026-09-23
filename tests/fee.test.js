'use strict'

import { describe, expect, test } from '@jest/globals'

import { MAINNET_FEE, TEST_NETWORK_FEE, bid, clearingRate, feeFor } from '../src/fee.js'

describe('clearingRate', () => {
  test('is the rate at which one block fills', () => {
    // 600k vB at 50 does not fill a block; adding the 600k at 20 does, so 20 is the rate a
    // transaction has to match to be in the next one.
    const histogram = [[50, 600_000], [20, 600_000], [5, 600_000]]

    expect(clearingRate(histogram, TEST_NETWORK_FEE)).toBe(20)
  })

  test('is zero when the whole queue fits in one block', () => {
    expect(clearingRate([[50, 10]], TEST_NETWORK_FEE)).toBe(0)
    expect(clearingRate([], TEST_NETWORK_FEE)).toBe(0)
    expect(clearingRate(undefined, TEST_NETWORK_FEE)).toBe(0)
  })
})

describe('bid', () => {
  test('never goes below the floor, whatever the signals say', () => {
    expect(bid([0.1], TEST_NETWORK_FEE)).toBe(TEST_NETWORK_FEE.min)
    expect(bid([], TEST_NETWORK_FEE)).toBe(TEST_NETWORK_FEE.min)
  })

  test('applies the safety multiplier to the highest usable signal', () => {
    expect(bid([4, 12], TEST_NETWORK_FEE)).toBe(36)
  })

  test('drops signals that are not positive numbers', () => {
    expect(bid([NaN, undefined, -1, 'lots', 12], TEST_NETWORK_FEE)).toBe(36)
  })

  test('never goes above the cap', () => {
    expect(bid([10_000], TEST_NETWORK_FEE)).toBe(TEST_NETWORK_FEE.max)
  })
})

describe('feeFor', () => {
  test('bids conservatively where the coins are worth something', () => {
    expect(feeFor('Mainnet')).toBe(MAINNET_FEE)
    expect(feeFor('Signet')).toBe(TEST_NETWORK_FEE)
    expect(feeFor('Regtest')).toBe(TEST_NETWORK_FEE)
  })
})
