'use strict'

import { describe, expect, test } from '@jest/globals'

import { retryWhenBusy } from '../src/engine.js'

// A wallet shared with a Lightning node in the same module refuses a call while the node holds
// it. The refusal comes before the binding does anything, so retrying that one call is safe.

const BUSY = 'RGB wallet is busy with another operation; retry shortly'

const walletRefusing = (times, { async = false } = {}) => {
  const wallet = {
    calls: 0,
    tag: 'raw',
    read () {
      this.calls += 1
      if (this.calls <= times) {
        if (async) return Promise.reject(BUSY)
        throw BUSY
      }
      return async ? Promise.resolve(`ok:${this.tag}`) : `ok:${this.tag}`
    }
  }
  return wallet
}

describe('retryWhenBusy', () => {
  test('a call that is not refused returns as it would unwrapped, synchronously', () => {
    const w = retryWhenBusy(walletRefusing(0))

    expect(w.read()).toBe('ok:raw')
  })

  test('a refused synchronous call is retried until the wallet is free', async () => {
    const raw = walletRefusing(3)
    const w = retryWhenBusy(raw)

    await expect(w.read()).resolves.toBe('ok:raw')
    expect(raw.calls).toBe(4)
  })

  test('a refused asynchronous call is retried the same way', async () => {
    const raw = walletRefusing(2, { async: true })

    await expect(retryWhenBusy(raw).read()).resolves.toBe('ok:raw')
    expect(raw.calls).toBe(3)
  })

  test('any other error is not retried', async () => {
    let calls = 0
    const w = retryWhenBusy({ fail () { calls += 1; throw new Error('Insufficient allocations') } })

    expect(() => w.fail()).toThrow('Insufficient allocations')
    expect(calls).toBe(1)
  })

  test('methods run on the wallet itself, and plain properties pass through', () => {
    const raw = walletRefusing(0)
    const w = retryWhenBusy(raw)

    expect(w.tag).toBe('raw')
    w.read()
    expect(raw.calls).toBe(1)
  })
})
