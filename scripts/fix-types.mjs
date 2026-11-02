#!/usr/bin/env node
// tsc's declaration emit from JS drops overrides whose signature matches the base class,
// abstract members included, and a consumer's strict check then reports them as not
// implemented (TS2654/TS2515). This runs after tsc and writes the missing declarations back
// into the class body. (Interface merging does not work here: TS does not merge an
// interface with a default-exported class, TS2652, and a private member of the same name
// in the base collides, TS2430.)
//
// The member list is kept by hand: a method added with the base's exact signature gets a
// line here. tests/types.test.js checks that every public method on the runtime prototypes
// appears in the .d.ts files.
import { readFileSync, writeFileSync } from 'node:fs'

const RECEIPT = "import('@tetherto/wdk-wallet').TransactionReceipt"

// name: the method name tested for (word boundary); decl: the declaration inserted when it
// is missing; force: test for the full signature even when the name is present (another
// overload); after: insert right after this declaration rather than at the top of the class,
// so overloads stay in the base's order (TS compares overload lists in order).
const MERGE = {
  'types/src/wallet-account-read-only-rgb.d.ts': {
    class: 'WalletAccountReadOnlyRgb',
    members: [
      { name: 'getAddress', decl: 'getAddress(): Promise<string>;' },
      { name: 'getBalance', decl: 'getBalance(): Promise<bigint>;' },
      { name: 'getTokenBalance', decl: 'getTokenBalance(tokenAddress: string): Promise<bigint>;' },
      { name: 'getTransaction', decl: `getTransaction(hash: string): Promise<${RECEIPT}>;` }
    ]
  },
  'types/src/wallet-account-rgb.d.ts': {
    class: 'WalletAccountRgb',
    members: [
      { name: 'getAddress', decl: 'getAddress(): Promise<string>;' },
      { name: 'getBalance', decl: 'getBalance(): Promise<bigint>;' },
      { name: 'getTokenBalance', decl: 'getTokenBalance(tokenAddress: string): Promise<bigint>;' },
      { name: 'verify', decl: 'verify(message: string, signature: string): Promise<boolean>;' }
    ]
  },
  'types/src/wallet-manager-rgb.d.ts': {
    class: 'WalletManagerRgb',
    members: [
      { name: 'getFeeRates', decl: 'getFeeRates(): Promise<{ normal: bigint, fast: bigint }>;' },
      { name: 'dispose', decl: 'dispose(): void;' },
      { name: 'disposed', decl: 'get disposed(): boolean;' },
      // The base's second overload. The runtime refuses a signer name; the type accepts
      // it so a generic WDK consumer still compiles.
      { name: 'getAccount(signerName', force: true, after: 'getAccount(index?: number): Promise<WalletAccountRgb>;', decl: 'getAccount(signerName: string): Promise<WalletAccountRgb>;' }
    ]
  }
}

for (const [file, { class: cls, members }] of Object.entries(MERGE)) {
  let src = readFileSync(file, 'utf8')
  const opening = src.match(new RegExp(`export default class ${cls}[^{]*\\{`))
  if (!opening) throw new Error(`${file}: class ${cls} not found`)

  const missing = members.filter(({ name, force }) =>
    force ? !src.includes(name) : !new RegExp(`\\b${name}\\s*\\(`).test(src))
  if (missing.length === 0) {
    console.log(`${file}: complete`)
    continue
  }
  const declaration = (m) => `\n    /** Elided by tsc's JS declaration emit (identical to the base's). */\n    ${m.decl}`
  for (const m of missing.filter((m) => m.after)) {
    const at = src.indexOf(m.after)
    if (at < 0) throw new Error(`${file}: ${m.after} not found`)
    const insertAt = at + m.after.length
    src = src.slice(0, insertAt) + declaration(m) + src.slice(insertAt)
  }
  const atTop = missing.filter((m) => !m.after)
  if (atTop.length) {
    const insertAt = opening.index + opening[0].length
    src = src.slice(0, insertAt) + atTop.map(declaration).join('\n') + '\n' + src.slice(insertAt)
  }
  writeFileSync(file, src)
  console.log(`${file}: inserted ${missing.length} member(s) into ${cls}`)
}
