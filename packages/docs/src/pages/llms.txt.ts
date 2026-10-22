import { getIndexedEntries } from '@cloudflare/nimbus-docs/runtime'
import { config } from 'virtual:nimbus/config'

export const prerender = true

const site = config.site.replace(/\/+$/, '')

function absoluteUrl(path: string): string {
  return `${site}${path.startsWith('/') ? path : `/${path}`}`
}

/**
 * The old llms.txt listed every page's Markdown file. Nimbus groups large
 * sections into /<section>/llms.txt indexes, so build the flat list here to
 * keep every per-page Markdown URL discoverable from the root index.
 */
export async function GET() {
  const entries = (await getIndexedEntries()).sort((a, b) => a.markdownUrl.localeCompare(b.markdownUrl))

  const body = [
    `# ${config.title}`,
    '',
    `> ${config.description ?? 'Documentation index for AI agents.'}`,
    '',
    '## Documentation sets',
    '',
    `- [Complete documentation](${absoluteUrl('/llms-full.txt')})`,
    '',
    '## Pages',
    '',
    ...entries.map((entry) => {
      const description = entry.description ? ` — ${entry.description}` : ''
      return `- [${entry.title}](${absoluteUrl(entry.markdownUrl)})${description}`
    }),
    '',
  ].join('\n')

  return new Response(body, {
    headers: { 'Content-Type': 'text/plain; charset=utf-8' },
  })
}
