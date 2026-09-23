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

import { copyFile, mkdir } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { build } from 'esbuild'

const here = dirname(fileURLToPath(import.meta.url))
const require = createRequire(import.meta.url)

/**
 * Bundles the example for the browser.
 *
 * A bundler is not optional here. bip39 is published as CommonJS, which no browser loads
 * natively, and the WebAssembly binary has to sit next to the bundle because the bindings
 * resolve it against `import.meta.url`.
 *
 * @returns {Promise<string>} The path of the bundle that was written.
 */
export async function buildExample () {
  const outdir = join(here, 'dist')
  const outfile = join(outdir, 'bundle.js')

  await mkdir(outdir, { recursive: true })

  await build({
    entryPoints: [join(here, 'main.js')],
    outfile,
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: 'es2022',
    inject: [join(here, 'buffer-shim.js')]
  })

  await copyFile(
    require.resolve('@utexo/rgb-lib-wasm/rgb_lib_wasm_bindings_bg.wasm'),
    join(outdir, 'rgb_lib_wasm_bindings_bg.wasm')
  )

  return outfile
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  buildExample().then((outfile) => console.log(`Built ${outfile}`))
}
