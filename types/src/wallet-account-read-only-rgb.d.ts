/**
 * The reads of an RGB account, with nothing that signs. This is the view the WDK's policy
 * engine hands to a condition, so it must not expose a way to move anything.
 *
 * Where the WDK's vocabulary and RGB's differ, the WDK's wins and the RGB term is given in
 * the parameter's documentation: a "token" is an RGB asset id, and a transfer's "hash" is
 * the txid of the witness transaction.
 */
export default class WalletAccountReadOnlyRgb {
    /**
     * @param {import('./engine.js').default} engine - The engine to read through.
     */
    constructor(engine: import("./engine.js").default);
    /** @protected */
    protected _engine: import("./engine.js").default;
    /** @returns {Promise<string>} The wallet's Bitcoin address. */
    getAddress(): Promise<string>;
    /**
     * The spendable Bitcoin balance, in sats.
     *
     * This is the vanilla balance: what a plain Bitcoin send may spend. The sats parked in the
     * UTXOs that carry assets are not here, because they are not free to spend — they pay the
     * fees of the transfers that move those assets. {@link getBtcBalance} returns both.
     *
     * @returns {Promise<bigint>} The balance in sats.
     */
    getBalance(): Promise<bigint>;
    /**
     * The full Bitcoin balance, vanilla and colored, settled and spendable.
     *
     * @returns {Promise<Object>} The balance.
     */
    getBtcBalance(): Promise<any>;
    /**
     * The balance of one RGB asset.
     *
     * @param {string} tokenAddress - The RGB asset id.
     * @returns {Promise<bigint>} The settled balance, in the asset's own base units.
     */
    getTokenBalance(tokenAddress: string): Promise<bigint>;
    /**
     * The balance of one RGB asset, settled, future and spendable.
     *
     * @param {string} assetId - The RGB asset id.
     * @returns {Promise<Object>} The balance.
     */
    getAssetBalance(assetId: string): Promise<any>;
    /**
     * The RGB assets this wallet holds, with the precision taken from contract metadata where
     * the list itself does not carry it.
     *
     * @returns {Promise<Array<Object>>} The assets.
     */
    listAssets(): Promise<Array<any>>;
    /**
     * The transfers, newest first, with a confirmation count on the ones still waiting.
     *
     * @param {string} [assetId] - Restrict to one asset; every transfer when omitted.
     * @returns {Promise<Array<Object>>} The transfers.
     */
    listTransfers(assetId?: string): Promise<Array<any>>;
    /**
     * The transfer a witness transaction produced.
     *
     * @param {string} hash - The txid.
     * @returns {Promise<Object | null>} The transfer, or null when this wallet has none.
     */
    getTransactionReceipt(hash: string): Promise<any | null>;
    /**
     * What a Bitcoin send would cost. RGB has no gas: the cost is the miner fee, and the rate
     * is what this wallet would bid now.
     *
     * @returns {Promise<{ fee: bigint }>} The quote.
     */
    quoteSendTransaction(): Promise<{
        fee: bigint;
    }>;
    /**
     * What an asset transfer would cost, as a fee rate in sat/vB. The transaction's size is
     * not known before rgb-lib builds it, so this is the rate, not the total.
     *
     * @returns {Promise<{ fee: bigint }>} The quote.
     */
    quoteTransfer(): Promise<{
        fee: bigint;
    }>;
    /**
     * Free allocation slots. Receiving an asset needs at least one.
     *
     * @returns {Promise<number>} How many allocations can still be received.
     */
    getFreeSlots(): Promise<number>;
    /**
     * What the wallet knows about its own situation: the network it is on, whether the
     * indexer was reachable when it opened and why not if it was not, and whether the browser
     * granted persistent storage.
     *
     * A wallet opens whether or not the indexer answers, so a consumer that does not check
     * this will show stale balances as though they were current.
     *
     * @returns {Promise<{ network: string, online: boolean, onlineError: string | null, persisted: boolean }>} The status.
     */
    getStatus(): Promise<{
        network: string;
        online: boolean;
        onlineError: string | null;
        persisted: boolean;
    }>;
    /**
     * Whether the wallet has changed since its last backup. The recovery phrase alone cannot
     * restore RGB assets: the consignments live only on this device.
     *
     * @returns {Promise<boolean | null>} True when a backup is due, null when unknown.
     */
    isBackupNeeded(): Promise<boolean | null>;
}
