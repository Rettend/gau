import { fileURLToPath } from 'node:url'
import { defineConfig } from '@solidjs/start/config'
import UnoCSS from 'unocss/vite'

const solidRoot = fileURLToPath(new URL('./node_modules/solid-js', import.meta.url))

export default defineConfig({
  server: {
    preset: 'cloudflare-module',
  },
  middleware: 'src/middleware.ts',
  vite: {
    plugins: [UnoCSS() as any],
    resolve: {
      alias: {
        'solid-js': solidRoot,
      },
    },
    optimizeDeps: {
      exclude: ['@rttnd/gau'],
    },
    ssr: { external: ['drizzle-orm'] },
  },
})
