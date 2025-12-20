/* eslint-disable no-console */
import { rm } from 'node:fs/promises'
import { relative, sep } from 'node:path'
import process from 'node:process'

console.log('Scanning for node_modules...')

const root = process.cwd()
const glob = new Bun.Glob('**/node_modules')
const foundDirs: string[] = []

for await (const path of glob.scan({ cwd: root, onlyFiles: false, absolute: true })) {
  if (!path.endsWith('node_modules'))
    continue
  foundDirs.push(path)
}

const toDelete = foundDirs.filter((dir) => {
  return !foundDirs.some(parent => parent !== dir && dir.startsWith(parent + sep))
})

if (toDelete.length === 0) {
  console.log('No node_modules found.')
  process.exit(0)
}

console.log(`Found ${toDelete.length} node_modules directories to delete.`)

const totalStart = performance.now()
let completed = 0

await Promise.all(toDelete.map(async (dir) => {
  const rel = relative(root, dir)
  const start = performance.now()
  try {
    await rm(dir, { recursive: true, force: true })
    const end = performance.now()
    completed++
    console.log(`[${completed}/${toDelete.length}] Deleted ${rel} (${((end - start) / 1000).toFixed(2)}s)`)
  }
  catch (e) {
    completed++
    console.log(`[${completed}/${toDelete.length}] Failed: ${rel}`)
    console.error(e)
  }
}))

const totalEnd = performance.now()
console.log(`Cleanup complete! Total: ${((totalEnd - totalStart) / 1000).toFixed(2)}s`)

