# @darkhorse-wallet/wdk-wallet-rgb

[![npm version](https://img.shields.io/npm/v/%40darkhorse-wallet%2Fwdk-wallet-rgb?style=flat-square)](https://www.npmjs.com/package/@darkhorse-wallet/wdk-wallet-rgb)
[![license](https://img.shields.io/npm/l/%40darkhorse-wallet%2Fwdk-wallet-rgb?style=flat-square)](https://github.com/RGB-Launchpad/wdk-wallet-rgb-browser/blob/main/LICENSE)

> **What's new in 0.2.1** — one payment per invoice, `coloredKeychain`, stricter two-step
> transfers, one instance per wallet, input validation, and releases published with npm
> provenance. See the [release notes](https://github.com/RGB-Launchpad/wdk-wallet-rgb-browser/releases/tag/v0.2.1)
> and the [changelog](CHANGELOG.md).

**Note**: This package is currently in beta, as is the WDK itself. Please test thoroughly in
development environments before using in production.

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
npm install @darkhorse-wallet/wdk-wallet-rgb @tetherto/wdk-wallet @utexo/rgb-lib-wasm
```

The package itself has no runtime dependencies — the WDK framework and the WebAssembly
bindings are peers, so you choose and audit those versions yourself — and no install
scripts.

## Quick start

```javascript
import WDK from '@tetherto/wdk'
import WalletManagerRgb from '@darkhorse-wallet/wdk-wallet-rgb'

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

// A wallet with no free slot can still receive, if the sender pays for the output.
const witnessInvoice = await account.receiveAssetToWitness({ assetId })

// Issuing allocates the whole supply here, one slot per amount.
await account.issueAsset({ ticker: 'DEMO', name: 'Demo asset', precision: 8, amounts: [21_000_000n] })

// Proving the wallet holds its address, as a BIP-322 simple signature.
const signature = await account.sign('Hello World')
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
| `vanillaKeychain` | `0` | The chain under m/86'/coin'/0' the wallet keeps its bitcoin on. Set it for a phrase another wallet already uses on m/86'/coin'/0'/0/0. |
| `coloredKeychain` | the shared colored chain | The chain under m/86'/827166'/0' (827167' off Mainnet) the wallet keeps its RGB outputs on. Set it for a phrase another rgb-lib wallet already uses. Needs bindings that read it: `@utexo/rgb-lib-wasm` 1.0.0-beta.3 does not, and opening then fails. |

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

## Signing messages

rgb-lib exposes no message signing, so `sign(message)` builds the pair of virtual
transactions BIP-322 defines, has the wallet sign that PSBT, and returns the resulting
witness stack. The construction is in [`src/bip322.js`](src/bip322.js) and is pinned by the
specification's own vectors. `signMessage(message)` returns the address alongside the
signature, which is what a verifier needs.

`verify` is not implemented. Checking a signature means Schnorr verification, which neither
this module nor the bindings underneath it provide; use a Bitcoin library on the verifying
side.

## A send is not sent

`transfer()` puts nothing on the chain. RGB posts the consignment to the proxy and waits: the
recipient fetches it, validates it, and acknowledges. Only then does the sender broadcast,
because a transaction broadcast before the recipient could validate can leave the asset
unrecoverable.

So the `hash` it returns names a transaction that is not on the network yet, and `refresh()`
is what eventually puts it there. **A wallet that sends and never refreshes again has not sent
anything.** `pendingHandovers()` says whether any send is still waiting, so a consumer can
drive them to completion — on a timer, when it reopens, whenever suits it — rather than
leaving the user to discover that nothing happened.

Two consequences worth designing for: the interface should not tell the user it was sent, and
completion needs the wallet open, since refreshing needs the engine and the engine needs the
recovery phrase.

## Checking before signing

`prepareTransfer()` returns the unsigned transaction (`psbt`) and the outputs it spends, and
signs nothing; `finishTransfer(prepared)` signs it and posts the consignment. In between the
host can show the user what is about to be signed.

rgb-lib holds nothing for a prepared transfer: its inputs stay free, and another send can
spend them. Signed afterwards, the prepared one would spend an output already spent, and its
recipient would wait for a transfer that never confirms. So `finishTransfer` refuses when the
wallet has signed anything since the transfer was prepared, when the wallet has been closed and
opened again since, when `prepared` is not exactly what this wallet prepared (the PSBT, the
asset, the recipient and the amount), when the invoice has been paid since, or when an output
it spends is no longer the wallet's. Prepare it again then.

An invoice is paid once. A send to an invoice whose recipient this wallet has already sent to,
in a send that has not failed, is refused before anything is built.

## Two things a browser wallet gets wrong against a live chain

Both were found by running this module against a real regtest chain, and both look like the
chain is broken when they are not.

**The indexer's cache headers decide how current the wallet can be.** blockstream/esplora
answers with `cache-control: public, max-age=10`, and a browser obeys it. A wallet polling
faster than that keeps reading the same answer: a transfer stays at `WaitingConfirmations`
long after its transaction is in a block. This module's own reads pass `cache: 'no-store'`,
but rgb-lib's requests are its own, so no wallet can be more current than the indexer allows.

**`listTransfers` takes different arguments in different builds.** The published bindings take
an asset id, and passing none returns the transfers belonging to *no* asset — an empty list on
a wallet that holds any. Later builds take an AssetFilter, where `any` means everything. This
module settles which one the injected bindings want on the first call and, for the asset-id
shape, asks once per asset so that "every transfer" means what it says.

## One account

rgb-lib holds one wallet per recovery phrase and derives its keychains inside it, so this
manager serves a single account, at index 0. Asking for another index is an error rather than
a silently different wallet.

## One instance

A wallet is open in one place at a time: one recovery phrase on one network (one `dataDir`).
Each instance restores the whole IndexedDB snapshot when it opens and writes the whole of it
back as it goes, so two of them would overwrite each other's records, consignments among them.
Opening holds a Web Lock on the snapshot until `dispose()`; a second instance — another tab,
another manager in the same page — waits five seconds for it and is then refused with an error
that says the wallet is open elsewhere. Where the browser has no Web Locks, nothing is held.

`dispose()` closes the wallet and lets go of the lock. The manager keeps no BIP-39 seed (the
WDK base class derives one; it is wiped, and `seed` is undefined) and, once disposed, does not
open again.

## Limits on what a caller passes

| Input | Accepted | Otherwise |
|---|---|---|
| `feeRate` (sends, `createUtxos`) | a whole number of sat/vB from 1 to the network's `fee.max`; absent or 0 to estimate | refused, nothing built |
| `minConfirmations` (invoices) | a whole number from 0 to 255; raised to the configured value | refused |
| `minutes` (invoices) | a whole number from 1 to 525,600 (a year) | refused |

An estimated fee rate is worked out in the send's own turn, so `notAfter` covers it too; the
mempool read behind it gives up after ten seconds.

## Development

```bash
npm install
npm run lint
npm test                      # the pure logic and the BIP-322 vectors, on Node
npx playwright install chromium
npm run test:browser          # the wallet itself, in Chromium
npm run build:example
```

`npm test` does not include the browser test: it needs a browser binary, and a package's
default test run should not.

### Against a real chain

`npm run test:live` opens two wallets in one page, issues an asset in one, invoices it from
the other, sends it, and checks that both sides settle. The indexer, the proxy and rgb-lib's
transfer state machine are only exercised here; every bug this module has had so far was one
the offline tests agreed with.

It needs a chain you control, named through the environment so that no endpoint of anyone's
lives in this repository:

| Variable | What it is |
|---|---|
| `RGB_LIVE_ESPLORA` | The Esplora API, e.g. `http://127.0.0.1:8094/regtest/api`. |
| `RGB_LIVE_PROXY` | The RGB proxy, e.g. `rpc://127.0.0.1:8787/json-rpc`. |
| `RGB_LIVE_FUND` | Shell command that funds an address. `{address}` and `{btc}` are substituted. |
| `RGB_LIVE_MINE` | Shell command that mines blocks. `{blocks}` is substituted. |
| `RGB_LIVE_NETWORK` | Defaults to `Regtest`. |
| `RGB_LIVE_BINDINGS` | Another build of the bindings to test against, as a path to its JavaScript. The `.wasm` beside it is used too — the two halves of a build go together. |
| `RGB_LIVE_CACHE_MS` | How long to wait for the indexer's cache to expire after mining. Defaults to 11000. |

A regtest with an Esplora API is one command:

```sh
docker run -d -p 8094:80 -e NO_PRECACHE=1 -e NO_REGTEST_MINING=1   blockstream/esplora /srv/explorer/run.sh bitcoin-regtest explorer
```

Its internal indexer waits for a first block, so mine 101 before anything else, and use the
same `bitcoin-cli` for `RGB_LIVE_FUND` and `RGB_LIVE_MINE`.

## Licence

Apache-2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
