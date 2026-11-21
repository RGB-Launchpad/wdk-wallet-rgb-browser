'use strict'

import { afterEach, describe, expect, test } from '@jest/globals'

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
// module's published engine does not. The message signer (`…/signer`) answers `signerAddress`
// when one is given, fails to open with `signerFails`, and opens once `signerOpens` settles.
// Each signature takes `signMs`; `signing` counts those under way at once.
function bindings (created, { readsColored = true, signerAddress = null, signerFails = false, signerOpens = null, signMs = 0, signing = { now: 0, most: 0 } } = {}) {
  class WasmWallet {
    static async create (json) {
      const data = JSON.parse(json)
      const signer = data.dataDir.endsWith('/signer')
      if (signer && signerOpens) await signerOpens
      if (signer && signerFails) throw new Error('the signer did not open')
      const w = {
        data,
        flush: async () => { w.flushed = true },
        getAddress: async () => (signer && signerAddress) || (data.vanillaKeychain ? WALLET : data.bitcoinNetwork === 'Mainnet' ? MAINNET_IDENTITY : IDENTITY),
        signPsbt: async (psbt) => {
          w.signed = psbt
          signing.most = Math.max(signing.most, ++signing.now)
          await new Promise((resolve) => setTimeout(resolve, signMs))
          signing.now--
          throw new Error(`signed by ${data.dataDir}`)
        },
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

// Every engine a test opens is closed after it: one wallet is open in one place at a time, and
// the next test opens the same phrase.
const opened = []
afterEach(() => { for (const engine of opened.splice(0)) engine.dispose() })

const open = async (vanillaKeychain, identityCoinType = null, { coloredKeychain = 0, readsColored = true, created = [], queue, ...more } = {}) => {
  const engine = new Engine(bindings(created, { readsColored, ...more }), { network: 'Regtest', dataDir: ':memory:/Regtest', slots: SLOTS, fee: {}, deferOnline: true, vanillaKeychain, coloredKeychain, identityCoinType, schemas: ['Nia', 'Ifa'], queue })
  engine._requestPersistence = async () => false
  opened.push(engine)
  await engine.open(PHRASE)
  return { engine, created }
}

describe('vanillaKeychain', () => {
  test('by default the wallet, on the default chain, signs as its own address, on a signer of its own', async () => {
    const { engine, created } = await open(0)
    expect(await engine.hasMessageSigner()).toBe(true)
    expect(created.map((w) => [w.data.dataDir, w.data.vanillaKeychain])).toEqual([
      [':memory:/Regtest', null],
      [':memory:/Regtest/signer', null]
    ])
    expect(await engine.identityAddress()).toBe(IDENTITY)
    await expect(engine.signMessage('hello')).rejects.toThrow('signed by :memory:/Regtest/signer')
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
    await engine.hasMessageSigner()
    expect(created.map((w) => w.data.dataDir)).toEqual([':memory:/Regtest', ':memory:/Regtest/signer'])
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
    const { engine, created } = await open(0, null, { coloredKeychain: 3 })
    await engine.hasMessageSigner()
    expect(created.map((w) => [w.data.dataDir, w.data.vanillaKeychain, w.data.coloredKeychain])).toEqual([
      [':memory:/Regtest/k0c3', null, 3],
      [':memory:/Regtest/signer', null, undefined]
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
    opened.push(engine)
    await engine.open(PHRASE)
    await engine.identityAddress()
    expect(ran).toEqual(['host'])
  })
})

describe('message signer', () => {
  // A host queue that never runs what it is given: the wallet is held for as long as the test lasts.
  const held = () => () => new Promise(() => {})

  test('it is never written, and signs while the wallet is held', async () => {
    const { engine, created } = await open(0, null, { queue: held() })
    expect(await engine.hasMessageSigner()).toBe(true)
    await expect(engine.signMessage('hello')).rejects.toThrow('signed by :memory:/Regtest/signer')
    expect(created[1].flushed).toBeUndefined()
  })

  test('the identity wallet of a wallet on another chain signs while the wallet is held too', async () => {
    const { engine } = await open(2, null, { queue: held() })
    expect(await engine.hasMessageSigner()).toBe(true)
    await expect(engine.signMessage('hello')).rejects.toThrow('signed by :memory:/Regtest/identity')
  })

  test('one on another address is closed, and the wallet signs, in the queue', async () => {
    const ran = []
    const queue = (task) => { ran.push('host'); return task() }
    const { engine, created } = await open(0, null, { queue, signerAddress: 'bcrt1pother' })
    expect(await engine.hasMessageSigner()).toBe(false)
    expect(created[1].freed).toBe(true)
    await expect(engine.signMessage('hello')).rejects.toThrow('signed by :memory:/Regtest')
    expect(created[0].signed).toBeDefined()
    expect(ran).toEqual(['host'])
  })

  test('one that does not open leaves the wallet open, and the wallet signs', async () => {
    const { engine, created } = await open(0, null, { signerFails: true })
    expect(engine.isOpen).toBe(true)
    expect(await engine.hasMessageSigner()).toBe(false)
    await expect(engine.signMessage('hello')).rejects.toThrow('signed by :memory:/Regtest')
    expect(created).toHaveLength(1)
  })

  test('the wallet does not wait for it to open, and a signature does', async () => {
    let opens
    const signerOpens = new Promise((resolve) => { opens = resolve })
    const { engine } = await open(0, null, { signerOpens })
    expect(engine.isOpen).toBe(true)
    const signing = engine.signMessage('hello')
    opens()
    await expect(signing).rejects.toThrow('signed by :memory:/Regtest/signer')
  })

  test('one that opens after the wallet closed is closed with it', async () => {
    let opens
    const signerOpens = new Promise((resolve) => { opens = resolve })
    const created = []
    const { engine } = await open(0, null, { signerOpens, created })
    engine.dispose()
    opens()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(created.every((w) => w.freed)).toBe(true)
    await expect(engine.signMessage('hello')).rejects.toThrow('not open')
  })

  test('signatures asked for at once take turns on it', async () => {
    const signing = { now: 0, most: 0 }
    const { engine } = await open(0, null, { signMs: 20, signing })
    await Promise.allSettled([engine.signMessage('a'), engine.signMessage('b'), engine.signMessage('c')])
    expect(signing.most).toBe(1)
  })

  test('it is closed with the wallet', async () => {
    const { engine, created } = await open(0)
    await engine.hasMessageSigner()
    engine.dispose()
    expect(created.map((w) => w.freed)).toEqual([true, true])
  })
})
