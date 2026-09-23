/**
 * Configuration for an RGB wallet.
 *
 * There is deliberately no default proxy. A proxy relays consignments and therefore sees
 * recipient identifiers, so which one to trust is the consumer's decision, not this
 * package's.
 *
 * @typedef {Object} RgbWalletConfig
 * @property {string} [network] - The Bitcoin network: `Mainnet`, `Signet`, `Testnet4` or `Regtest`. Defaults to `Signet`.
 * @property {string} [esploraUrl] - The Esplora indexer. Defaults to mempool.space's public endpoint for the network; required on Regtest.
 * @property {string} [proxyUrl] - The RGB proxy that carries consignments. Required to receive or to send.
 * @property {Object} [bindings] - The rgb-lib WebAssembly bindings module. Defaults to `@utexo/rgb-lib-wasm`, imported on demand.
 * @property {number} [minConfirmations] - Confirmations an incoming transfer must reach. Defaults to 1.
 * @property {number} [invoiceMinutes] - How long an invoice stays valid. Defaults to 60.
 * @property {import('./fee.js').FeeParameters} [fee] - Fee bidding parameters.
 * @property {import('./slots.js').SlotParameters} [slots] - Allocation slot parameters.
 */
/**
 * A WDK wallet manager for RGB assets on Bitcoin, running in the browser.
 *
 * rgb-lib holds one wallet per recovery phrase and derives its own keychains inside it, so
 * this manager serves a single account, at index 0. Asking for another index is an error
 * rather than a silently different wallet.
 */
export default class WalletManagerRgb extends WalletManager {
    /**
     * @param {string} seedPhrase - The BIP-39 recovery phrase. Raw seed bytes are not enough: rgb-lib derives from the phrase.
     * @param {RgbWalletConfig} [config] - The configuration.
     */
    constructor(seedPhrase: string, config?: RgbWalletConfig);
    /** @private */
    private _mnemonic;
    /** @private */
    private _config;
    /** @private */
    private _bindings;
    /** @private */
    private _engine;
    /** @private */
    private _opening;
    /**
     * The account this wallet holds.
     *
     * @param {number} [index] - The account index. Only 0 exists.
     * @returns {Promise<WalletAccountRgb>} The account.
     * @throws {Error} If an index other than 0 is asked for.
     */
    getAccount(index?: number): Promise<WalletAccountRgb>;
    /**
     * @param {string} path - The derivation path.
     * @returns {Promise<WalletAccountRgb>} The account at that path.
     * @throws {Error} If the path is not this wallet's.
     */
    getAccountByPath(path: string): Promise<WalletAccountRgb>;
    /**
     * Opens the engine once, however many callers ask at the same time.
     *
     * @private
     * @returns {Promise<Engine>} The open engine.
     */
    private _open;
}
/**
 * Configuration for an RGB wallet.
 *
 * There is deliberately no default proxy. A proxy relays consignments and therefore sees
 * recipient identifiers, so which one to trust is the consumer's decision, not this
 * package's.
 */
export type RgbWalletConfig = {
    /**
     * - The Bitcoin network: `Mainnet`, `Signet`, `Testnet4` or `Regtest`. Defaults to `Signet`.
     */
    network?: string;
    /**
     * - The Esplora indexer. Defaults to mempool.space's public endpoint for the network; required on Regtest.
     */
    esploraUrl?: string;
    /**
     * - The RGB proxy that carries consignments. Required to receive or to send.
     */
    proxyUrl?: string;
    /**
     * - The rgb-lib WebAssembly bindings module. Defaults to `@utexo/rgb-lib-wasm`, imported on demand.
     */
    bindings?: any;
    /**
     * - Confirmations an incoming transfer must reach. Defaults to 1.
     */
    minConfirmations?: number;
    /**
     * - How long an invoice stays valid. Defaults to 60.
     */
    invoiceMinutes?: number;
    /**
     * - Fee bidding parameters.
     */
    fee?: import("./fee.js").FeeParameters;
    /**
     * - Allocation slot parameters.
     */
    slots?: import("./slots.js").SlotParameters;
};
import WalletManager from '@tetherto/wdk-wallet';
import WalletAccountRgb from './wallet-account-rgb.js';
