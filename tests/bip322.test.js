'use strict'

import { describe, expect, test } from '@jest/globals'

import {
  BIP322_TAG,
  b64,
  buildToSignPsbt,
  buildVirtualTxs,
  decodeAddress,
  extractWitness,
  hex,
  scriptPubKeyOf,
  taggedHash,
  withHrp
} from '../src/bip322.js'

// The address from the BIP-322 specification's own vectors (P2WPKH).
const ADDR = 'bc1q9vza2e8x573nczrlzms0wvx3gsqjx7vavgkx0l'

const txid = (internal) => hex.to(internal.slice().reverse())

describe('the official vectors', () => {
  test('the tag is the one the BIP names', () => {
    expect(BIP322_TAG).toBe('BIP0322-signed-message')
  })

  test('to_spend txid for the empty message', async () => {
    const { toSpendTxid } = await buildVirtualTxs(ADDR, '')

    expect(txid(toSpendTxid))
      .toBe('c5680aa69bb8d860bf82d4e9cd3504b55dde018de765a91bb566283c545a99a7')
  })

  test('to_spend txid for "Hello World"', async () => {
    const { toSpendTxid } = await buildVirtualTxs(ADDR, 'Hello World')

    expect(txid(toSpendTxid))
      .toBe('b79d196740ad5217771c1098fc4a4b51e0535c32236c71f1ea4d61a2d603352b')
  })
})

describe('address decoding', () => {
  test('a P2WPKH address is version 0 with a 20-byte program', () => {
    const decoded = decodeAddress(ADDR)

    expect(decoded.version).toBe(0)
    expect(decoded.program.length).toBe(20)
    expect(hex.to(scriptPubKeyOf(ADDR)).slice(0, 4)).toBe('0014')
  })

  test('a P2TR address is version 1 with a 32-byte program', () => {
    const taproot = 'bcrt1plqhzpzvndkcyqw3xj3f98r6kx2ev2p38l6wj82d7zx2c6cnvjcqqunnd4l'
    const decoded = decodeAddress(taproot)

    expect(decoded.version).toBe(1)
    expect(decoded.program.length).toBe(32)
    expect(hex.to(scriptPubKeyOf(taproot)).slice(0, 4)).toBe('5120')
  })

  test('a bad checksum is rejected', () => {
    const bad = 'bcrt1plqhzpzvndkcyqw3xj3f98r6kx2ev2p38l6wj82d7zx2c6cnvjcqqunnd4m'

    expect(() => decodeAddress(bad)).toThrow(/checksum/)
  })

  test('an address written for another network keeps its scriptPubKey (bitcoind validates the results)', () => {
    const taproot = 'bc1p5cyxnuxmeuwuvkwfem96lqzszd02n6xdcjrs20cac6yqjjwudpxqkedrcr'

    expect(withHrp(taproot, 'tb')).toBe('tb1p5cyxnuxmeuwuvkwfem96lqzszd02n6xdcjrs20cac6yqjjwudpxqp3mvzv')
    expect(withHrp(taproot, 'bcrt')).toBe('bcrt1p5cyxnuxmeuwuvkwfem96lqzszd02n6xdcjrs20cac6yqjjwudpxqvg32hk')
    expect(withHrp(taproot, 'bc')).toBe(taproot)
    expect(withHrp(ADDR, 'bcrt')).toBe('bcrt1q9vza2e8x573nczrlzms0wvx3gsqjx7vay85cr9')
    expect(hex.to(scriptPubKeyOf(withHrp(taproot, 'tb')))).toBe(hex.to(scriptPubKeyOf(taproot)))
  })

  test('the bech32 constant does not validate a bech32m address', () => {
    const taproot = 'bcrt1plqhzpzvndkcyqw3xj3f98r6kx2ev2p38l6wj82d7zx2c6cnvjcqqunnd4l'

    expect(() => decodeAddress(taproot.replace('bcrt1p', 'bcrt1q'))).toThrow()
  })
})

describe('the message', () => {
  test('is hashed verbatim, so one extra space is a different hash', async () => {
    const a = await taggedHash(BIP322_TAG, new TextEncoder().encode('hi'))
    const b = await taggedHash(BIP322_TAG, new TextEncoder().encode('hi '))

    expect(hex.to(a)).not.toBe(hex.to(b))
  })
})

describe('to_sign', () => {
  test('spends to_spend output 0 and pays a single OP_RETURN', async () => {
    const { toSign, toSpendTxid } = await buildVirtualTxs(ADDR, 'x')
    const serialised = hex.to(toSign)

    expect(serialised.startsWith(`00000000` + `01` + hex.to(toSpendTxid) + `00000000`)).toBe(true)
    expect(serialised.endsWith(`01` + `0000000000000000` + `01` + `6a` + `00000000`)).toBe(true)
  })
})

describe('the PSBT handed to the wallet', () => {
  test('carries the magic and one input with both non_witness_utxo (to_spend) and witness_utxo', async () => {
    const psbt = await buildToSignPsbt(ADDR, 'Hello World')
    const { toSpend, toSign, scriptPubKey } = await buildVirtualTxs(ADDR, 'Hello World')

    expect(psbt).toMatch(/^cHNidP8/)

    // Parse PSBT v0 maps: global map, then input 0 map.
    const bytes = b64.from(psbt)
    let o = 5
    const readVarint = () => {
      const b = bytes[o++]
      if (b < 0xfd) return b
      if (b === 0xfd) { const v = bytes[o] | (bytes[o + 1] << 8); o += 2; return v }
      throw new Error('unexpected varint')
    }
    const readMap = () => {
      const map = new Map()
      for (;;) {
        const klen = readVarint()
        if (klen === 0) return map
        const key = bytes.slice(o, o + klen); o += klen
        const vlen = readVarint()
        const val = bytes.slice(o, o + vlen); o += vlen
        map.set(hex.to(key), val)
      }
    }
    const global = readMap()
    const input0 = readMap()

    expect(hex.to(global.get('00'))).toBe(hex.to(toSign))
    expect(hex.to(input0.get('00'))).toBe(hex.to(toSpend))
    expect(hex.to(input0.get('01'))).toBe(
      '0000000000000000' + scriptPubKey.length.toString(16).padStart(2, '0') + hex.to(scriptPubKey)
    )
  })

  test('says so when the wallet did not sign the input', async () => {
    const psbt = await buildToSignPsbt(ADDR, 'Hello World')

    expect(() => extractWitness(psbt)).toThrow(/did not sign/)
  })
})
