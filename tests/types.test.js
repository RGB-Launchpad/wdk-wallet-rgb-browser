// The published .d.ts files must declare every public method the runtime classes have.
// tsc's JS declaration emit drops overrides that match the base class exactly, and
// scripts/fix-types.mjs merges them back by hand — this test is the guard that the
// merge list stays in sync with the source.
import { readFileSync } from 'node:fs'
import { describe, expect, test } from '@jest/globals'

import WalletManagerRgb from '../src/wallet-manager-rgb.js'
import WalletAccountRgb from '../src/wallet-account-rgb.js'
import WalletAccountReadOnlyRgb from '../src/wallet-account-read-only-rgb.js'

// WalletAccountRgb extends our own read-only class: members it only delegates are
// declared in the read-only .d.ts and inherited from there, so both files count.
const CASES = [
  [WalletManagerRgb, ['types/src/wallet-manager-rgb.d.ts']],
  [WalletAccountRgb, ['types/src/wallet-account-rgb.d.ts', 'types/src/wallet-account-read-only-rgb.d.ts']],
  [WalletAccountReadOnlyRgb, ['types/src/wallet-account-read-only-rgb.d.ts']]
]

// Only the class's own prototype: members inherited from the @tetherto/wdk-wallet base
// classes arrive through `extends` and need no declaration of their own here.
const publicMembers = (cls) =>
  Object.getOwnPropertyNames(cls.prototype)
    .filter((name) => name !== 'constructor' && !name.startsWith('_'))

describe('published types cover the runtime surface', () => {
  for (const [cls, files] of CASES) {
    test(`${cls.name}: every public member is in ${files.join(' + ')}`, () => {
      const dts = files.map((f) => readFileSync(f, 'utf8')).join('\n')
      const missing = publicMembers(cls).filter((name) => !dts.includes(name))
      expect(missing).toEqual([])
    })
  }
})
