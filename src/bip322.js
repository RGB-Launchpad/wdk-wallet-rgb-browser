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

// The construction side of BIP-322 simple signatures: address decoding, transaction
// serialisation, PSBT v0 encoding and witness extraction. The only cryptography here is
// SHA-256 from Web Crypto; the wallet produces the signature itself, by signing the PSBT
// this file builds.
//
// Follows BIP-322 (simple) and BIP-174 (PSBT v0).

const enc = new TextEncoder()

const sha256 = async (bytes) => new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))

const dsha256 = async (bytes) => sha256(await sha256(bytes))

/** Hexadecimal, both ways. */
export const hex = {
  to: (b) => [...b].map((x) => x.toString(16).padStart(2, '0')).join(''),
  from: (s) => Uint8Array.from(s.match(/.{1,2}/g).map((x) => parseInt(x, 16)))
}

/** Base64, both ways. */
export const b64 = {
  to: (b) => btoa(String.fromCharCode(...b)),
  from: (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0))
}

const cat = (...arrays) => {
  const out = new Uint8Array(arrays.reduce((n, a) => n + a.length, 0))
  let offset = 0

  for (const a of arrays) {
    out.set(a, offset)
    offset += a.length
  }

  return out
}

/** Bitcoin compact size integer. */
function varint (n) {
  if (n < 0xfd) return new Uint8Array([n])
  if (n <= 0xffff) return new Uint8Array([0xfd, n & 0xff, (n >> 8) & 0xff])
  if (n <= 0xffffffff) {
    return new Uint8Array([0xfe, n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >>> 24) & 0xff])
  }

  throw new Error('varint too large')
}

const u32le = (n) => new Uint8Array([n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >>> 24) & 0xff])

const u64le = (value) => {
  const out = new Uint8Array(8)
  let n = BigInt(value)

  for (let i = 0; i < 8; i++) {
    out[i] = Number(n & 0xffn)
    n >>= 8n
  }

  return out
}

const withLen = (b) => cat(varint(b.length), b)

// bech32 and bech32m decoding, needed to build the scriptPubKey from an address.

const CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l'

const GEN = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3]

function polymod (values) {
  let chk = 1

  for (const v of values) {
    const top = chk >> 25

    chk = ((chk & 0x1ffffff) << 5) ^ v

    for (let i = 0; i < 5; i++) if ((top >> i) & 1) chk ^= GEN[i]
  }

  return chk
}

const hrpExpand = (hrp) => [
  ...[...hrp].map((c) => c.charCodeAt(0) >> 5),
  0,
  ...[...hrp].map((c) => c.charCodeAt(0) & 31)
]

function convertBits (data, from, to, pad) {
  let acc = 0
  let bits = 0
  const out = []
  const maxv = (1 << to) - 1

  for (const v of data) {
    if (v < 0 || v >> from) throw new Error('Invalid address data')

    acc = (acc << from) | v
    bits += from

    while (bits >= to) {
      bits -= to
      out.push((acc >> bits) & maxv)
    }
  }

  if (pad) {
    if (bits) out.push((acc << (to - bits)) & maxv)
  } else if (bits >= from || ((acc << (to - bits)) & maxv)) {
    throw new Error('Invalid address padding')
  }

  return out
}

/**
 * Decodes a segwit address. Version 0 uses bech32, version 1 and above use bech32m, and the
 * two checksums differ: getting this wrong accepts an address for the wrong version.
 *
 * @param {string} address - The address.
 * @returns {{ hrp: string, version: number, program: Uint8Array }} The decoded address.
 */
export function decodeAddress (address) {
  const addr = String(address).trim()
  const lower = addr.toLowerCase()

  if (addr !== lower && addr !== addr.toUpperCase()) throw new Error('Mixed-case address')

  const pos = lower.lastIndexOf('1')

  if (pos < 1 || pos + 7 > lower.length) throw new Error('Not a bech32 address')

  const hrp = lower.slice(0, pos)
  const data = []

  for (const c of lower.slice(pos + 1)) {
    const i = CHARSET.indexOf(c)

    if (i < 0) throw new Error('Invalid character in address')

    data.push(i)
  }

  const chk = polymod([...hrpExpand(hrp), ...data])
  const version = data[0]
  const want = version === 0 ? 1 : 0x2bc830a3

  if (chk !== want) throw new Error('Bad address checksum')

  const program = new Uint8Array(convertBits(data.slice(1, -6), 5, 8, false))

  if (version > 16) throw new Error('Unknown witness version')
  if (program.length < 2 || program.length > 40) throw new Error('Bad witness program length')
  if (version === 0 && program.length !== 20 && program.length !== 32) {
    throw new Error('Bad v0 program length')
  }

  return { hrp, version, program }
}

/**
 * The scriptPubKey an address pays to.
 *
 * @param {string} address - The address.
 * @returns {Uint8Array} The script.
 */
export function scriptPubKeyOf (address) {
  const { version, program } = decodeAddress(address)
  const op = version === 0 ? 0x00 : 0x50 + version // OP_0 / OP_1..OP_16

  return cat(new Uint8Array([op]), withLen(program))
}

/**
 * The BIP-322 tag. A wrong tag changes every message hash, and the signature then verifies
 * nowhere.
 */
export const BIP322_TAG = 'BIP0322-signed-message'

/**
 * `tagged_hash(tag, msg) = SHA256(SHA256(tag) || SHA256(tag) || msg)`.
 *
 * @param {string} tag - The tag.
 * @param {Uint8Array} msg - The message bytes.
 * @returns {Promise<Uint8Array>} The hash.
 */
export async function taggedHash (tag, msg) {
  const t = await sha256(enc.encode(tag))

  return sha256(cat(t, t, msg))
}

function serializeTx ({ inputs, outputs }) {
  const parts = [u32le(0), varint(inputs.length)]

  for (const i of inputs) parts.push(i.hash, u32le(i.index), withLen(i.script), u32le(i.sequence))

  parts.push(varint(outputs.length))

  for (const o of outputs) parts.push(u64le(o.value), withLen(o.script))

  parts.push(u32le(0)) // nLockTime

  return cat(...parts)
}

/**
 * Builds the two BIP-322 virtual transactions. The message is hashed verbatim: one extra
 * space is a different signature.
 *
 * @param {string} address - The address that signs.
 * @param {string} message - The message.
 * @returns {Promise<{ toSpend: Uint8Array, toSpendTxid: Uint8Array, toSign: Uint8Array, scriptPubKey: Uint8Array }>} The transactions.
 */
export async function buildVirtualTxs (address, message) {
  const scriptPubKey = scriptPubKeyOf(address)
  const msgHash = await taggedHash(BIP322_TAG, enc.encode(message))

  const toSpend = serializeTx({
    inputs: [{
      hash: new Uint8Array(32),
      index: 0xffffffff,
      script: cat(new Uint8Array([0x00]), withLen(msgHash)), // OP_0 PUSH32 <hash>
      sequence: 0
    }],
    outputs: [{ value: 0n, script: scriptPubKey }]
  })

  // Internal byte order, which is what the PSBT wants.
  const toSpendTxid = await dsha256(toSpend)

  const toSign = serializeTx({
    inputs: [{ hash: toSpendTxid, index: 0, script: new Uint8Array(0), sequence: 0 }],
    outputs: [{ value: 0n, script: new Uint8Array([0x6a]) }] // OP_RETURN
  })

  return { toSpend, toSpendTxid, toSign, scriptPubKey }
}

const kv = (key, value) => cat(withLen(key), withLen(value))

/**
 * Wraps `to_sign` in a PSBT v0 for the wallet to sign. `witness_utxo` alone is enough;
 * `extra` can carry taproot derivation fields (0x17 internal key, 0x16 tap bip32).
 *
 * @param {string} address - The address that signs.
 * @param {string} message - The message.
 * @param {Array<[Uint8Array, Uint8Array]>} [extra] - Extra input fields.
 * @returns {Promise<string>} The PSBT, base64 encoded.
 */
export async function buildToSignPsbt (address, message, extra = []) {
  const { toSign, scriptPubKey } = await buildVirtualTxs(address, message)
  const global = cat(kv(new Uint8Array([0x00]), toSign))
  const witnessUtxo = cat(u64le(0n), withLen(scriptPubKey))
  const input = cat(kv(new Uint8Array([0x01]), witnessUtxo), ...extra.map(([k, v]) => kv(k, v)))

  const psbt = cat(
    new Uint8Array([0x70, 0x73, 0x62, 0x74, 0xff]), // magic "psbt" + 0xff
    global, new Uint8Array([0x00]),
    input, new Uint8Array([0x00]),
    new Uint8Array([0x00]) // one output, no fields
  )

  return b64.to(psbt)
}

/**
 * Reads the final witness (PSBT field 0x08) of input 0 from a signed PSBT.
 *
 * @param {string} psbtB64 - The signed PSBT, base64 encoded.
 * @returns {Uint8Array} The serialised witness stack.
 */
export function extractWitness (psbtB64) {
  const p = b64.from(psbtB64)
  let o = 5 // skip the magic

  const readVarint = () => {
    const b = p[o++]

    if (b < 0xfd) return b

    if (b === 0xfd) {
      const v = p[o] | (p[o + 1] << 8)
      o += 2
      return v
    }

    if (b === 0xfe) {
      const v = p[o] | (p[o + 1] << 8) | (p[o + 2] << 16) | (p[o + 3] << 24)
      o += 4
      return v >>> 0
    }

    throw new Error('Oversized varint in PSBT')
  }

  const readMap = (onEntry) => {
    for (;;) {
      const klen = readVarint()

      if (klen === 0) return // separator

      const key = p.slice(o, o + klen)
      o += klen

      const vlen = readVarint()
      const value = p.slice(o, o + vlen)
      o += vlen

      onEntry(key, value)
    }
  }

  readMap(() => {}) // global map

  let witness = null

  readMap((key, value) => {
    if (key[0] === 0x08) witness = value
  }) // input 0

  if (!witness) {
    throw new Error('No final witness in the signed PSBT: the wallet did not sign this input.')
  }

  return witness
}

/**
 * A BIP-322 simple signature is the serialised witness stack, base64 encoded.
 *
 * @param {Uint8Array} witnessBytes - The witness stack.
 * @returns {string} The signature.
 */
export function signatureFromWitness (witnessBytes) {
  return b64.to(witnessBytes)
}
