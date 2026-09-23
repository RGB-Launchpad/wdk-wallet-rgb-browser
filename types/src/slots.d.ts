/**
 * What creating `count` slots costs at `rate` sat/vB: the sats parked in the slots
 * themselves plus the fee for the transaction that splits them out.
 *
 * @param {number | bigint} rate - The fee rate in sat/vB.
 * @param {number} count - How many slots to create.
 * @param {SlotParameters} slots - The slot parameters.
 * @returns {bigint} The cost in sats.
 */
export function slotCost(rate: number | bigint, count?: number, slots?: SlotParameters): bigint;
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
export function slotBlocker({ settled, spendable }: {
    settled: number | bigint | string;
    spendable: number | bigint | string;
}, rate: number | bigint, count?: number, slots?: SlotParameters): string | null;
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
export function usableEmptySlots(unspents: Array<any>, slots?: SlotParameters): number;
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
export function slotsToCreate(unspents: Array<any>, slots?: SlotParameters): number;
/**
 * Free allocation slots across the wallet's colored UTXOs.
 *
 * @param {Array<Object>} unspents - The unspents, from `listUnspents`.
 * @param {SlotParameters} slots - The slot parameters.
 * @returns {number} How many allocations can still be received.
 */
export function freeSlots(unspents: Array<any>, slots?: SlotParameters): number;
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
export function explainSendError(message: unknown, rate: number | bigint): string;
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
 */
/** @type {SlotParameters} */
export const SLOTS: SlotParameters;
/**
 * How many empty colored UTXOs to keep available, and how many sats each one carries.
 *
 * An RGB send pays its fee only from colored UTXOs, never from the vanilla balance. A slot
 * that cannot pay for being spent at the fee floor makes every send from it fail with
 * "Insufficient allocations", which is why the size is not smaller.
 */
export type SlotParameters = {
    /**
     * - Empty colored UTXOs to keep available.
     */
    utxoNum: number;
    /**
     * - Sats parked in each one.
     */
    utxoSizeSat: number;
    /**
     * - Absolute floor for creating slots.
     */
    minSatToPrepare: number;
    /**
     * - Rough vsize of a create-slots transaction.
     */
    prepareVsize: number;
    /**
     * - Allocations one colored UTXO can hold.
     */
    maxAllocationsPerUtxo: number;
};
