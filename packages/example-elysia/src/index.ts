import { fileURLToPath } from 'node:url'
import { createHandler } from '@rttnd/gau/core'
import { Elysia, file } from 'elysia'
import { auth } from './auth'

async function buildClientBundle() {
  const entry = fileURLToPath(new URL('./client.ts', import.meta.url))
  const outdir = fileURLToPath(new URL('../public', import.meta.url))

  const result = await Bun.build({
    entrypoints: [entry],
    outdir,
    format: 'esm',
    target: 'browser',
    minify: true,
  })

  if (!result.success) {
    console.error('Failed to build client bundle:')
    for (const log of result.logs)
      console.error(log)
    throw new Error('client bundle build failed')
  }
}

await buildClientBundle()

const handler = createHandler(auth)

const app = new Elysia()
  .mount(handler)
  .get('/', () => file('./index.html'))
  .get('/client.js', () => file('./public/client.js'))
  .listen(3000)

// eslint-disable-next-line no-console
console.log(`🦊 Elysia is running at ${app.server?.hostname}:${app.server?.port}`)
