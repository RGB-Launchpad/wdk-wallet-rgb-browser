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

// m/86'/0'/0'/0/0 of PHRASE (BIP-86's test vector), and the same key written for Regtest.
const MAINNET_IDENTITY = 'bc1p5cyxnuxmeuwuvkwfem96lqzszd02n6xdcjrs20cac6yqjjwudpxqkedrcr'
const MAINNET_IDENTITY_ON_REGTEST = 'bcrt1p5cyxnuxmeuwuvkwfem96lqzszd02n6xdcjrs20cac6yqjjwudpxqvg32hk'

// `readsColored`: whether the bindings take `coloredKeychain` from the wallet data, as this
// module's published engine does not.
function bindings (created, { readsColored = true } = {}) {
  class WasmWallet {
    static async create (json) {
      const data = JSON.parse(json)
      const w = {
        data,
        flush: async () => {},
        getAddress: async () => (data.vanillaKeychain ? WALLET : data.bitcoinNetwork === 'Mainnet' ? MAINNET_IDENTITY : IDENTITY),
        signPsbt: async (psbt) => { w.signed = psbt; throw new Error(`signed by ${data.dataDir}`) },
        getWalletData: () => {
          const { coloredKeychain, ...rest } = data
          return readsColored ? { ...rest, coloredKeychain: coloredKeychain ?? null } : rest
        },
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

const open = async (vanillaKeychain, identityCoinType = null, { coloredKeychain = 0, readsColored = true, created = [] } = {}) => {
  const engine = new Engine(bindings(created, { readsColored }), { network: 'Regtest', dataDir: ':memory:/Regtest', slots: SLOTS, fee: {}, deferOnline: true, vanillaKeychain, coloredKeychain, identityCoinType, schemas: ['Nia', 'Ifa'] })
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

  test('identityCoinType 0 off Mainnet: the identity key is the Mainnet one, its address written for the network', async () => {
    const { engine, created } = await open(2, 0)
    expect(created.map((w) => [w.data.dataDir, w.data.vanillaKeychain, w.data.bitcoinNetwork, w.data.supportedSchemas])).toEqual([
      [':memory:/Regtest/k2', 2, 'Regtest', ['Nia', 'Ifa']],
      [':memory:/Regtest/identity-c0', null, 'Mainnet', ['Nia']]
    ])
    expect(await engine.identityAddress()).toBe(MAINNET_IDENTITY_ON_REGTEST)
    await expect(engine.signMessage('hello')).rejects.toThrow('signed by :memory:/Regtest/identity-c0')
  })

  test('identityCoinType 0 with the bitcoin on the default chain changes nothing', async () => {
    const { engine, created } = await open(0, 0)
    expect(created).toHaveLength(1)
    expect(await engine.identityAddress()).toBe(IDENTITY)
  })

  test('the manager refuses a keychain outside 0 to 255', () => {
    expect(() => new WalletManagerRgb(PHRASE, { network: 'Regtest', esploraUrl: 'http://x', vanillaKeychain: 256 })).toThrow(RangeError)
    expect(() => new WalletManagerRgb(PHRASE, { network: 'Regtest', esploraUrl: 'http://x', vanillaKeychain: 1.5 })).toThrow(RangeError)
  })
})

describe('coloredKeychain', () => {
  test('by default the wallet data names no colored chain, and the snapshot stays where it was', async () => {
    const { created } = await open(2)
    expect(created.map((w) => [w.data.dataDir, 'coloredKeychain' in w.data])).toEqual([
      [':memory:/Regtest/k2', false],
      [':memory:/Regtest/identity', false]
    ])
  })

  test('another colored chain: the wallet opens on it with a snapshot of its own; the identity wallet does not', async () => {
    const { engine, created } = await open(2, null, { coloredKeychain: 2 })
    expect(created.map((w) => [w.data.dataDir, w.data.vanillaKeychain, w.data.coloredKeychain])).toEqual([
      [':memory:/Regtest/k2c2', 2, 2],
      [':memory:/Regtest/identity', null, undefined]
    ])
    expect(await engine.identityAddress()).toBe(IDENTITY)
  })

  test('another colored chain with the bitcoin on the default one', async () => {
    const { created } = await open(0, null, { coloredKeychain: 3 })
    expect(created.map((w) => [w.data.dataDir, w.data.vanillaKeychain, w.data.coloredKeychain])).toEqual([
      [':memory:/Regtest/k0c3', null, 3]
    ])
  })

  test('bindings that do not read it: the wallet is not opened', async () => {
    const created = []
    await expect(open(2, null, { coloredKeychain: 2, readsColored: false, created })).rejects.toThrow('do not read coloredKeychain')
    expect(created).toHaveLength(1)
    expect(created[0].freed).toBe(true)
  })

  test('the manager refuses a colored chain outside 0 to 255', () => {
    expect(() => new WalletManagerRgb(PHRASE, { network: 'Regtest', esploraUrl: 'http://x', coloredKeychain: 256 })).toThrow(RangeError)
    expect(() => new WalletManagerRgb(PHRASE, { network: 'Regtest', esploraUrl: 'http://x', coloredKeychain: -1 })).toThrow(RangeError)
  })
})

describe('queue', () => {
  test('a host queue runs every command instead of the module\'s own', async () => {
    const created = []
    const ran = []
    const queue = (task) => { ran.push('host'); return task() }
    const engine = new Engine(bindings(created), { network: 'Regtest', dataDir: ':memory:/Regtest', slots: SLOTS, fee: {}, deferOnline: true, queue })
    engine._requestPersistence = async () => false
    await engine.open(PHRASE)
    await engine.identityAddress()
    expect(ran).toEqual(['host'])
  })
})
