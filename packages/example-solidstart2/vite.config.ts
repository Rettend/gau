import process from 'node:process'
import { fileURLToPath } from 'node:url'
import solid from '@solidjs/vite-plugin'
import { fileRoutes } from 'filesystem-routing/vite'
import UnoCSS from 'unocss/vite'
import { defineConfig, loadEnv } from 'vite'

const envDir = fileURLToPath(new URL('.', import.meta.url))

function loadServerEnv(mode: string): void {
  const env = loadEnv(mode, envDir, '')
  for (const [key, value] of Object.entries(env))
    process.env[key] ??= value
}

export default defineConfig(({ mode }) => {
  loadServerEnv(mode)

  return {
    resolve: {
      alias: {
        '~': fileURLToPath(new URL('./src', import.meta.url)),
      },
      // Keep linked workspace packages on this example's Solid 2 runtime
      // without bypassing browser/server package export conditions.
      dedupe: ['solid-js', '@solidjs/web', '@solidjs/router'],
    },
    plugins: [
      UnoCSS(),
      solid({
        start: {
          // The repository historically tracked this file with a lowercase name.
          app: './src/app.tsx',
          middleware: './src/middleware.ts',
        },
        ssr: true,
        serverFunctions: true,
        extensions: ['.jsx', '.tsx'],
      }),
      fileRoutes({ httpMethods: true }),
    ],
    build: {
      target: 'esnext',
    },
  }
})
