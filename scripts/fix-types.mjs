#!/usr/bin/env node
// tsc 从 JS 生成 .d.ts 时，会丢掉与基类签名完全一致的覆盖方法——包括抽象成员，
// 消费方 strict 检查就会报「没实现抽象成员」（TS2654/TS2515）。本脚本在 tsc 之后
// 跑，把缺了的成员声明直接插回类体。（不走 interface 声明合并：TS 不允许它与
// default-exported class 合并，TS2652；基类有同名私有成员时还会撞 TS2430。）
//
// 成员表是手工维护的：加了一个与基类同签名的方法，就在这里加一行。
// tests/types.test.js 会核对运行时原型上的每个公开方法都在 d.ts 里出现。
import { readFileSync, writeFileSync } from 'node:fs'

const RECEIPT = "import('@tetherto/wdk-wallet').TransactionReceipt"

// name: 用于判存的方法名（词边界匹配）；decl: 缺了就插进类体的声明；force: 名字已在
// （另一个重载）也要按完整签名再判一次。
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
      // The base's second overload. The runtime refuses a signer name; the type accepts
      // it so a generic WDK consumer still compiles.
      { name: 'getAccount(signerName', force: true, decl: "getAccount(signerName: string): Promise<import('./wallet-account-rgb.js').default>;" }
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
  const insertAt = opening.index + opening[0].length
  const block = missing.map((m) => `\n    /** Elided by tsc's JS declaration emit (identical to the base's). */\n    ${m.decl}`).join('\n') + '\n'
  src = src.slice(0, insertAt) + block + src.slice(insertAt)
  writeFileSync(file, src)
  console.log(`${file}: inserted ${missing.length} member(s) into ${cls}`)
}
