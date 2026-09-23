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

/**
 * How many empty colored UTXOs to keep available, and how many sats each one carries.
 *
 * An RGB send pays its fee only from colored UTXOs, never from the vanilla balance. A slot
 * that cannot pay for being spent at the fee floor makes every send from it fail with
 * "Insufficient allocations", which is why the size is not smaller.
 *
 * @typedef {Object} SlotParameters
 * @property {number} utxoNum - Empty colored UTXOs to keep available.
 * @property {number} utxoSizeSat - Sats parked in each one.
 * @property {number} minSatToPrepare - Absolute floor for creating slots.
 * @property {number} prepareVsize - Rough vsize of a create-slots transaction.
 * @property {number} maxAllocationsPerUtxo - Allocations one colored UTXO can hold.
 * @property {number} sendVsize - Size of a blinded RGB send, in vB, for working out what a slot can pay.
 */

/** @type {SlotParameters} */
export const SLOTS = {
  utxoNum: 3,
  utxoSizeSat: 20000,
  minSatToPrepare: 20000,
  prepareVsize: 350,
  maxAllocationsPerUtxo: 5,
  sendVsize: 154
}

/**
 * The highest fee rate a send can actually pay, in sat/vB.
 *
 * An RGB send pays its fee from the colored UTXOs alone, so the ceiling is not a matter of
 * taste: it is what one slot holds, divided by the size of the transaction. Bidding above it
 * produces a send that rgb-lib rejects for insufficient allocations — with a wallet full of
 * plain bitcoin, which is what makes the failure confusing.
 *
 * @param {SlotParameters} slots - The slot parameters.
 * @returns {number} The ceiling in sat/vB.
 */
export function payableRate (slots = SLOTS) {
  return Math.max(1, Math.floor(slots.utxoSizeSat / slots.sendVsize))
}

/**
 * What creating `count` slots costs at `rate` sat/vB: the sats parked in the slots
 * themselves plus the fee for the transaction that splits them out.
 *
 * @param {number | bigint} rate - The fee rate in sat/vB.
 * @param {number} count - How many slots to create.
 * @param {SlotParameters} slots - The slot parameters.
 * @returns {bigint} The cost in sats.
 */
export function slotCost (rate, count = SLOTS.utxoNum, slots = SLOTS) {
  const need = BigInt(count) * BigInt(slots.utxoSizeSat) +
    BigInt(rate) * BigInt(slots.prepareVsize)
  const floor = BigInt(slots.minSatToPrepare)

  return need > floor ? need : floor
}

/**
 * Reason the wallet must not create slots yet, or null when it may.
 *
 * An unconfirmed input blocks the whole batch, not part of it. rgb-lib's split transaction
 * takes every vanilla input at once and the set cannot be filtered through its API, so one
 * replaceable parent puts every slot in the batch at risk — and an RGB allocation received
 * into a slot that disappears cannot be re-derived from the recovery phrase.
 *
 * @param {{ settled: number | bigint | string, spendable: number | bigint | string }} balance - The vanilla BTC balance.
 * @param {number | bigint} rate - The fee rate in sat/vB.
 * @param {number} count - How many slots are to be created.
 * @param {SlotParameters} slots - The slot parameters.
 * @returns {string | null} The reason, or null.
 */
export function slotBlocker ({ settled, spendable }, rate, count = SLOTS.utxoNum, slots = SLOTS) {
  const confirmed = BigInt(settled)
  const pending = BigInt(spendable) - confirmed

  if (pending > 0n) {
    return `Waiting for ${pending} sats to confirm. Slots are built from every Bitcoin ` +
      'input at once, so one unconfirmed input would put all of them at risk.'
  }

  const cost = slotCost(rate, count, slots)

  if (confirmed < cost) {
    return `Not enough Bitcoin to create slots: needs about ${cost} sats at ${rate} sat/vB, ` +
      `the wallet has ${confirmed}. Fund its Bitcoin address.`
  }

  return null
}

/**
 * Empty colored UTXOs large enough to pay for being spent: colorable, broadcast, no
 * allocations, no pending blind receive, and at least `utxoSizeSat` in them.
 *
 * When the UTXO holding an asset cannot cover the fee, rgb-lib adds empty colored UTXOs as
 * inputs, largest first. Slots that are empty but small add almost nothing at a normal fee
 * rate, so they do not count here.
 *
 * @param {Array<Object>} unspents - The unspents, from `listUnspents`.
 * @param {SlotParameters} slots - The slot parameters.
 * @returns {number} How many usable empty slots exist.
 */
export function usableEmptySlots (unspents, slots = SLOTS) {
  return (unspents || []).filter((u) =>
    u.utxo?.colorable &&
    u.utxo.exists !== false &&
    (u.rgbAllocations || []).length === 0 &&
    Number(u.pendingBlinded || 0) === 0 &&
    BigInt(String(u.utxo.btcAmount ?? 0)) >= BigInt(slots.utxoSizeSat)
  ).length
}

/**
 * How many slots to create so that `utxoNum` usable empty ones exist.
 *
 * Counting spare room on UTXOs that already hold assets would report slots as available
 * while every send from those UTXOs fails on fees.
 *
 * @param {Array<Object>} unspents - The unspents, from `listUnspents`.
 * @param {SlotParameters} slots - The slot parameters.
 * @returns {number} How many slots to create.
 */
export function slotsToCreate (unspents, slots = SLOTS) {
  return Math.max(0, slots.utxoNum - usableEmptySlots(unspents, slots))
}

/**
 * Free allocation slots across the wallet's colored UTXOs.
 *
 * @param {Array<Object>} unspents - The unspents, from `listUnspents`.
 * @param {SlotParameters} slots - The slot parameters.
 * @returns {number} How many allocations can still be received.
 */
export function freeSlots (unspents, slots = SLOTS) {
  return (unspents || [])
    .filter((u) => u.utxo?.colorable)
    .reduce((a, u) => a + Math.max(0, slots.maxAllocationsPerUtxo - u.rgbAllocations.length), 0)
}

/**
 * Turns rgb-lib's "Insufficient allocations" on a send into what it means for this wallet;
 * any other message passes through unchanged.
 *
 * rgb-lib raises it when the colored inputs cannot pay the fee and no empty colored UTXO is
 * left to add, as long as the vanilla balance is above 2000 sats. A wallet full of plain
 * bitcoin therefore sees a message about allocations when the shortfall is sats in its slots.
 *
 * @param {unknown} message - The error message from rgb-lib.
 * @param {number | bigint} rate - The fee rate the send was attempted at.
 * @returns {string} The message to show.
 */
export function explainSendError (message, rate) {
  const text = String(message ?? '')

  if (!/insufficient allocations/i.test(text)) return text

  return `The UTXOs holding this asset cannot pay the fee at ${rate} sat/vB, and no empty ` +
    'slot is left to add. Create slots before sending, or lower the fee rate.'
}
