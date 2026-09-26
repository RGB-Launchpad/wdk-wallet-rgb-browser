# Changelog

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
