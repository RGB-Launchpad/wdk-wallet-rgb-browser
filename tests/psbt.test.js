'use strict'

import { readFileSync } from 'node:fs'
import { describe, expect, test } from '@jest/globals'

import { psbtInputs } from '../src/psbt.js'

// Two PSBTs rgb-lib made on regtest, an asset send's and a plain bitcoin send's, with their
// inputs as bitcoind's decodepsbt reads them.
const FIXTURES = JSON.parse(readFileSync(new URL('./fixtures/psbt.json', import.meta.url), 'utf8'))

describe('psbtInputs', () => {
  for (const [name, { psbt, inputs }] of Object.entries(FIXTURES)) {
    test(`${name}: the outputs it spends, as bitcoind reads them`, () => {
      expect(psbtInputs(psbt)).toEqual(inputs)
    })
  }

  test('anything else is refused', () => {
    expect(() => psbtInputs(btoa('not a psbt'))).toThrow(/Not a PSBT/)
    const cut = FIXTURES.rgbSend.psbt.slice(0, 40)
    expect(() => psbtInputs(cut)).toThrow()
  })
})
