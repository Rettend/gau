import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

describe('d1 drizzle adapter', () => {
  it('supports create and update writes in Miniflare', () => {
    const fixture = fileURLToPath(new URL('./d1.integration.ts', import.meta.url))
    const result = spawnSync('bun', [fixture], {
      cwd: fileURLToPath(new URL('../../../../..', import.meta.url)),
      encoding: 'utf8',
      timeout: 30000,
    })

    const output = [result.error?.message, result.stderr, result.stdout].filter(Boolean).join('\n')
    expect(result.status, output).toBe(0)
  }, 35000)
})
