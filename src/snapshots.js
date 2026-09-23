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

// rgb-lib-wasm keeps one snapshot per wallet in IndexedDB, in database `rgb_lib_wallet`,
// store `snapshots`, keyed by `<dataDir>/<master fingerprint>`. A snapshot holds everything
// the device knows about that wallet on that network: the BDK chain, the RGB stock and the
// consignments it has received. Those consignments *are* the assets: delete them and the
// recovery phrase alone cannot bring them back.

export const SNAPSHOT_DB = 'rgb_lib_wallet'

export const SNAPSHOT_STORE = 'snapshots'

/**
 * The data directory handed to rgb-lib.
 *
 * The network has to be part of it. With a shared key the wallet loads the other chain's
 * snapshot and BDK rejects it.
 *
 * @param {string} network - The Bitcoin network, e.g. `Signet`.
 * @returns {string} The data directory.
 */
export const dataDirOf = (network) => `:memory:/${network}`

/**
 * The prefix every snapshot key of one network starts with.
 *
 * @param {string} network - The Bitcoin network.
 * @returns {string} The prefix.
 */
export const snapshotPrefix = (network) => `${dataDirOf(network)}/`

/**
 * Whether an error means the indexer's chain no longer contains the blocks the wallet
 * remembers, which is what a replaced regtest chain looks like from here.
 *
 * @param {unknown} message - The error message.
 * @returns {boolean} True when the chains cannot be connected.
 */
export const isChainMismatch = (message) =>
  /cannot connect with the original chain/i.test(String(message ?? ''))

/**
 * Deletes the snapshots whose key starts with `prefix`.
 *
 * Nothing may hold the wallet open meanwhile: a running engine writes its snapshot back.
 *
 * @param {string} prefix - The key prefix, from {@link snapshotPrefix}.
 * @returns {Promise<number>} How many snapshots were deleted.
 */
export function deleteSnapshots (prefix) {
  return new Promise((resolve, reject) => {
    let fresh = false
    const open = indexedDB.open(SNAPSHOT_DB)

    // An upgrade here means the database does not exist yet, so there is nothing to delete.
    // Letting it complete would create version 1 without the store, and rgb-lib, opening at
    // that same version, would never add it.
    open.onupgradeneeded = () => {
      fresh = true
      open.transaction.abort()
    }

    open.onerror = () => (fresh ? resolve(0) : reject(open.error))

    open.onsuccess = () => {
      const db = open.result

      if (!db.objectStoreNames.contains(SNAPSHOT_STORE)) {
        db.close()
        resolve(0)
        return
      }

      const tx = db.transaction(SNAPSHOT_STORE, 'readwrite')
      const store = tx.objectStore(SNAPSHOT_STORE)
      const range = IDBKeyRange.bound(prefix, prefix + '￿')
      let n = 0

      const count = store.count(range)
      count.onsuccess = () => {
        n = count.result
        store.delete(range)
      }

      tx.oncomplete = () => {
        db.close()
        resolve(n)
      }

      tx.onerror = tx.onabort = () => {
        db.close()
        reject(tx.error || new Error('Could not delete the local chain data'))
      }
    }
  })
}
