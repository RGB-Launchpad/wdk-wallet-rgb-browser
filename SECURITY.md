# Security

## Reporting a vulnerability

Report it privately through GitHub: the **Security** tab of this repository, then
**Report a vulnerability**. Please do not open a public issue or pull request for it.

A report helps most with the version, the network, and the steps or code that reproduce it.

## Supported versions

Fixes go into the latest release only.

| Version | Supported |
|---|---|
| 0.2.x | Yes |
| < 0.2 | No |

## Scope

This repository covers the module itself: what it sends to the indexer and the proxy, how it
signs, and how it stores the wallet snapshot. A vulnerability in rgb-lib or its WebAssembly
bindings belongs to those projects; report it to them under their own security policies.
