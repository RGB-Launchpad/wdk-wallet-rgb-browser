/**
 * An RGB account, backed by rgb-lib's WebAssembly bindings and the snapshot they keep in
 * IndexedDB.
 *
 * Two things read differently here than on an account-based chain. A recipient is an RGB
 * invoice rather than an address, because the receiver has to say which UTXO the asset lands
 * on. And a transfer is not complete when the transaction confirms: the consignment has to
 * reach the recipient through a proxy and be validated there. `listTransfers` shows that
 * state; `refresh` advances it.
 */
export default class WalletAccountRgb extends WalletAccountReadOnlyRgb {
    /** Elided by tsc's JS declaration emit (identical to the base's). */
    getAddress(): Promise<string>;

    /** Elided by tsc's JS declaration emit (identical to the base's). */
    getBalance(): Promise<bigint>;

    /** Elided by tsc's JS declaration emit (identical to the base's). */
    getTokenBalance(tokenAddress: string): Promise<bigint>;

    /**
     * @param {import('./engine.js').default} engine - The open engine.
     * @param {number} index - The account index.
     */
    constructor(engine: import("./engine.js").default, index: number);
    /** @private */
    private _index;
    /** @private */
    private _readOnly;
    /** @returns {number} The account index. */
    get index(): number;
    /** @returns {string} The derivation path. */
    get path(): string;
    /**
     * Not available. The recovery phrase stays inside the WebAssembly engine, which signs
     * without handing the key back out; there is nothing to return that would not be a copy
     * of the secret in JavaScript memory.
     *
     * @returns {import('@tetherto/wdk-wallet').KeyPair} Never returns.
     * @throws {UnsupportedOperationError} Always.
     */
    get keyPair(): import("@tetherto/wdk-wallet").KeyPair;
    /**
     * Not available in the WDK's sense: an RGB transfer is not a transaction the caller builds
     * and this wallet signs. The PSBT is built and signed inside {@link transfer} and
     * {@link sendTransaction}, because only rgb-lib knows which colored UTXOs go into it.
     *
     * @returns {Promise<unknown>} Never returns.
     * @throws {UnsupportedOperationError} Always.
     */
    signTransaction(): Promise<unknown>;
    /**
     * Not available: message signing here is BIP-322 over a taproot key, and verifying it needs
     * a Schnorr check that the WebAssembly bindings do not expose. The base class would throw
     * the same error with a less specific reason.
     *
     * @returns {Promise<boolean>} Never returns.
     * @throws {UnsupportedOperationError} Always.
     */
    verify(): Promise<boolean>;
    /**
     * Sends plain Bitcoin. Spends the vanilla keychain only, never a UTXO carrying an asset.
     *
     * @param {Object} tx - The transaction.
     * @param {string} tx.to - The destination address.
     * @param {number | bigint | string} tx.value - The amount in sats.
     * @param {number | bigint} [tx.feeRate] - The fee rate in sat/vB; estimated when omitted.
     * @returns {Promise<{ hash: string, fee: bigint }>} The transaction id and the rate it paid.
     */
    sendTransaction(tx: {
        to: string;
        value: number | bigint | string;
        feeRate?: number | bigint;
    }): Promise<{
        hash: string;
        fee: bigint;
    }>;
    /**
     * Transfers an RGB asset.
     *
     * 🚨 Nothing goes on the chain here. The consignment is posted for the recipient, who
     * validates it and acknowledges; the transaction is broadcast by a later {@link refresh},
     * once that acknowledgement has arrived. `hash` names a transaction that is not yet on the
     * network, and a wallet that sends and never refreshes again has not sent anything. See
     * {@link pendingHandovers}.
     *
     * `recipient` is an RGB invoice, not an address: the receiver decides which UTXO the asset
     * lands on, and the invoice is how they say so. It also names where the consignment is to
     * be delivered, and that endpoint takes precedence over the configured proxy.
     *
     * @param {Object} options - The transfer.
     * @param {string} options.token - The RGB asset id.
     * @param {string} options.recipient - The recipient's RGB invoice.
     * @param {number | bigint | string} options.amount - The amount, in the asset's base units.
     * @param {number | bigint} [options.feeRate] - The fee rate in sat/vB; estimated when omitted.
     * @returns {Promise<{ hash: string, fee: bigint, transfer: Object }>} The result.
     */
    transfer(options: {
        token: string;
        recipient: string;
        amount: number | bigint | string;
        feeRate?: number | bigint;
    }): Promise<{
        hash: string;
        fee: bigint;
        transfer: any;
    }>;
    /**
     * The transfers this wallet has sent that are still waiting on their recipient.
     *
     * See {@link transfer}: a send is not on the chain until the recipient has acknowledged
     * the consignment and this wallet has refreshed. A consumer that wants sends to complete
     * without the user thinking about it refreshes while this is not empty.
     *
     * @returns {Promise<Array<Object>>} The outgoing transfers still waiting.
     */
    pendingHandovers(): Promise<Array<any>>;
    /**
     * Creates an invoice to receive an asset into a blinded UTXO, which tells the sender
     * nothing about this wallet beyond the identifier itself.
     *
     * @param {Object} [options] - The invoice.
     * @param {string} [options.assetId] - Restrict the invoice to one asset; any asset when omitted.
     * @param {number} [options.minutes] - How long the invoice stays valid.
     * @returns {Promise<Object>} The invoice, its recipient id and its expiry.
     */
    receiveAsset(options?: {
        assetId?: string;
        minutes?: number;
    }): Promise<any>;
    /**
     * Creates an address to receive an asset through a witness transaction, which needs no
     * free allocation slot: the sender creates the output the asset lands on, and pays for it.
     *
     * @param {Object} [options] - The invoice.
     * @param {string} [options.assetId] - Restrict the invoice to one asset; any asset when omitted.
     * @param {number} [options.minutes] - How long the invoice stays valid.
     * @returns {Promise<Object>} The invoice.
     */
    receiveAssetToWitness(options?: {
        assetId?: string;
        minutes?: number;
    }): Promise<any>;
    /**
     * Issues a new asset, with the whole supply allocated to this wallet.
     *
     * @param {Object} options - The asset. See the engine's `issueAsset` for the fields.
     * @returns {Promise<Object>} The issued asset.
     */
    issueAsset(options: any): Promise<any>;
    /**
     * Signs a message as a BIP-322 simple signature, with the wallet's own address.
     *
     * @param {string} message - The message, signed verbatim.
     * @returns {Promise<string>} The signature, base64 encoded.
     */
    sign(message: string): Promise<string>;
    /**
     * The address a signature from {@link sign} is checked against, and the signature itself.
     *
     * @param {string} message - The message.
     * @returns {Promise<{ address: string, signature: string }>} Both halves.
     */
    signMessage(message: string): Promise<{
        address: string;
        signature: string;
    }>;
    /**
     * Creates the empty colored UTXOs that receiving requires. Receiving with no free slot
     * fails, and slots take a confirmed on-chain transaction to make.
     *
     * @param {number | bigint} [feeRate] - The fee rate in sat/vB; estimated when omitted.
     * @returns {Promise<{ created: number, slots: number }>} What was created.
     */
    createUtxos(feeRate?: number | bigint): Promise<{
        created: number;
        slots: number;
    }>;
    /**
     * Brings the wallet's view of the chain up to date without touching RGB state. Cheap, and
     * what a balance reads after if it is to be current.
     *
     * @returns {Promise<void>} When the wallet is in step with the chain.
     */
    sync(): Promise<void>;
    /**
     * Picks up consignments and advances the transfers waiting on them. This is the step that
     * turns a transfer someone sent into an asset this wallet holds.
     *
     * @returns {Promise<Object>} What changed.
     */
    refresh(assetId: any): Promise<any>;
    /**
     * Fails the expired invoices and deletes the ones that never received anything, which
     * releases the allocation slots they were holding.
     *
     * @returns {Promise<Object>} What was released.
     */
    cleanup(): Promise<any>;
    /**
     * An encrypted backup of the whole wallet, including the consignments. The recovery phrase
     * alone cannot restore RGB assets.
     *
     * @param {string} password - The password to encrypt with.
     * @returns {Promise<Uint8Array>} The backup.
     */
    createBackup(password: string): Promise<Uint8Array>;
    /**
     * Restores a backup over this wallet. The recovery phrase must be the same one.
     *
     * @param {Uint8Array} bytes - The backup.
     * @param {string} password - The password it was encrypted with.
     * @returns {Promise<void>} When the backup is restored.
     */
    restoreBackup(bytes: Uint8Array, password: string): Promise<void>;
    /**
     * Runs a task against the rgb-lib wallet directly, in the same queue everything else uses.
     *
     * This is the escape hatch for capabilities this module does not wrap: a consumer that
     * ships its own build of the bindings, with methods upstream does not have, reaches them
     * here. The queue is the part that matters — every binding takes a mutable borrow for the
     * whole call, so a task that runs outside it can panic the engine mid-sync and leave it
     * unusable.
     *
     * The `online` handle is null when the wallet opened with no indexer; a task that needs
     * the chain must say so itself.
     *
     * @template T
     * @param {(wallet: Object, online: Object | null) => Promise<T> | T} task - The task.
     * @returns {Promise<T>} What it returned.
     */
    runExclusive<T>(task: (wallet: any, online: any | null) => Promise<T> | T): Promise<T>;
    /**
     * The rgb-lib wallet this account is built on.
     *
     * Prefer {@link runExclusive}: a call made on this object directly does not go through the
     * queue, and two of those at once panic the engine.
     *
     * @returns {Object} The wallet.
     */
    getRgbWallet(): any;
    /** @returns {Promise<WalletAccountReadOnlyRgb>} A read-only view of this account. */
    toReadOnlyAccount(): Promise<WalletAccountReadOnlyRgb>;
    /** Closes the wallet and drops the engine's handle on the recovery phrase. */
    dispose(): void;
}
import WalletAccountReadOnlyRgb from './wallet-account-read-only-rgb.js';
