import { getLlmsPayload } from '@cloudflare/nimbus-docs/agent-endpoints'

export const prerender = true

/**
 * Compatibility alias for the former Starlight llms plugin.
 *
 * Nimbus publishes /llms.txt and /llms-full.txt. The old docs site also
 * advertised /llms-small.txt, so serve the complete payload there rather
 * than leave an existing URL broken.
 */
export async function GET() {
  const payload = await getLlmsPayload({ scope: 'site', surface: 'full' })

  if (!payload) {
    return new Response('Not found', { status: 404 })
  }

  return new Response(payload.body, {
    headers: { 'Content-Type': payload.mediaType },
  })
}
