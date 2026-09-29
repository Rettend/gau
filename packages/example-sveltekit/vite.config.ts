import { sveltekit } from '@sveltejs/kit/vite'
import UnoCSS from '@unocss/vite'
import { defineConfig } from 'vite-plus'

export default defineConfig({
  plugins: [UnoCSS(), sveltekit()],
})
