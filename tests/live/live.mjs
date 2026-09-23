// Copyright 2026 RGB Launchpad
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

'use strict'

// Two wallets, one browser, one real chain: issue an asset, invoice it, send it, settle it,
// and check both sides. Everything the unit and offline browser tests cannot reach — the
// indexer, the proxy, rgb-lib's transfer state machine — is exercised here.
//
// It needs a chain you control. See "Against a real chain" in the README for what to set.

import assert from 'node:assert/strict'
import { execSync } from 'node:child_process'
import { copyFile, mkdir } from 'node:fs/promises'
import { createReadStream, existsSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { createServer } from 'node:http'
import { dirname, extname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { build } from 'esbuild'
import { chromium } from 'playwright'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..', '..')
const require = createRequire(join(root, 'package.json'))

const env = (name) => {
  const value = process.env[name]

  if (!value) {
    console.error(`${name} is not set. See "Against a real chain" in the README.`)
    process.exit(2)
  }

  return value
}

const ESPLORA = env('RGB_LIVE_ESPLORA')
const PROXY = env('RGB_LIVE_PROXY')
const NETWORK = process.env.RGB_LIVE_NETWORK || 'Regtest'

// Shell templates for the two things only the chain's owner can do. `{address}` and `{btc}`
// are substituted in the funding one, `{blocks}` in the mining one.
const FUND = env('RGB_LIVE_FUND')
const MINE = env('RGB_LIVE_MINE')

const fund = (address, btc) =>
  execSync(FUND.replaceAll('{address}', address).replaceAll('{btc}', String(btc)), { encoding: 'utf8' }).trim()

const mine = (blocks = 1) =>
  execSync(MINE.replaceAll('{blocks}', String(blocks)), { encoding: 'utf8' }).trim()

const tip = async () => Number(await fetch(`${ESPLORA}/blocks/tip/height`, { cache: 'no-store' }).then((r) => r.text()))

/**
 * Mines, then waits for the indexer to catch up and for its cache to expire.
 *
 * Both waits are needed. The indexer indexes a new block a moment after it appears, and it
 * answers with cache headers a browser obeys — so a page can be told about a block for some
 * seconds after the indexer knows of it. The wallet under test is a page.
 */
const advance = async (blocks = 1) => {
  const before = await tip()

  mine(blocks)

  for (let i = 0; i < 120; i++) {
    if (await tip() >= before + blocks) break
    await new Promise((resolve) => setTimeout(resolve, 500))
  }

  await new Promise((resolve) => setTimeout(resolve, Number(process.env.RGB_LIVE_CACHE_MS || 11000)))
}

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.wasm': 'application/wasm' }

async function serve (dir) {
  const server = createServer((req, res) => {
    const path = req.url.split('?')[0]

    if (path === '/') {
      res.writeHead(200, { 'content-type': 'text/html' })
      res.end('<!doctype html><meta charset="utf-8"><script type="module" src="/bundle.js"></script>')
      return
    }

    const file = join(dir, path)

    if (!existsSync(file) || !statSync(file).isFile()) {
      res.writeHead(404)
      res.end()
      return
    }

    res.writeHead(200, { 'content-type': TYPES[extname(file)] || 'application/octet-stream' })
    createReadStream(file).pipe(res)
  })

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))

  return server
}

async function bundle () {
  const out = join(here, 'dist')

  await mkdir(out, { recursive: true })

  // RGB_LIVE_BINDINGS points at another build of the bindings — a consumer's own, say, with
  // methods the published package does not have. The glue and the binary go together: mixing
  // one build's JavaScript with another's WebAssembly does not work.
  const bindings = process.env.RGB_LIVE_BINDINGS

  await build({
    entryPoints: [join(here, 'page.js')],
    outfile: join(out, 'bundle.js'),
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: 'es2022',
    inject: [join(root, 'examples', 'browser', 'buffer-shim.js')],
    ...(bindings ? { alias: { '@utexo/rgb-lib-wasm': bindings } } : {})
  })

  // The bindings resolve the binary against import.meta.url, which is the bundle's own URL.
  await copyFile(
    bindings
      ? join(dirname(bindings), 'rgb_lib_wasm_bindings_bg.wasm')
      : require.resolve('@utexo/rgb-lib-wasm/rgb_lib_wasm_bindings_bg.wasm'),
    join(out, 'rgb_lib_wasm_bindings_bg.wasm')
  )
}

const passed = []
const step = async (label, fn) => {
  const started = Date.now()

  try {
    const value = await fn()

    passed.push(label)
    console.log(`  ok  ${label} (${Date.now() - started}ms)`)

    return value
  } catch (error) {
    console.error(`  FAIL ${label}: ${String(error.message || error).split('\n')[0]}`)
    throw error
  }
}

let server, browser

try {
  await bundle()

  server = await serve(join(here, 'dist'))
  browser = await chromium.launch()

  const page = await browser.newPage()
  const errors = []

  page.on('pageerror', (e) => errors.push(String(e).split('\n')[0]))
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text()}`) })

  await page.goto(`http://127.0.0.1:${server.address().port}/`)

  try {
    await page.waitForFunction(() => globalThis.rgb !== undefined, null, { timeout: 30000 })
  } catch {
    assert.fail(`the page never loaded the module: ${errors.join(' | ') || 'no error reported'}`)
  }

  const open = (name) => page.evaluate(([n, c]) => globalThis.rgb.open(n, c),
    [name, { network: NETWORK, esploraUrl: ESPLORA, proxyUrl: PROXY }])
  const call = (name, method, ...args) =>
    page.evaluate(([n, m, a]) => globalThis.rgb.call(n, m, ...a), [name, method, args])

  console.log(`\n${NETWORK} via ${ESPLORA}\n`)

  const seller = await step('the seller opens, online', async () => {
    const w = await open('seller')

    assert.equal(w.status.online, true, `the indexer did not answer: ${w.status.onlineError}`)
    assert.match(w.address, /^(bc|tb|bcrt)1p/, 'not a taproot address')

    return w
  })

  const buyer = await step('the buyer opens, online', async () => {
    const w = await open('buyer')

    assert.equal(w.status.online, true)
    assert.notEqual(w.address, seller.address, 'two wallets sharing one address')

    return w
  })

  await step('both are funded and the funding confirms', async () => {
    fund(seller.address, 0.5)
    fund(buyer.address, 0.5)

    await advance(1)

    // Reading a balance does not go to the chain; sync is what makes it current.
    await call('seller', 'sync')
    await call('buyer', 'sync')

    const balance = await call('seller', 'getBtcBalance')

    assert.ok(BigInt(balance.vanilla.settled) > 0n, 'the funding never confirmed for the wallet')
  })

  await step('the fee bid is one a slot can pay', async () => {
    const { fee } = await call('seller', 'quoteSendTransaction')

    assert.ok(Number(fee) > 0, 'no fee rate')
    assert.ok(Number(fee) * 154 <= 20000, `bid ${fee} sat/vB cannot be paid out of one slot`)
  })

  await step('both create allocation slots', async () => {
    for (const who of ['seller', 'buyer']) {
      const { created } = await call(who, 'createUtxos')

      assert.ok(created > 0, `${who} created no slots`)

      await advance(1)
    }

    assert.ok(await call('buyer', 'getFreeSlots') > 0, 'the buyer has nowhere to receive')
  })

  const asset = await step('the seller issues an asset', async () => {
    const issued = await call('seller', 'issueAsset',
      { ticker: 'LIVE', name: 'Live test asset', precision: 0, amounts: [1000] })

    assert.equal(issued.balance.settled, '1000')

    return issued
  })

  await step('the seller cannot invoice an asset it has never held', async () => {
    await assert.rejects(
      () => call('buyer', 'receiveAsset', { assetId: asset.assetId }),
      /not found/,
      'an invoice was issued for an unknown contract')
  })

  const invoice = await step('the buyer issues an invoice', async () => {
    const created = await call('buyer', 'receiveAsset')

    assert.ok(created.invoice.startsWith('rgb:'), 'not an RGB invoice')
    assert.ok(created.invoice.includes(PROXY.replace(/^rpcs?:\/\//, '')), 'the invoice names another proxy')

    return created
  })

  const sent = await step('the seller sends 250', async () => {
    const result = await call('seller', 'transfer',
      { token: asset.assetId, recipient: invoice.invoice, amount: 250 })

    assert.match(result.hash, /^[0-9a-f]{64}$/, 'no witness txid')

    return result
  })

  await step('the consignment reaches the buyer and both sides settle', async () => {
    // The witness transaction carries an anti-fee-sniping locktime, so it cannot be mined
    // into the very next block.
    for (let round = 0; round < 8; round++) {
      await advance(1)
      await call('seller', 'refresh')
      await call('buyer', 'refresh')

      const both = [
        ...await call('seller', 'listTransfers'),
        ...await call('buyer', 'listTransfers')
      ]

      if (both.length && both.every((t) => t.status === 'Settled')) return { rounds: round + 1 }
    }

    const status = await fetch(`${ESPLORA}/tx/${sent.hash}/status`, { cache: 'no-store' }).then((r) => r.json())

    assert.fail(`the transfer never settled; the chain says ${JSON.stringify(status)}`)
  })

  await step('the asset moved, and listing transfers needs no asset id', async () => {
    const [sellerAsset] = await call('seller', 'listAssets')
    const [buyerAsset] = await call('buyer', 'listAssets')

    assert.equal(sellerAsset.balance.settled, '750')
    assert.equal(buyerAsset.balance.settled, '250')
    assert.equal(buyerAsset.assetId, asset.assetId)

    // The published bindings return nothing for "no asset id", which is the trap this asserts
    // against: a history that came back empty here would agree with the bug.
    const history = await call('seller', 'listTransfers')

    assert.equal(history.length, 2, 'the seller should have an issuance and a send')
    assert.deepEqual(
      [...history].sort().map((t) => t.kind).sort(),
      ['Issuance', 'Send'])
  })

  await step('the page raised no runtime error', () => assert.deepEqual(errors, []))

  console.log(`\n${passed.length} steps passed.\n`)
} catch (error) {
  // Always the message: a test that fails without saying why is worse than no test.
  console.error(`\n${error.message || error}`)
  console.error(`\n${passed.length} steps passed before the failure.\n`)
  process.exitCode = 1

  if (!(error instanceof assert.AssertionError)) console.error(error.stack)
} finally {
  await browser?.close()
  server?.close()
}
