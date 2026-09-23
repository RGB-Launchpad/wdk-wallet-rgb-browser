'use strict'

import { describe, expect, test } from '@jest/globals'

import Engine from '../src/engine.js'

// Two shapes of rgb-lib bindings are in circulation. The published WebAssembly build takes an
// asset id, where passing none returns only the transfers belonging to no asset. A build from
// a later commit takes an AssetFilter, where "any" means every transfer. A wallet asking for
// its history must get the same answer from both.

const ASSETS = { nia: [{ assetId: 'rgb:one' }, { assetId: 'rgb:two' }], ifa: [] }

const BY_ASSET = {
  'rgb:one': [{ batchTransferIdx: 1, txid: 'a' }, { batchTransferIdx: 3, txid: 'c' }],
  'rgb:two': [{ batchTransferIdx: 2, txid: 'b' }],
  undefined: [{ batchTransferIdx: 4, txid: 'd' }]
}

const engineWith = (listTransfers) => {
  const engine = new Engine({}, { network: 'Regtest', slots: {}, fee: {} })

  engine._wallet = { listAssets: () => ASSETS, listTransfers }

  return engine
}

describe('listTransfers across both binding shapes', () => {
  test('asset-id bindings: no argument gathers every asset, not the assetless ones alone', () => {
    const engine = engineWith((arg) => {
      if (arg && typeof arg === 'object') throw new Error(`Asset with id ${JSON.stringify(arg)} not found`)
      if (typeof arg === 'string' && arg.startsWith('rgb:') === false) {
        throw new Error(`Asset with id ${arg} not found`)
      }
      return BY_ASSET[arg] ?? []
    })

    const all = engine._listTransfers()

    expect(all.map((t) => t.batchTransferIdx)).toEqual([1, 2, 3, 4])
  })

  test('asset-id bindings: an asset id restricts to that asset', () => {
    const engine = engineWith((arg) => {
      if (typeof arg !== 'string' || !arg.startsWith('rgb:')) throw new Error(`Asset with id ${arg} not found`)
      return BY_ASSET[arg] ?? []
    })

    expect(engine._listTransfers('rgb:two').map((t) => t.txid)).toEqual(['b'])
  })

  test('filter bindings: "any" is passed straight through', () => {
    const seen = []
    const engine = engineWith((arg) => {
      seen.push(arg)
      return [{ batchTransferIdx: 9, txid: 'z' }]
    })

    expect(engine._listTransfers().map((t) => t.txid)).toEqual(['z'])
    expect(seen).toEqual(['any'])
  })

  test('the shape is settled once and not probed again', () => {
    const seen = []
    const engine = engineWith((arg) => {
      seen.push(arg)
      if (arg === 'any') throw new Error('Asset with id any not found')
      return BY_ASSET[arg] ?? []
    })

    engine._listTransfers()
    engine._listTransfers()

    expect(seen.filter((a) => a === 'any')).toHaveLength(1)
  })
})
