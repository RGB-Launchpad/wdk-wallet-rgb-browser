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

/** @typedef {import('./src/wallet-manager-rgb.js').RgbWalletConfig} RgbWalletConfig */
/** @typedef {import('./src/fee.js').FeeParameters} FeeParameters */
/** @typedef {import('./src/slots.js').SlotParameters} SlotParameters */

export { default } from './src/wallet-manager-rgb.js'

export { default as WalletAccountRgb } from './src/wallet-account-rgb.js'

export { default as WalletAccountReadOnlyRgb } from './src/wallet-account-read-only-rgb.js'

export { MAINNET_FEE, TEST_NETWORK_FEE, bid, clearingRate, feeFor } from './src/fee.js'

export {
  SLOTS,
  explainSendError,
  freeSlots,
  slotBlocker,
  slotCost,
  slotsToCreate,
  usableEmptySlots
} from './src/slots.js'

export {
  BIP322_TAG,
  buildToSignPsbt,
  buildVirtualTxs,
  decodeAddress,
  extractWitness,
  scriptPubKeyOf,
  signatureFromWitness,
  taggedHash
} from './src/bip322.js'

export {
  SNAPSHOT_DB,
  SNAPSHOT_STORE,
  dataDirOf,
  deleteSnapshots,
  isChainMismatch,
  snapshotPrefix
} from './src/snapshots.js'
