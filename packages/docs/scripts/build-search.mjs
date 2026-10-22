import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const dist = resolve(packageRoot, 'dist')
const output = resolve(dist, 'pagefind', 'pagefind.js')

// Nimbus runs Pagefind itself. On Windows it looks for a pagefind.cmd shim
// that Bun doesn't create, so finish the index here when it's still missing.
if (!existsSync(output)) {
  const runner = resolve(packageRoot, 'node_modules/pagefind/lib/runner/bin.cjs')
  const result = spawnSync(process.execPath, [runner, '--site', dist], {
    cwd: packageRoot,
    stdio: 'inherit',
  })

  if (result.error) throw result.error
  if (result.status !== 0) process.exit(result.status ?? 1)
}
