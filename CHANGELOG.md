# Changelog

## Unreleased

- `vanillaKeychain`: the chain under m/86'/coin'/0' the wallet keeps its bitcoin on. For a
  phrase another wallet already uses on m/86'/coin'/0'/0/0, such as UniSat's first taproot
  address: the wallet then never spends what sits there, keeps its own snapshot, and still
  signs messages as that address through a second, offline wallet on the default chain.
- `getIdentityAddress()` on the account: the address messages are signed as.
- `queue`: a host that already runs every use of the wallet one at a time hands in its own
  queue, and the module's arrival-order queue steps aside.

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
