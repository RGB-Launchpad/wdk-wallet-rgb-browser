# Changelog

## Unreleased

Added:

- `coloredKeychain`: the chain under the colored account m/86'/827166'/0' (827167' off Mainnet)
  the wallet keeps its RGB outputs on. For a phrase another rgb-lib wallet already uses: two
  wallets on the same colored chain each take the other's asset outputs for empty ones, and
  spending one destroys the assets on it. The wallet keeps its own snapshot. It needs bindings
  that read `coloredKeychain` in their wallet data; with bindings that do not, opening fails
  rather than falling back to the shared chain.

## 0.2.0 - 2026-10-16

Fixed:

- Creating slots and sending bitcoin report success once the transaction is broadcast. A sync
  that failed afterwards turned a sent transaction into an error, and a retry paid again.
- `createUtxos` reports the number of slots it asked for, not rgb-lib's count before a sync (0).
- Free slots are counted the way rgb-lib picks a UTXO for a blinded invoice: one allocation
  left free on each UTXO, open invoices counted, UTXOs not yet existing or waiting on a witness
  receive skipped. The count reported room a blinded invoice was then refused.

Added:

- `vanillaKeychain`: the chain under m/86'/coin'/0' the wallet keeps its bitcoin on. For a
  phrase another wallet already uses on m/86'/coin'/0'/0/0, such as UniSat's first taproot
  address: the wallet then never spends what sits there, keeps its own snapshot, and still
  signs messages as that address through a second, offline wallet on the default chain.
- `identityCoinType`: with `vanillaKeychain` set, 0 puts that identity address at
  m/86'/0'/0'/0/0 on every network, for wallets that use coin type 0 on test networks too.
- `getIdentityAddress()` on the account: the address messages are signed as.
- `prepareTransfer()` and `finishTransfer()` on the account: a transfer in two halves, so a host
  can show the user the unsigned transaction and the outputs it spends before signing. The
  second half is refused when the wallet signed anything in between or an input is no longer
  the wallet's: rgb-lib would otherwise sign two transactions spending one output.
- `activity()`: assets, each asset's transfers and the bitcoin transactions in one read,
  without the indexer, including transfers that belong to no asset yet; `confirmations(rows)`
  adds the counts separately.
- `listTransactions()`: the wallet's own bitcoin transactions, newest first, with
  confirmation counts.
- `deferOnline`: open on the snapshot alone and reach the indexer later with `goOnline(url)`;
  the indexer that answered is the one later reads use.
- `notAfter` on sends: a send still waiting for its turn past it is refused unsent, also when
  an operation ahead of it never ends.
- `fallbackProxyUrls`: further proxies an invoice names after `proxyUrl`, at most three in all.
- `blindReceive` and `witnessReceive` take `amount` and `minConfirmations`; `createUtxos` takes
  how many to create.
- `nonFungible` on `sendAsset` and `transfer`, for unique tokens (UDA) on an engine that has them.
- `schemas`: the asset schemas the wallet accepts. The default is unchanged.
- `queue`: a host that already runs every use of the wallet one at a time hands in its own
  queue, and the module's arrival-order queue steps aside.

Changed:

- A wallet call refused because another user of the same engine holds the wallet (a Lightning
  node in the same WebAssembly module) is retried on its own until the wallet is free.
- Confirmation counts share one round of indexer reads for five seconds, with txids
  deduplicated and status reads four at a time.
- `goOnline` and the fee estimate run in the queue.

## 0.1.1 - 2026-09-26

Documentation and repository hygiene; no code changes.

- README gains npm and license badges, a beta note, and a short supply-chain statement.
- The changelog ships in the package.
- The repository gains CI (lint, type build, Node and Chromium tests), issue and PR
  templates, and dependabot.

## 0.1.0 - 2026-09-26

First public release.

- Wallet manager and account for RGB assets on Bitcoin, in the browser, on top of
  `@utexo/rgb-lib-wasm` and `@tetherto/wdk-wallet` (both peer dependencies).
- Balances, asset listing, blinded and witness invoices, colored-UTXO slot management,
  RGB and BTC sends, backup and restore, asset issuance, and BIP-322 message signing.
- Bindings are injectable through `config.bindings`; the published `@utexo/rgb-lib-wasm`
  is the default.
- Tests: pure logic and the BIP-322 vectors on Node, the wallet itself in Chromium, and
  a live-chain end-to-end run against a local regtest (`npm run test:live`).
