import process from 'node:process'
import { sveltekit } from '@sveltejs/kit/vite'
import UnoCSS from 'unocss/vite'
import { defineConfig } from 'vite'

const host = process.env.TAURI_DEV_HOST
const isTauri = !!process.env.TAURI_ENV_PLATFORM
const devPort = 1420
const hmrPort = 1430

export default defineConfig({
  plugins: [sveltekit(), UnoCSS()],
  clearScreen: false,
  server: {
    port: isTauri ? devPort : 5173,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: 'ws',
          host,
          port: hmrPort,
        }
      : undefined,
  },
})
