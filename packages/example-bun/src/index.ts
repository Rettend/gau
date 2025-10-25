import { fileURLToPath } from 'node:url'
import { createHandler } from '@rttnd/gau/core'
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

const indexHtml = Bun.file(fileURLToPath(new URL('../index.html', import.meta.url)))
const clientJs = Bun.file(fileURLToPath(new URL('../public/client.js', import.meta.url)))

const server = Bun.serve({
  routes: {
    '/api/auth/*': handler,
    '/client.js': () => new Response(clientJs, { headers: { 'content-type': 'text/javascript; charset=utf-8' } }),
    '/': () => new Response(indexHtml, { headers: { 'content-type': 'text/html; charset=utf-8' } }),
  },
})

// eslint-disable-next-line no-console
console.log(`Server listening on ${server.url.hostname}:${server.url.port}`)
