// @ts-check
import { fileURLToPath } from 'node:url'
import starlightLlmsTxt from '@rttnd/starlight-llms-txt'
import { defineConfig } from 'astro/config'
import Icons from 'starlight-plugin-icons'
import UnoCSS from 'unocss/astro'

export default defineConfig({
  site: 'https://gau.rettend.me',
  base: '/',
  vite: {
    resolve: {
      alias: {
        '~': fileURLToPath(new URL('./src', import.meta.url)),
      },
    },
  },
  integrations: [
    UnoCSS(),
    Icons({
      sidebar: true,
      codeblock: true,
      extractSafelist: true,
      starlight: {
        title: 'gau',
        plugins: [
          starlightLlmsTxt({
            generatePageMarkdown: true,
            markdownFilePattern: 'replace',
          }),
        ],
        social: [
          { icon: 'github', label: 'GitHub', href: 'https://github.com/Rettend/gau' },
          { icon: 'discord', label: 'Discord', href: 'https://discord.gg/FvVaUPhj3t' },
        ],
        customCss: ['@fontsource/inter/400.css', '@fontsource/inter/600.css', './src/styles/custom.css'],
        components: {
          Header: './src/components/starlight/Header.astro',
        },
        tableOfContents: { minHeadingLevel: 2, maxHeadingLevel: 5 },
        sidebar: [
          {
            label: 'Guides',
            items: [
              { icon: 'i-ph:rocket-launch-duotone', label: 'Getting Started', slug: 'guides/getting-started' },
              { icon: 'i-ph:lego-duotone', label: 'Configuration', slug: 'guides/configuration' },
              { icon: 'i-ph:cookie-duotone', label: 'Session Management', slug: 'guides/session-management' },
              { icon: 'i-ph:plugs-connected-duotone', label: 'Account Linking', slug: 'guides/account-linking' },
              { icon: 'i-ph:arrows-counter-clockwise-duotone', label: 'Refresh Tokens', slug: 'guides/refresh-tokens' },
              { icon: 'i-ph:rows-duotone', label: 'Middleware', slug: 'guides/middleware' },
              { icon: 'i-ph:folder-lock-duotone', label: 'Protected Routes', slug: 'guides/protected-routes' },
              { icon: 'i-ph:user-check-duotone', label: 'Role-Based Access Control', slug: 'guides/role-based-access-control' },
              { icon: 'i-ph:head-circuit-duotone', label: 'Advanced Use Cases', slug: 'guides/advanced' },
              { icon: 'i-ph:plug-duotone', label: 'Hooks', slug: 'guides/hooks' },
              { icon: 'i-ph:shield-warning-duotone', label: 'Error Handling', slug: 'guides/error-handling' },
              { icon: 'i-ph:shield-check-duotone', label: 'Security', slug: 'guides/security' },
            ],
          },
          {
            label: 'Framework Integrations',
            items: [
              { icon: 'i-ph:puzzle-piece-duotone', label: 'Integrations', slug: 'integrations' },
              { icon: 'i-material-icon-theme:svelte', label: 'SvelteKit', slug: 'integrations/sveltekit' },
              { icon: 'i-devicon:solidjs', label: 'SolidStart', slug: 'integrations/solidstart' },
              { icon: 'i-material-icon-theme:typescript', label: 'Vanilla', slug: 'integrations/vanilla' },
              { icon: 'i-logos:bun', label: 'Bun.serve', slug: 'integrations/bun-serve' },
              { icon: 'i-icons:elysia', label: 'Elysia', slug: 'integrations/elysia' },
            ],
          },
          {
            label: 'Database Adapters',
            items: [
              { icon: 'i-ph:database-duotone', label: 'Adapters', slug: 'adapters' },
              { icon: 'i-icons:drizzle', label: 'Drizzle', slug: 'adapters/drizzle' },
            ],
          },
          {
            label: 'Runtimes',
            items: [
              { icon: 'i-ph:cpu-duotone', label: 'Runtimes', slug: 'runtimes' },
              { icon: 'i-material-icon-theme:tauri', label: 'Tauri', slug: 'runtimes/tauri' },
            ],
          },
          {
            label: 'OAuth Providers',
            items: [
              { icon: 'i-ph:plugs-duotone', label: 'Providers', slug: 'providers' },
              { icon: 'i-simple-icons:github', label: 'GitHub', slug: 'providers/github' },
              { icon: 'i-bigicons:discord', label: 'Discord', slug: 'providers/discord' },
              { icon: 'i-logos:google-icon', label: 'Google', slug: 'providers/google' },
              { icon: 'i-logos:microsoft-icon', label: 'Microsoft', slug: 'providers/microsoft' },
              { icon: 'i-logos:facebook', label: 'Facebook', slug: 'providers/facebook' },
            ],
          },
          {
            label: 'Cookbook',
            items: [
              { icon: 'i-simple-icons:xbox', label: 'Xbox / Minecraft', slug: 'cookbook/xbox-minecraft' },
            ],
          },
          {
            label: 'Reference',
            items: [
              { icon: 'i-ph:code-duotone', label: 'Core API', slug: 'reference/core-api' },
              { icon: 'i-ph:terminal-window-duotone', label: 'CLI', slug: 'reference/cli' },
            ],
          },
        ],
      },
    }),
  ],
})
