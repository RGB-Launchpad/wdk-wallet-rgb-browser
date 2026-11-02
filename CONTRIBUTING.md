# Contributing

Issues and pull requests are welcome. For a change in behaviour, open an issue first so the
approach can be agreed before the code is written.

## Before a pull request

```bash
npm ci
npm run lint
npm run build:types
npm test
npx playwright install chromium
npm run test:browser
```

CI runs the same steps and has to pass. If a change affects the public API, commit the
regenerated `types/` along with it and add a line under `Unreleased` in
[CHANGELOG.md](CHANGELOG.md).

Changes to transfers, invoices or the snapshot are best also checked against a real chain
with `npm run test:live`; see [Development](README.md#development) in the README.

## Releases

A maintainer pushes a `v*` tag; the `publish` workflow checks and tests that commit, publishes
it to npm with provenance once approved, and creates the GitHub release from its CHANGELOG
section.

## Security

Do not report vulnerabilities in issues or pull requests. See [SECURITY.md](SECURITY.md).
