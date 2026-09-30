import process from 'node:process'
import { fileURLToPath } from 'node:url'
import marko from '@marko/run/vite'
import UnoCSS from '@unocss/vite'
import { defineConfig, loadEnv } from 'vite-plus'

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, fileURLToPath(new URL('.', import.meta.url)), '')
  for (const [key, value] of Object.entries(env)) process.env[key] ??= value
  return { plugins: [UnoCSS(), marko()] }
})
