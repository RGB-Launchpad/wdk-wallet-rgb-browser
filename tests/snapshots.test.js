'use strict'

import { describe, expect, test } from '@jest/globals'

import { dataDirOf, isChainMismatch, snapshotPrefix } from '../src/snapshots.js'

describe('the snapshot key', () => {
  test('carries the network, so one chain never loads the other one snapshot', () => {
    expect(dataDirOf('Signet')).not.toBe(dataDirOf('Regtest'))
    expect(dataDirOf('Signet')).toContain('Signet')
  })

  test('prefixes every snapshot of one network', () => {
    expect(snapshotPrefix('Regtest')).toBe(`${dataDirOf('Regtest')}/`)
  })
})

describe('isChainMismatch', () => {
  test('recognises the error a replaced chain produces', () => {
    expect(isChainMismatch(
      'Failed bdk sync: introduced chain cannot connect with the original chain, try include height 5318'
    )).toBe(true)
  })

  test('does not claim every failure is one', () => {
    expect(isChainMismatch('Invalid indexer: not a valid esplora server.')).toBe(false)
    expect(isChainMismatch(undefined)).toBe(false)
  })
})
