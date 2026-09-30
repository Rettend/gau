import { fileURLToPath } from 'node:url'
import { createHandler } from '@rttnd/gau/core'
import { auth } from './auth'
import { createPages } from '../../example-shared/pages'

async function buildClientBundle() {
  const entry = fileURLToPath(new URL('../src/client.ts', import.meta.url))
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
    for (const log of result.logs) console.error(log)
    throw new Error('client bundle build failed')
  }
}

await buildClientBundle()

const handler = createHandler(auth)

const pages = createPages(auth, 'bun')
const styles = Bun.file(fileURLToPath(new URL('../../example-shared/styles.css', import.meta.url)))
const clientJs = Bun.file(fileURLToPath(new URL('../public/client.js', import.meta.url)))

const server = Bun.serve({
  routes: {
    '/api/auth/*': handler,
    '/client.js': () => new Response(clientJs, { headers: { 'content-type': 'text/javascript; charset=utf-8' } }),
    '/styles.css': () => new Response(styles, { headers: { 'content-type': 'text/css; charset=utf-8' } }),
    '/': pages,
    '/account': pages,
    '/protected': pages,
    '/auth/error': pages,
  },
})

console.log(`Server listening on ${server.url.hostname}:${server.url.port}`)
