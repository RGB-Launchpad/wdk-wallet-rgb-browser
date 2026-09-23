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

// The page half of the live test: it holds the wallets, the driver holds the chain.

import WDK from '@tetherto/wdk'

import WalletManagerRgb from '../../index.js'

const wallets = new Map()

// Results cross to the driver through structured cloning, which has no BigInt on the other
// side of page.evaluate's JSON boundary.
const plain = (value) => {
  const json = JSON.stringify(value, (_k, v) => (typeof v === 'bigint' ? v.toString() : v))

  // A method that returns nothing serialises to nothing, which JSON.parse will not take.
  return json === undefined ? null : JSON.parse(json)
}

globalThis.rgb = {
  /**
   * Opens a wallet on a fresh recovery phrase. Two wallets can share a page: the snapshot key
   * carries the master fingerprint, so different phrases never collide.
   */
  async open (name, config) {
    const seedPhrase = WDK.getRandomSeedPhrase(12)
    const wdk = new WDK(seedPhrase).registerWallet('rgb', WalletManagerRgb, config)
    const account = await wdk.getAccount('rgb', 0)

    wallets.set(name, { wdk, account })

    return plain({ status: await account.getStatus(), address: await account.getAddress() })
  },

  async call (name, method, ...args) {
    const { account } = wallets.get(name)

    return plain(await account[method](...args))
  }
}
