import {
  getMarkdownPayload,
  getMarkdownStaticPaths,
  type MarkdownEndpointReference,
} from '@cloudflare/nimbus-docs/agent-endpoints'
import type { APIRoute } from 'astro'

export const prerender = true

/**
 * Legacy flat Markdown URL: /guides/getting-started.md
 *
 * The canonical Nimbus route at /guides/getting-started/index.md remains the
 * source of truth. Both routes read the same prepared payload, so the two
 * responses are byte-identical.
 */
export async function getStaticPaths() {
  const paths = await getMarkdownStaticPaths({
    collection: 'docs',
    surface: 'markdown',
  })

  return paths.flatMap(({ params, props }) => (params.slug ? [{ params: { slug: params.slug }, props }] : []))
}

export const GET: APIRoute = async ({ props }) => {
  const reference = props.reference as MarkdownEndpointReference
  const payload = await getMarkdownPayload({
    collection: reference.collection,
    surface: 'markdown',
    reference,
  })

  if (!payload) {
    return new Response('Not found', { status: 404 })
  }

  return new Response(payload.body, {
    headers: { 'Content-Type': payload.mediaType },
  })
}
