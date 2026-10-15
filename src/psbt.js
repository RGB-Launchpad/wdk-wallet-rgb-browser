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

const MAGIC = [0x70, 0x73, 0x62, 0x74, 0xff] // "psbt" 0xff

const fromBase64 = (text) => {
  const raw = atob(String(text).trim())
  const bytes = new Uint8Array(raw.length)
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i)
  return bytes
}

/** A reader over `bytes` that refuses to run past their end. */
const reader = (bytes) => {
  let at = 0
  const need = (n) => { if (at + n > bytes.length) throw new Error('The PSBT ends early.') }
  const r = {
    get at () { return at },
    take (n) { need(n); const out = bytes.subarray(at, at + n); at += n; return out },
    u8 () { need(1); return bytes[at++] },
    u32 () { const b = r.take(4); return (b[0] | (b[1] << 8) | (b[2] << 16) | (b[3] << 24)) >>> 0 },
    varint () {
      const first = r.u8()
      if (first < 0xfd) return first
      const n = first === 0xfd ? 2 : first === 0xfe ? 4 : 8
      const b = r.take(n)
      let v = 0
      for (let i = n - 1; i >= 0; i--) v = v * 256 + b[i]
      if (!Number.isSafeInteger(v)) throw new Error('The PSBT holds a length it cannot have.')
      return v
    }
  }
  return r
}

const hex = (bytes) => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')

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
export function psbtInputs (psbt) {
  const r = reader(fromBase64(psbt))
  if (!MAGIC.every((b) => r.u8() === b)) throw new Error('Not a PSBT.')

  // The global map: key-value pairs up to a zero-length key.
  let tx = null
  for (;;) {
    const keyLength = r.varint()
    if (keyLength === 0) break
    const key = r.take(keyLength)
    const value = r.take(r.varint())
    if (keyLength === 1 && key[0] === 0x00) tx = value
  }
  if (!tx) throw new Error('The PSBT has no unsigned transaction (only version 0 PSBTs are read).')

  const t = reader(tx)
  t.take(4) // version
  let count = t.varint()
  // A segwit marker and flag, which an unsigned transaction should not have, are passed over.
  if (count === 0) { t.u8(); count = t.varint() }
  const inputs = []
  for (let i = 0; i < count; i++) {
    const txid = hex(t.take(32).slice().reverse())
    const vout = t.u32()
    t.take(t.varint()) // script
    t.take(4) // sequence
    inputs.push({ txid, vout })
  }
  return inputs
}
