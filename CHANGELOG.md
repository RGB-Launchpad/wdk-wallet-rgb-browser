# Changelog

## 0.2.1 - 2026-11-02

Fixed:

- An invoice is paid once. `transfer()` and `prepareTransfer()` refuse an invoice whose
  recipient this wallet has already sent to, in a send that has not failed, before anything is
  built or signed. An invoice takes one consignment: a second send to it was never accepted and
  waited until it expired. Once the earlier send has failed, the invoice can be paid again.
- `listTransfers()` without an asset includes unique tokens (UDA) and CFA assets on bindings
  that take an asset id; it listed only NIA and IFA ones.
- The declarations pass a consumer's strict TypeScript check with `@tetherto/wdk-wallet`
  1.0.0-beta.22 and later: the account has `disposed`, which `IWalletAccount` requires from
  beta.22 on, and the manager's `getAccount` overloads are in the base class's order. Checked
  with beta.21, beta.22 and beta.25.

Added:

- `coloredKeychain`: the chain under the colored account m/86'/827166'/0' (827167' off Mainnet)
  the wallet keeps its RGB outputs on. For a phrase another rgb-lib wallet already uses: two
  wallets on the same colored chain each take the other's asset outputs for empty ones, and
  spending one destroys the assets on it. The wallet keeps its own snapshot. It needs bindings
  that read `coloredKeychain` in their wallet data; with bindings that do not, opening fails
  rather than falling back to the shared chain.

- `disposed` on the account: true once `dispose()` has been called.

Changed:

- The peer dependency on `@tetherto/wdk-wallet` starts at 1.0.0-beta.21, the first version
  whose `WalletManager` takes a signer type; the declarations extend `WalletManager<ISigner>`.
- Releases are published from GitHub Actions, with npm provenance.

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
