/**
 * The wallet as rgb-lib sees it, plus everything a browser needs around it: one command at
 * a time, the snapshot key the network demands, and the reads that go to the indexer rather
 * than to the engine.
 *
 * The accounts are thin wrappers over this. It is not exported from the package: consumers
 * hold an account, not an engine.
 */
export default class Engine {
    /**
     * @param {Object} bindings - The rgb-lib WebAssembly bindings module.
     * @param {Object} config - The resolved wallet configuration.
     */
    constructor(bindings: any, config: any);
    /** @private */
    private _bindings;
    /** @private */
    private _config;
    /** @private */
    private _queue;
    /** @private */
    private _wallet;
    /** @private */
    private _online;
    /** @private */
    private _onlineError;
    /** @private */
    private _persisted;
    /** @private */
    private _transferArgument;
    /** @returns {Object} The rgb-lib wallet. */
    get wallet(): any;
    /** @returns {string} The derivation path this account reports. */
    get path(): string;
    /** @returns {string} The Bitcoin network. */
    get network(): string;
    /** @returns {boolean} Whether the indexer was reachable when the wallet opened. */
    get online(): boolean;
    /** @returns {string | null} Why going online failed, when it did. */
    get onlineError(): string | null;
    /**
     * Whether the browser granted persistent storage. Without it the snapshot — and with it
     * the consignments that are the assets — can be evicted under storage pressure, and the
     * recovery phrase alone cannot bring them back.
     *
     * @returns {boolean} True when storage is persistent.
     */
    get persisted(): boolean;
    /**
     * Runs one engine command, alone.
     *
     * @template T
     * @param {() => Promise<T> | T} task - The command.
     * @returns {Promise<T>} What it returned.
     */
    run<T>(task: () => Promise<T> | T): Promise<T>;
    /**
     * Converts BigInt to string, so a result can cross a structured-clone boundary such as a
     * worker or an extension message channel.
     *
     * @param {unknown} value - The value.
     * @returns {unknown} The converted value.
     */
    plain(value: unknown): unknown;
    /**
     * Opens the wallet: initialises the WebAssembly module, restores the keys, builds the
     * rgb-lib wallet on its IndexedDB snapshot and tries to reach the indexer.
     *
     * Going online is allowed to fail. Balances, the asset list and a backup all work from the
     * snapshot, and a wallet that refuses to open because someone else's server is down is
     * worse than one that opens read-only.
     *
     * @param {string} mnemonic - The BIP-39 recovery phrase.
     * @returns {Promise<void>} When the wallet is open.
     */
    open(mnemonic: string): Promise<void>;
    /**
     * The indexer handle, for the calls that need one.
     *
     * @returns {Object} The handle.
     * @throws {Error} If the indexer could not be reached.
     */
    needOnline(): any;
    /**
     * The asset list, with the precision taken from contract metadata where the list itself
     * does not carry it.
     *
     * @returns {Promise<Array<Object>>} The assets.
     */
    listAssets(): Promise<Array<any>>;
    /**
     * The transfers, newest first, with a confirmation count on the ones still waiting.
     *
     * @param {string} [assetId] - Restrict to one asset.
     * @returns {Promise<Array<Object>>} The transfers.
     */
    listTransfers(assetId?: string): Promise<Array<any>>;
    /**
     * Free allocation slots. Receiving needs at least one.
     *
     * @returns {Promise<number>} How many allocations can still be received.
     */
    freeSlots(): Promise<number>;
    /**
     * What to bid, in sat/vB, from the mempool's own queue and the indexer's estimate.
     *
     * @returns {Promise<bigint>} The rate.
     */
    feeRate(): Promise<bigint>;
    /**
     * Creates the empty colored UTXOs that receiving requires.
     *
     * @param {number | bigint} [feeRate] - The fee rate; estimated when omitted.
     * @returns {Promise<{ created: number, slots: number }>} What was created.
     */
    createUtxos(feeRate?: number | bigint): Promise<{
        created: number;
        slots: number;
    }>;
    /**
     * Creates an invoice to receive an asset into a blinded UTXO.
     *
     * A proxy is required: the invoice has to name where the sender delivers the consignment,
     * and without one the sender has nowhere to put it.
     *
     * @param {Object} [options] - The invoice.
     * @param {string} [options.assetId] - Restrict to one asset; any asset when omitted.
     * @param {number} [options.minutes] - How long the invoice stays valid.
     * @returns {Promise<Object>} The invoice.
     */
    blindReceive({ assetId, minutes }?: {
        assetId?: string;
        minutes?: number;
    }): Promise<any>;
    /**
     * Creates an address to receive an asset through a witness transaction, which needs no
     * free allocation slot: the sender creates the output that carries the asset.
     *
     * The sender pays for that output, so a witness receive costs the sender more than a blind
     * one. It is what a wallet with no slots can still do.
     *
     * @param {Object} [options] - The invoice.
     * @param {string} [options.assetId] - Restrict to one asset; any asset when omitted.
     * @param {number} [options.minutes] - How long the invoice stays valid.
     * @returns {Promise<Object>} The invoice.
     */
    witnessReceive({ assetId, minutes }?: {
        assetId?: string;
        minutes?: number;
    }): Promise<any>;
    /**
     * Issues a new asset. The whole supply is allocated to this wallet, spread over the
     * amounts given, and each amount takes an allocation slot.
     *
     * @param {Object} options - The asset.
     * @param {string} options.ticker - The ticker.
     * @param {string} options.name - The name.
     * @param {number} options.precision - Decimal places.
     * @param {Array<number | bigint | string>} options.amounts - The issued amounts, one per allocation.
     * @param {'Nia' | 'Ifa'} [options.schema] - `Nia` is fixed supply, `Ifa` can be inflated later. Defaults to `Nia`.
     * @param {Array<number | bigint | string>} [options.inflationAmounts] - Inflation allowances, for `Ifa` only.
     * @param {string} [options.rejectListUrl] - Reject list, for `Ifa` only.
     * @returns {Promise<Object>} The issued asset.
     */
    issueAsset(options: {
        ticker: string;
        name: string;
        precision: number;
        amounts: Array<number | bigint | string>;
        schema?: "Nia" | "Ifa";
        inflationAmounts?: Array<number | bigint | string>;
        rejectListUrl?: string;
    }): Promise<any>;
    /**
     * Signs a message with the wallet's own address, as a BIP-322 simple signature.
     *
     * rgb-lib exposes no message signing, so the message is wrapped in the pair of virtual
     * transactions BIP-322 defines and the wallet signs that PSBT. The signature is the
     * resulting witness stack.
     *
     * @param {string} message - The message, signed verbatim.
     * @returns {Promise<{ address: string, signature: string }>} The address and the signature.
     */
    signMessage(message: string): Promise<{
        address: string;
        signature: string;
    }>;
    /**
     * Picks up consignments and advances the transfer state machine. The cost grows with the
     * transfer history, because every consignment is validated on the device.
     *
     * @param {string} [assetId] - Restrict to one asset.
     * @returns {Promise<Object>} What changed.
     */
    refresh(assetId?: string): Promise<any>;
    /**
     * Fails the expired invoices and deletes the ones that never received anything, which
     * releases the allocation slots they were holding.
     *
     * The sweep only reaches transfers that are waiting for the counterparty and have expired.
     * A dangling invoice holds its slot until then.
     *
     * @returns {Promise<Object>} What was released.
     */
    cleanup(): Promise<any>;
    /**
     * An encrypted backup of the whole wallet. The recovery phrase alone cannot restore RGB
     * assets: the consignments are held only here.
     *
     * @param {string} password - The password to encrypt with.
     * @returns {Promise<Uint8Array>} The backup.
     */
    backup(password: string): Promise<Uint8Array>;
    /**
     * Restores a backup over this wallet.
     *
     * @param {Uint8Array} bytes - The backup.
     * @param {string} password - The password it was encrypted with.
     * @returns {Promise<void>} When the backup is restored.
     */
    restoreBackup(bytes: Uint8Array, password: string): Promise<void>;
    /**
     * Sends an asset to an invoice.
     *
     * The invoice's own transport endpoints take precedence over the configured one: the
     * consignment has to land where the recipient looks for it.
     *
     * @param {Object} options - The send.
     * @param {string} options.invoice - The RGB invoice.
     * @param {string} [options.assetId] - The asset; taken from the invoice when omitted.
     * @param {bigint | number | string} options.amount - The amount, in the asset's own precision.
     * @param {number | bigint} [options.feeRate] - The fee rate; estimated when omitted.
     * @returns {Promise<Object>} The transfer rgb-lib recorded.
     */
    sendAsset({ invoice, assetId, amount, feeRate }: {
        invoice: string;
        assetId?: string;
        amount: bigint | number | string;
        feeRate?: number | bigint;
    }): Promise<any>;
    /**
     * Sends plain Bitcoin. Spends the vanilla keychain only, never a UTXO carrying assets.
     *
     * @param {Object} options - The send.
     * @param {string} options.address - The destination address.
     * @param {bigint | number | string} options.amount - The amount in sats.
     * @param {number | bigint} [options.feeRate] - The fee rate; estimated when omitted.
     * @returns {Promise<{ txid: string }>} The transaction id.
     */
    sendBtc({ address, amount, feeRate }: {
        address: string;
        amount: bigint | number | string;
        feeRate?: number | bigint;
    }): Promise<{
        txid: string;
    }>;
    /** Closes the wallet. */
    dispose(): void;
    /**
     * rgb-lib changed what this argument is. The published WebAssembly bindings take an asset
     * id; builds from a later commit take an AssetFilter, whose variants are lowercase —
     * "any", "noAsset" or `{ id }`. Both are in circulation, and a consumer may inject either,
     * so the first call settles which one this build wants and the answer is kept.
     *
     * @private
     * @param {string} [assetId] - The asset to restrict to.
     * @returns {Array<Object>} The transfers, as rgb-lib returns them.
     */
    private _listTransfers;
    /**
     * The asset-id form of `listTransfers`, including the case the argument cannot express.
     *
     * Passing no asset id does not mean "every transfer": it returns only the transfers that
     * belong to no asset, which on a wallet holding assets is an empty list. Asking for
     * everything therefore means asking once per asset and adding the assetless ones.
     *
     * @private
     * @param {string} [assetId] - The asset to restrict to.
     * @returns {Array<Object>} The transfers.
     */
    private _listTransfersByAsset;
    /**
     * @private
     * @returns {Promise<boolean>} Whether storage is persistent.
     */
    private _requestPersistence;
    /**
     * @private
     * @returns {Promise<Array<[number, number]>>} The mempool histogram.
     */
    private _mempoolHistogram;
    /**
     * Adds a confirmation count to the transfers still waiting on the chain. rgb-lib's
     * transfer carries no such field, so it comes from the indexer: one tip lookup plus one
     * status lookup per pending txid. A lookup that fails leaves the count undefined, which
     * beats failing the whole list because the indexer hiccuped.
     *
     * @private
     * @param {Array<Object>} transfers - The transfers.
     * @returns {Promise<Array<Object>>} The transfers, some with `confirmations`.
     */
    private _withConfirmations;
}
