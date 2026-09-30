import { defineConfig } from 'unocss'
import base from '../../uno.config'
import { providers } from './src/client/providers'

export default defineConfig({
  ...base,
  safelist: Object.values(providers).map((provider) => provider.icon),
  content: { filesystem: ['src/**/*.{astro,svelte,ts}'] },
})
