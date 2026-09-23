# @rgb-launchpad/wdk-wallet-rgb

A [WDK](https://docs.wdk.tether.io/) wallet module for RGB assets on Bitcoin, running in the
browser.

Register it with a `WDK` instance and it behaves like any other wallet module: accounts,
balances, transfers, fee rates, and the policy engine on top. Underneath it is rgb-lib,
compiled to WebAssembly, validating consignments on the device.

## Built on rgb-lib, in the browser through UTEXO's WebAssembly bindings

The RGB engine is [rgb-lib](https://github.com/RGB-Tools/rgb-lib) by RGB-Tools, MIT. Upstream
ships C-FFI and UniFFI bindings, which cover mobile and desktop but not a browser tab. The
WebAssembly bindings that do are
[rgb-lib-wasm](https://github.com/UTEXO-Protocol/rgb-lib-wasm), maintained by
[UTEXO](https://github.com/UTEXO-Protocol) and published as
[`@utexo/rgb-lib-wasm`](https://www.npmjs.com/package/@utexo/rgb-lib-wasm) under the library's
own licence. This module is a binding between that engine and the WDK's interfaces; the RGB
protocol work is theirs.

UTEXO also maintains [`@utexo/wdk-wallet-rgb`](https://www.npmjs.com/package/@utexo/wdk-wallet-rgb),
the WDK's RGB module for native runtimes. The two are complements, not alternatives: that one
covers apps built on Node.js and Bare, this one covers pages and browser extensions.

## Installation

```bash
npm install @rgb-launchpad/wdk-wallet-rgb @tetherto/wdk-wallet @utexo/rgb-lib-wasm
```

## Quick start

```javascript
import WDK from '@tetherto/wdk'
import WalletManagerRgb from '@rgb-launchpad/wdk-wallet-rgb'

const wdk = new WDK(seedPhrase).registerWallet('rgb', WalletManagerRgb, {
  network: 'Signet',
  proxyUrl: 'rpcs://your-proxy.example/json-rpc'
})

const account = await wdk.getAccount('rgb', 0)

console.log(await account.getAddress())
console.log(await account.listAssets())

// Receiving needs an empty colored UTXO to land in, and making one is an on-chain
// transaction that has to confirm.
await account.createUtxos()

const invoice = await account.receiveAsset({ assetId })

// Sending goes to an invoice, not to an address.
await account.transfer({ token: assetId, recipient: theirInvoice, amount: 1000n })
```

A runnable page is in [`examples/browser`](examples/browser).

## What a browser needs

A bundler, and a `Buffer` shim. Neither comes from this module: `bip39`, which
`@tetherto/wdk-wallet` depends on, is published as CommonJS and reads the global `Buffer`.
[`examples/browser/build.js`](examples/browser/build.js) shows both in about thirty lines of
esbuild configuration.

Storage matters more here than it does on a server. rgb-lib keeps the wallet — the BDK chain,
the RGB stock and every consignment it has received — in one IndexedDB snapshot per network.
Those consignments *are* the assets: a recovery phrase alone cannot rebuild them. The module
asks the browser for persistent storage when it opens a wallet, and `createBackup` exists
because that request can be refused.

## Configuration

| Option | Default | What it is |
|---|---|---|
| `network` | `Signet` | `Mainnet`, `Signet`, `Testnet4` or `Regtest`. |
| `esploraUrl` | mempool.space's public endpoint | The indexer. Required on Regtest. |
| `proxyUrl` | none | The RGB proxy that carries consignments. Required to send or receive. |
| `bindings` | `@utexo/rgb-lib-wasm` | The WebAssembly bindings module, imported on demand. |
| `minConfirmations` | `1` | Confirmations an incoming transfer must reach. |
| `invoiceMinutes` | `60` | How long an invoice stays valid. |
| `fee` | per network | Bidding parameters: safety multiplier, floor and cap. |
| `slots` | 3 × 20000 sats | How many empty colored UTXOs to keep, and how large. |

There is deliberately no default proxy. A proxy relays consignments and therefore sees
recipient identifiers, so which one to trust is your decision, not this package's.

`bindings` is an injection point rather than a hard dependency: a consumer that ships its own
build of the bindings — a different version, or one with additions — passes the module in and
everything else works unchanged.

## What is different about RGB

**A recipient is an invoice, not an address.** The receiver decides which UTXO an asset lands
on, and the invoice is how they say so. `transfer({ recipient })` takes one.

**Receiving needs a free allocation slot.** Assets live on Bitcoin UTXOs, so a wallet with no
empty colored UTXO cannot receive. `createUtxos()` makes them; it costs an on-chain
transaction, and it refuses while any input is unconfirmed, because rgb-lib builds the split
from every vanilla input at once.

**A transfer is not done when the transaction confirms.** The consignment still has to reach
the recipient through a proxy and be validated there. `listTransfers()` shows that state and
`refresh()` advances it.

**Fees come out of the colored UTXOs.** An RGB send never pays from the plain Bitcoin balance,
which is why a slot that is empty but small is worse than no slot at all, and why
`explainSendError` exists.

## One account

rgb-lib holds one wallet per recovery phrase and derives its keychains inside it, so this
manager serves a single account, at index 0. Asking for another index is an error rather than
a silently different wallet.

## Development

```bash
npm install
npm run lint
npm test                      # the pure logic, on Node
npx playwright install chromium
npm run test:browser          # the wallet itself, in Chromium
npm run build:example
```

`npm test` does not include the browser test: it needs a browser binary, and a package's
default test run should not.

## Licence

Apache-2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
