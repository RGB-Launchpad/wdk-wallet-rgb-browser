'use strict'

import { readFileSync } from 'node:fs'
import { describe, expect, test } from '@jest/globals'

import Engine from '../src/engine.js'
import WalletAccountRgb from '../src/wallet-account-rgb.js'
import WalletManagerRgb from '../src/wallet-manager-rgb.js'
import { SLOTS } from '../src/slots.js'

const { psbt: PSBT } = JSON.parse(readFileSync(new URL('./fixtures/psbt.json', import.meta.url), 'utf8')).rgbSend
const USDT_CONTRACT_ID = 'rgb:uVMNCuVU-U00Y_wv-6~7ZbW7-tEuUMcE-pB0wDzC-nt7Qsdc'
const VALID_PK = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'
const SEED = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'

describe('RGB 0.11.2 dual-stack engine and account upgrades', () => {
  test('0-balance valid ContractId opens blind and witness dual-stack invoices and skips 1.0 proxy on _proxyHolds', async () => {
    const blindCalls = []
    const witnessCalls = []
    const fetchedUrls = []
    const origFetch = globalThis.fetch

    globalThis.fetch = async (url) => {
      fetchedUrls.push(String(url))
      return {
        ok: true,
        json: async () => ({ error: { code: -400 } })
      }
    }

    try {
      const engine = new Engine({}, {
        network: 'Signet',
        proxyUrl: 'rpcs://proxy.example.org/v1/json-rpc',
        fallbackProxyUrls: ['rpcs://proxy.example.org/json-rpc'],
        minConfirmations: 1,
        invoiceMinutes: 60,
        slots: SLOTS,
        fee: {}
      })
      engine._online = { id: 1 }
      engine._wallet = {
        listUnspents: () => [{
          utxo: { colorable: true, exists: true, btcAmount: SLOTS.utxoSizeSat },
          rgbAllocations: [],
          pendingBlinded: 0
        }],
        blindReceive: async (...args) => {
          blindCalls.push(args)
          return {
            invoice: `${USDT_CONTRACT_ID}/utxob:seal?endpoints=rpcs://proxy.example.org/v1/json-rpc&pk=${VALID_PK}`,
            recipientId: 'tb:utxob:seal',
            publicKey: VALID_PK
          }
        },
        rotateAddress: async () => {},
        witnessReceive: async (...args) => {
          witnessCalls.push(args)
          return {
            invoice: `${USDT_CONTRACT_ID}/wvout:seal?endpoints=rpcs://proxy.example.org/v1/json-rpc&pk=${VALID_PK}`,
            recipientId: 'tb:wvout:seal',
            publicKey: VALID_PK
          }
        },
        flush: async () => {}
      }

      const blind = await engine.blindReceive({ assetId: USDT_CONTRACT_ID })
      expect(blind.publicKey).toBe(VALID_PK)
      expect(blindCalls[0][0]).toBe(USDT_CONTRACT_ID)
      expect(blindCalls[0][3]).toEqual([
        'rpcs://proxy.example.org/v1/json-rpc',
        'rpcs://proxy.example.org/json-rpc'
      ])

      const witness = await engine.witnessReceive({ assetId: USDT_CONTRACT_ID, amount: '5000000' })
      expect(witness.publicKey).toBe(VALID_PK)
      expect(witnessCalls[0][0]).toBe(USDT_CONTRACT_ID)
      expect(witnessCalls[0][1]).toEqual({ Fungible: 5000000 })
      expect(fetchedUrls).toEqual(['https://proxy.example.org/json-rpc'])

      await expect(engine.blindReceive({ assetId: 'not-a-contract-id' }))
        .rejects.toThrow(/valid RGB contract id/)
    } finally {
      globalThis.fetch = origFetch
    }
  })

  test('goOnline passes evmChains and falls back cleanly if EVM RPC check fails', async () => {
    const calls = []
    const engine = new Engine({}, {
      network: 'Signet',
      esploraUrl: 'https://esplora.example.org/api',
      evmChains: { 42161: ['https://evm.example.org/rpc'] },
      slots: SLOTS,
      fee: {}
    })
    let failEvm = true
    engine._wallet = {
      goOnline: async (...args) => {
        calls.push(args)
        if (args.length === 3 && failEvm) {
          throw new Error('Invalid EVM RPC URL: timeout')
        }
        return { id: args.length }
      }
    }

    await expect(engine.goOnline()).resolves.toBe(true)
    expect(calls).toHaveLength(2)
    expect(calls[0]).toEqual([true, 'https://esplora.example.org/api', { 42161: ['https://evm.example.org/rpc'] }])
    expect(calls[1]).toEqual([true, 'https://esplora.example.org/api'])
    expect(engine._evmOnlineError).toMatch(/Invalid EVM RPC/)

    calls.length = 0
    failEvm = false
    await expect(engine.goOnline()).resolves.toBe(true)
    expect(calls).toHaveLength(1)
    expect(engine._evmOnlineError).toBeNull()
  })

  test('consignmentVersion defaults to v0, updates on account, and rejects unknown versions', async () => {
    let persisted = 'v0'
    let flushed = 0
    const engine = new Engine({}, {
      network: 'Signet',
      slots: SLOTS,
      fee: {}
    })
    engine._wallet = {
      getConsignmentVersion: async () => persisted,
      setConsignmentVersion: async (v) => { persisted = v },
      flush: async () => { flushed++ }
    }
    const account = new WalletAccountRgb(engine, 0)

    await expect(account.getConsignmentVersion()).resolves.toBe('v0')
    await expect(account.setConsignmentVersion('v1')).resolves.toBe('v1')
    expect(flushed).toBe(1)
    const ro = await account.toReadOnlyAccount()
    await expect(ro.getConsignmentVersion()).resolves.toBe('v1')
    await expect(account.setConsignmentVersion('v2')).rejects.toThrow(/v0.*v1/)

    expect(() => new WalletManagerRgb(SEED, { consignmentVersion: 'v9' }))
      .toThrow(/consignmentVersion/)
  })

  test('unified sendBegin routes 1.0 invoices with pk + senderTransportEndpoint and rejects malformed pk', async () => {
    const calls = []
    const makeEngine = (invoiceObj) => {
      const engine = new Engine({
        WasmInvoice: class {
          invoiceData () {
            return invoiceObj
          }
        }
      }, {
        network: 'Signet',
        proxyUrl: 'rpcs://proxy.example.org/v1/json-rpc',
        fallbackProxyUrls: ['rpcs://proxy.example.org/json-rpc'],
        minConfirmations: 1,
        slots: SLOTS,
        fee: {}
      })
      engine._online = { id: 1 }
      engine._wallet = {
        sync: async () => {},
        sendBegin: async (...args) => {
          calls.push(args)
          return args.length > 5 ? { psbt: PSBT, batchTransferIdx: 7 } : PSBT
        },
        signPsbt: async () => 'signed-psbt',
        sendEnd: async () => ({ txid: 'tx1', batchTransferIdx: 7 }),
        listTransfers: async () => [],
        flush: async () => {}
      }
      return engine
    }

    const v1Engine = makeEngine({
      recipientId: 'tb:utxob:v1',
      assetId: USDT_CONTRACT_ID,
      network: 'Signet',
      publicKey: VALID_PK,
      encryption: 'Required',
      expirationTimestamp: 1900000000,
      transportEndpoints: ['rpcs://proxy.example.org/v1/json-rpc', 'rpcs://proxy.example.org/json-rpc']
    })
    const v1Transfer = await v1Engine.sendAsset({
      invoice: `${USDT_CONTRACT_ID}/utxob:v1?pk=${VALID_PK}`,
      assetId: USDT_CONTRACT_ID,
      amount: 1000000n,
      feeRate: 2
    })
    expect(v1Transfer).toEqual({ txid: 'tx1', batchTransferIdx: 7 })
    expect(calls[0]).toHaveLength(9)
    expect(calls[0][2]).toBe(false)
    expect(calls[0][6]).toBe('rpcs://proxy.example.org/v1/json-rpc')
    expect(calls[0][1][USDT_CONTRACT_ID][0]).toMatchObject({
      recipientId: 'tb:utxob:v1',
      publicKey: VALID_PK,
      encryption: 'Required',
      expirationTimestamp: 1900000000
    })

    // Malformed pk in query string or invoice data fails immediately without calling sendBegin
    calls.length = 0
    const badEngine = makeEngine({
      recipientId: 'tb:utxob:bad',
      assetId: USDT_CONTRACT_ID,
      network: 'Signet',
      transportEndpoints: ['rpcs://proxy.example.org/v1/json-rpc', 'rpcs://proxy.example.org/json-rpc']
    })
    await expect(badEngine.sendAsset({
      invoice: `${USDT_CONTRACT_ID}/utxob:bad?pk=not_hex_64`,
      assetId: USDT_CONTRACT_ID,
      amount: 100,
      feeRate: 2
    })).rejects.toThrow(/InvalidPubkey/)
    expect(calls).toHaveLength(0)
  })

  test('listAssets and activity include BFA bridged assets alongside NIA/IFA/UDA/CFA', async () => {
    const engine = new Engine({}, {
      network: 'Signet',
      slots: SLOTS,
      fee: {}
    })
    engine._transferArgument = 'assetId'
    engine._wallet = {
      listAssets: async () => ({
        nia: [{ assetId: 'rgb:nia1', ticker: 'NIA', name: 'Nia', precision: 0, balance: { settled: '10' } }],
        bfa: [{
          assetId: USDT_CONTRACT_ID,
          ticker: 'USDT',
          name: 'Tether USD',
          precision: 6,
          balance: { settled: '5000000' },
          bridgeChainId: 42161,
          bridgeContract: '0x763601d961a17eb4cd6afac496cc27b63b0e1aef'
        }]
      }),
      getAssetMetadata: async () => ({ precision: 6 }),
      listTransfers: async (id) => (id === USDT_CONTRACT_ID ? [{ batchTransferIdx: 3, idx: 3, kind: 'ReceiveBlind', status: 'Settled' }] : []),
      listTransactions: async () => []
    }

    const assets = await engine.listAssets()
    expect(assets).toHaveLength(2)
    expect(assets[1]).toMatchObject({
      assetId: USDT_CONTRACT_ID,
      ticker: 'USDT',
      precision: 6,
      bridgeChainId: 42161,
      bridgeContract: '0x763601d961a17eb4cd6afac496cc27b63b0e1aef'
    })

    const act = await engine.activity()
    expect(act.transfers).toEqual([
      { batchTransferIdx: 3, idx: 3, kind: 'ReceiveBlind', status: 'Settled', assetId: USDT_CONTRACT_ID }
    ])
  })

  test('activity includes 0-balance ContractId receive transfers before contract import', async () => {
    const engine = new Engine({}, {
      network: 'Signet',
      slots: SLOTS,
      fee: {}
    })
    const zeroBalTransfer = {
      batchTransferIdx: 9,
      idx: 9,
      kind: 'ReceiveBlind',
      status: 'WaitingCounterparty',
      recipientId: 'tb:utxob:zero',
      invoiceString: `${USDT_CONTRACT_ID}/utxob:zero?pk=${VALID_PK}`
    }
    engine._wallet = {
      listAssets: async () => ({ nia: [], bfa: [] }),
      listTransfers: async (filter) => {
        if (filter === 'any') return [zeroBalTransfer]
        if (filter === 'noAsset') return []
        return []
      },
      listTransactions: async () => []
    }

    const act = await engine.activity()
    expect(act.transfers).toEqual([
      { ...zeroBalTransfer, assetId: USDT_CONTRACT_ID }
    ])
  })
})
