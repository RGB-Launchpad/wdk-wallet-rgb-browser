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

/**
 * Runs tasks one at a time, in the order they arrive.
 *
 * Every rgb-lib binding takes a mutable borrow of the wallet for the whole call, and the
 * async ones (`sync`, sends) hold it across their awaits. A second command arriving
 * mid-sync panics inside rgb-lib with a BorrowMutError, and a WebAssembly panic leaves the
 * engine unusable until the wallet is reopened. Callers cannot coordinate this themselves:
 * in a browser several views may hold the same account.
 *
 * A rejected task must not stall the queue, so the tail swallows the outcome; the caller
 * still receives the original promise.
 *
 * @returns {<T>(task: () => Promise<T> | T) => Promise<T>} The queueing function.
 */
export default function serialQueue () {
  let tail = Promise.resolve()

  return (task) => {
    const run = tail.then(task)
    tail = run.then(() => {}, () => {})
    return run
  }
}
