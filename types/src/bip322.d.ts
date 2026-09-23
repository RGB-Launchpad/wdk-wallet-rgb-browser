/**
 * Decodes a segwit address. Version 0 uses bech32, version 1 and above use bech32m, and the
 * two checksums differ: getting this wrong accepts an address for the wrong version.
 *
 * @param {string} address - The address.
 * @returns {{ hrp: string, version: number, program: Uint8Array }} The decoded address.
 */
export function decodeAddress(address: string): {
    hrp: string;
    version: number;
    program: Uint8Array;
};
/**
 * The scriptPubKey an address pays to.
 *
 * @param {string} address - The address.
 * @returns {Uint8Array} The script.
 */
export function scriptPubKeyOf(address: string): Uint8Array;
/**
 * `tagged_hash(tag, msg) = SHA256(SHA256(tag) || SHA256(tag) || msg)`.
 *
 * @param {string} tag - The tag.
 * @param {Uint8Array} msg - The message bytes.
 * @returns {Promise<Uint8Array>} The hash.
 */
export function taggedHash(tag: string, msg: Uint8Array): Promise<Uint8Array>;
/**
 * Builds the two BIP-322 virtual transactions. The message is hashed verbatim: one extra
 * space is a different signature.
 *
 * @param {string} address - The address that signs.
 * @param {string} message - The message.
 * @returns {Promise<{ toSpend: Uint8Array, toSpendTxid: Uint8Array, toSign: Uint8Array, scriptPubKey: Uint8Array }>} The transactions.
 */
export function buildVirtualTxs(address: string, message: string): Promise<{
    toSpend: Uint8Array;
    toSpendTxid: Uint8Array;
    toSign: Uint8Array;
    scriptPubKey: Uint8Array;
}>;
/**
 * Wraps `to_sign` in a PSBT v0 for the wallet to sign. `witness_utxo` alone is enough;
 * `extra` can carry taproot derivation fields (0x17 internal key, 0x16 tap bip32).
 *
 * @param {string} address - The address that signs.
 * @param {string} message - The message.
 * @param {Array<[Uint8Array, Uint8Array]>} [extra] - Extra input fields.
 * @returns {Promise<string>} The PSBT, base64 encoded.
 */
export function buildToSignPsbt(address: string, message: string, extra?: Array<[Uint8Array, Uint8Array]>): Promise<string>;
/**
 * Reads the final witness (PSBT field 0x08) of input 0 from a signed PSBT.
 *
 * @param {string} psbtB64 - The signed PSBT, base64 encoded.
 * @returns {Uint8Array} The serialised witness stack.
 */
export function extractWitness(psbtB64: string): Uint8Array;
/**
 * A BIP-322 simple signature is the serialised witness stack, base64 encoded.
 *
 * @param {Uint8Array} witnessBytes - The witness stack.
 * @returns {string} The signature.
 */
export function signatureFromWitness(witnessBytes: Uint8Array): string;
export namespace hex {
    function to(b: any): string;
    function from(s: any): Uint8Array<ArrayBuffer>;
}
export namespace b64 {
    export function to_1(b: any): string;
    export { to_1 as to };
    export function from_1(s: any): Uint8Array<ArrayBuffer>;
    export { from_1 as from };
}
/**
 * The BIP-322 tag. A wrong tag changes every message hash, and the signature then verifies
 * nowhere.
 */
export const BIP322_TAG: "BIP0322-signed-message";
