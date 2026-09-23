'use strict'

import { createServer } from 'node:http'
import { createReadStream, existsSync, statSync } from 'node:fs'
import { dirname, join, normalize } from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterAll, beforeAll, describe, expect, test } from '@jest/globals'

import { chromium } from 'playwright'

import { buildExample } from '../../examples/browser/build.js'

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'examples', 'browser')

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.wasm': 'application/wasm' }

// A path on this test's own server that answers 404. The wallet must open anyway: the
// snapshot, not the indexer, is what holds the address and the assets.
const NOT_AN_INDEXER = '/not-an-indexer'

let server, browser, page, result

const pageErrors = []

function serve () {
  const server = createServer((req, res) => {
    const path = req.url.split('?')[0]
    const url = path === '/' ? '/index.html' : path
    const file = join(root, normalize(url).replace(/^(\.\.[/\\])+/, ''))

    if (!existsSync(file) || !statSync(file).isFile()) {
      res.writeHead(404)
      res.end()
      return
    }

    res.writeHead(200, { 'content-type': TYPES[file.slice(file.lastIndexOf('.'))] ?? 'application/octet-stream' })
    createReadStream(file).pipe(res)
  })

  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)))
}

describe('an RGB wallet in a browser', () => {
  beforeAll(async () => {
    await buildExample()

    server = await serve()

    browser = await chromium.launch()
    page = await browser.newPage()
    page.on('pageerror', (error) => pageErrors.push(String(error)))

    // The page runs itself, once, against the indexer named in the query string. Driving it
    // from here with a second call would open a second wallet over the same snapshot.
    const origin = `http://127.0.0.1:${server.address().port}`

    await page.goto(`${origin}/?esplora=${encodeURIComponent(origin + NOT_AN_INDEXER)}`)

    // goto resolves on load, which is before the module has run.
    await page.waitForFunction(() => globalThis.rgbExample !== undefined)

    result = await page.evaluate(() => globalThis.rgbExample)
  }, 180000)

  afterAll(async () => {
    await browser?.close()
    await new Promise((resolve) => server?.close(resolve))
  })

  test('derives a taproot address from the wallet rgb-lib opened', () => {
    expect(result.addressIsTaproot).toBe(true)
    expect(result.address).toMatch(/^tb1p[0-9a-z]+$/)
  })

  test('reads balances, assets and transfers from the snapshot with no indexer', () => {
    expect(result.vanillaSettled).toBe('0')
    expect(result.assets).toBe(0)
    expect(result.transfers).toBe(0)
    expect(result.slots).toBe(0)
  })

  test('signs a message with the wallet itself, which needs no chain', () => {
    expect(result.signedBy).toBe(result.address)

    // A BIP-322 simple signature for a taproot key-path spend: one witness item, a 64-byte
    // Schnorr signature, so 1 + 1 + 64 bytes once the stack is serialised.
    const witness = Uint8Array.from(atob(result.signature), (c) => c.charCodeAt(0))

    expect(witness[0]).toBe(1)
    expect(witness[1]).toBe(64)
    expect(witness.length).toBe(66)
  })

  test('says what is missing rather than failing silently', () => {
    expect(result.failures.receive).toMatch(/indexer is unreachable/i)
    expect(result.failures.witnessReceive).toMatch(/indexer is unreachable/i)
    expect(result.failures.issue).toMatch(/needs 1 free slots/i)
  })

  test('loads without a runtime error', () => {
    expect(pageErrors).toEqual([])
  })
})
