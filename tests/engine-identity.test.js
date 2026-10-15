'use strict'

import { describe, expect, test } from '@jest/globals'

import Engine from '../src/engine.js'
import WalletManagerRgb from '../src/wallet-manager-rgb.js'
import { SLOTS } from '../src/slots.js'

// A wallet that keeps its bitcoin on another chain than the identity address: the main wallet
// opens on that chain, and a second one, on the default chain, signs as the identity address.

const IDENTITY = 'bcrt1plqhzpzvndkcyqw3xj3f98r6kx2ev2p38l6wj82d7zx2c6cnvjcqqunnd4l'
const WALLET = 'bc1q9vza2e8x573nczrlzms0wvx3gsqjx7vavgkx0l'
const PHRASE = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'

function bindings (created) {
  class WasmWallet {
    static async create (json) {
      const data = JSON.parse(json)
      const w = {
        data,
        flush: async () => {},
        getAddress: async () => (data.vanillaKeychain ? WALLET : IDENTITY),
        signPsbt: async (psbt) => { w.signed = psbt; throw new Error(`signed by ${data.dataDir}`) },
        free: () => { w.freed = true }
      }
      created.push(w)
      return w
    }
  }
  return {
    default: async () => {},
    restoreKeys: () => ({ accountXpubVanilla: 'xv', accountXpubColored: 'xc', masterFingerprint: 'fp' }),
    WasmWallet
  }
}

const open = async (vanillaKeychain) => {
  const created = []
  const engine = new Engine(bindings(created), { network: 'Regtest', dataDir: ':memory:/Regtest', slots: SLOTS, fee: {}, deferOnline: true, vanillaKeychain })
  engine._requestPersistence = async () => false
  await engine.open(PHRASE)
  return { engine, created }
}

describe('vanillaKeychain', () => {
  test('by default one wallet, on the default chain, signs as its own address', async () => {
    const { engine, created } = await open(0)
    expect(created).toHaveLength(1)
    expect(created[0].data.vanillaKeychain).toBeNull()
    expect(created[0].data.dataDir).toBe(':memory:/Regtest')
    expect(await engine.identityAddress()).toBe(IDENTITY)
  })

  test('another chain: the wallet keeps its own snapshot, and signing goes to the identity wallet', async () => {
    const { engine, created } = await open(2)
    expect(created.map((w) => [w.data.dataDir, w.data.vanillaKeychain])).toEqual([
      [':memory:/Regtest/k2', 2],
      [':memory:/Regtest/identity', null]
    ])
    expect(await engine.identityAddress()).toBe(IDENTITY)
    await expect(engine.signMessage('hello')).rejects.toThrow('signed by :memory:/Regtest/identity')
    engine.dispose()
    expect(created.every((w) => w.freed)).toBe(true)
  })

  test('the manager refuses a keychain outside 0 to 255', () => {
    expect(() => new WalletManagerRgb(PHRASE, { network: 'Regtest', esploraUrl: 'http://x', vanillaKeychain: 256 })).toThrow(RangeError)
    expect(() => new WalletManagerRgb(PHRASE, { network: 'Regtest', esploraUrl: 'http://x', vanillaKeychain: 1.5 })).toThrow(RangeError)
  })
})
