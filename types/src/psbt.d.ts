/**
 * The outputs a PSBT spends, as `{ txid, vout }`, read from its unsigned transaction. A PSBT
 * says which outputs it spends before it is signed, which is what lets a send be checked
 * against what else the wallet has spent since it was prepared.
 *
 * Only version 0 PSBTs carry the unsigned transaction this reads; rgb-lib makes those.
 *
 * @param {string} psbt - The PSBT, base64.
 * @returns {Array<{ txid: string, vout: number }>} Its inputs, in order.
 */
export function psbtInputs(psbt: string): Array<{
    txid: string;
    vout: number;
}>;
