import { vitePreprocess } from '@sveltejs/vite-plugin-svelte'

/** @type {import('svelte').Config} */
const config = {
  preprocess: vitePreprocess(),
  compilerOptions: {
    experimental: {
      async: true,
    },
  },
}

export default config
