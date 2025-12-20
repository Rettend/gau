import { defineConfig } from '@solidjs/start/config'
import UnoCSS from 'unocss/vite'

export default defineConfig({
  server: {
    preset: 'cloudflare-module',
  },
  middleware: 'src/middleware.ts',
  vite: {
    plugins: [UnoCSS() as any],
    optimizeDeps: {
      exclude: ['@rttnd/gau'],
    },
    ssr: { external: ['drizzle-orm'] },
  },
})
