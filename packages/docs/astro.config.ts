import { fileURLToPath } from 'node:url'
import tailwindcss from '@tailwindcss/vite'
import nimbus, { defineConfig as defineNimbusConfig } from '@cloudflare/nimbus-docs'
import { tableScroll } from '@cloudflare/nimbus-docs/markdown'
import { defineConfig } from 'astro/config'
import type { AstroUserConfig } from 'astro'

type AstroVitePlugins = NonNullable<NonNullable<AstroUserConfig['vite']>['plugins']>

// Vite 8 is aliased to Vite+ in this workspace; bridge the two plugin type definitions here.
const vitePlugins = [tailwindcss()] as unknown as AstroVitePlugins

const nimbusConfig = defineNimbusConfig({
  site: 'https://gau.rettend.me',
  title: 'gau',
  description: 'A small, framework-agnostic OAuth library for Bun, Node, Deno, Cloudflare Workers, and Tauri.',
  locale: 'en',
  homeLabel: 'gau',
  github: 'https://github.com/Rettend/gau',
  editPattern: 'https://github.com/Rettend/gau/edit/main/packages/docs/{path}',
  socialImageAlt: 'gau documentation preview',
  head: [
    {
      tag: 'meta',
      attrs: {
        name: 'theme-color',
        content: '#f5fbf9',
        media: '(prefers-color-scheme: light)',
      },
    },
    {
      tag: 'meta',
      attrs: {
        name: 'theme-color',
        content: '#0b100e',
        media: '(prefers-color-scheme: dark)',
      },
    },
  ],
  sidebar: {
    scope: 'full',
    items: [
      {
        label: 'Guides',
        icon: 'ph:rocket-launch-duotone',
        items: [
          { label: 'Getting Started', link: '/guides/getting-started/' },
          { label: 'Configuration', link: '/guides/configuration/' },
          { label: 'Session Management', link: '/guides/session-management/' },
          { label: 'Account Linking', link: '/guides/account-linking/' },
          { label: 'Refresh Tokens', link: '/guides/refresh-tokens/' },
          { label: 'Middleware', link: '/guides/middleware/' },
          { label: 'Protected Routes', link: '/guides/protected-routes/' },
          {
            label: 'Role-Based Access Control',
            link: '/guides/role-based-access-control/',
          },
          { label: 'Hooks', link: '/guides/hooks/' },
          { label: 'Error Handling', link: '/guides/error-handling/' },
          { label: 'Security', link: '/guides/security/' },
        ],
      },
      {
        label: 'Framework Integrations',
        icon: 'ph:puzzle-piece-duotone',
        items: [
          { label: 'Integrations', link: '/integrations/' },
          { label: 'SvelteKit', link: '/integrations/sveltekit/' },
          { label: 'SolidStart', link: '/integrations/solidstart/' },
          { label: 'Marko', link: '/integrations/marko/' },
          { label: 'Astro', link: '/integrations/astro/' },
          { label: 'Vanilla', link: '/integrations/vanilla/' },
          { label: 'Bun.serve', link: '/integrations/bun-serve/' },
          { label: 'Elysia', link: '/integrations/elysia/' },
        ],
      },
      {
        label: 'Database Adapters',
        icon: 'ph:database-duotone',
        items: [
          { label: 'Adapters', link: '/adapters/' },
          { label: 'Drizzle', link: '/adapters/drizzle/' },
        ],
      },
      {
        label: 'Runtimes',
        icon: 'ph:cpu-duotone',
        items: [
          { label: 'Runtimes', link: '/runtimes/' },
          { label: 'Tauri', link: '/runtimes/tauri/' },
        ],
      },
      {
        label: 'Providers',
        icon: 'ph:plugs-duotone',
        items: [
          { label: 'Providers', link: '/providers/' },
          { label: 'Email', link: '/providers/email/' },
          { label: 'GitHub', link: '/providers/github/' },
          { label: 'Discord', link: '/providers/discord/' },
          { label: 'Google', link: '/providers/google/' },
          { label: 'ChatGPT', link: '/providers/chatgpt/' },
          { label: 'Microsoft', link: '/providers/microsoft/' },
          { label: 'Facebook', link: '/providers/facebook/' },
        ],
      },
      {
        label: 'Advanced',
        icon: 'ph:head-circuit-duotone',
        items: [
          { label: 'Overview', link: '/advanced/' },
          {
            label: 'User Impersonation',
            link: '/advanced/user-impersonation/',
          },
          {
            label: 'Xbox / Minecraft',
            link: '/advanced/xbox-minecraft/',
          },
        ],
      },
      {
        label: 'Reference',
        icon: 'ph:code-duotone',
        items: [
          { label: 'Core API', link: '/reference/core-api/' },
          { label: 'CLI', link: '/reference/cli/' },
        ],
      },
    ],
  },
})

const markdownLink = (title: string, href: string) =>
  `[${title.replace(/([\\[\]])/g, '\\$1')}](${href.replace(/\)/g, '%29')})`

export default defineConfig({
  output: 'static',
  vite: {
    plugins: vitePlugins,
    resolve: {
      alias: {
        '~': fileURLToPath(new URL('./src', import.meta.url)),
        '@': fileURLToPath(new URL('./src', import.meta.url)),
      },
    },
  },
  prefetch: {
    prefetchAll: true,
    defaultStrategy: 'hover',
  },
  integrations: [
    nimbus(nimbusConfig, {
      rules: {
        'nimbus/frontmatter-shape': 'error',
        'nimbus/internal-link': 'error',
        'nimbus/redirected-link': 'error',
        'nimbus/image-ref': 'error',
      },
      markdown: {
        hastPlugins: [tableScroll()],
        features: { headingAttributes: true },
        componentMap: {
          IconLink: {
            revision: 'gau-icon-link-v1',
            render: ({ attrs, children }) => {
              const href = typeof attrs.href === 'string' ? attrs.href : ''
              const title = typeof attrs.title === 'string' ? attrs.title : children.trim() || 'Link'
              if (!href) return title
              return markdownLink(title, href)
            },
          },
          IconLinkGroup: {
            revision: 'gau-icon-link-group-v1',
            render: ({ children }) => children,
          },
        },
      },
    }),
  ],
})
