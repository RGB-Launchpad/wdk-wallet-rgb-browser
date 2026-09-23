// Copyright 2026 RGB Launchpad
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

'use strict'

import WDK from '@tetherto/wdk'

import WalletManagerRgb from '../../index.js'

/**
 * Opens an RGB wallet in the browser through a WDK instance and reports what it can see.
 *
 * The indexer is allowed to be unreachable: the wallet still opens, and the address, the
 * asset list and a backup all come from the snapshot in IndexedDB. Only the calls that need
 * the chain fail, and they say so.
 *
 * @param {Object} [config] - Overrides for the wallet configuration.
 * @returns {Promise<Record<string, unknown>>} What each step produced.
 */
export async function runRgbExample (config = {}) {
  const seedPhrase = WDK.getRandomSeedPhrase(12)

  const wdk = new WDK(seedPhrase).registerWallet('rgb', WalletManagerRgb, {
    network: 'Signet',
    ...config
  })

  const account = await wdk.getAccount('rgb', 0)

  const address = await account.getAddress()
  const balance = await account.getBtcBalance()
  const assets = await account.listAssets()
  const transfers = await account.listTransfers()
  const slots = await account.getFreeSlots()

  // Signing needs the wallet, not the chain, so it works with no indexer.
  const signed = await account.signMessage('Hello World')

  const failures = {}

  for (const [name, attempt] of [
    ['receive', () => account.receiveAsset()],
    ['witnessReceive', () => account.receiveAssetToWitness()],
    ['issue', () => account.issueAsset({
      ticker: 'DEMO', name: 'Demo asset', precision: 0, amounts: [1000]
    })]
  ]) {
    try {
      await attempt()
      failures[name] = null
    } catch (error) {
      failures[name] = error.message
    }
  }

  wdk.dispose()

  return {
    address,
    addressIsTaproot: address.startsWith('tb1p'),
    vanillaSettled: String(balance.vanilla.settled),
    assets: assets.length,
    transfers: transfers.length,
    slots,
    signedBy: signed.address,
    signature: signed.signature,
    failures
  }
}

/* global document, location */

// One run per page load, whoever is watching. A second run would open a second wallet over
// the same snapshot, which is a race worth not writing into an example.
const esploraUrl = new URLSearchParams(location.search).get('esplora')

globalThis.rgbExample = runRgbExample(esploraUrl ? { esploraUrl } : {})

globalThis.rgbExample
  .then((result) => {
    document.querySelector('#output').textContent = JSON.stringify(result, null, 2)
  })
  .catch((error) => {
    document.querySelector('#output').textContent = `Failed: ${error.message}`
  })
