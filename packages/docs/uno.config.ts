import fs from 'node:fs/promises'
import { presetStarlightIcons } from 'starlight-plugin-icons/uno'
import { defineConfig, presetIcons } from 'unocss'

export default defineConfig({
  safelist: [
    'light:i-vscode-icons:file-type-light-astro',
    'sidebar-active-dark:i-vscode-icons:file-type-light-astro',
    'sidebar-active-light:i-vscode-icons:file-type-astro',
  ],
  variants: [
    (matcher) => {
      for (const theme of ['dark', 'light']) {
        const prefix = `sidebar-active-${theme}:`
        if (matcher.startsWith(prefix)) {
          return {
            matcher: matcher.slice(prefix.length),
            selector: selector => `html[data-theme="${theme}"] a[aria-current="page"] ${selector}`,
          }
        }
      }
      if (matcher.startsWith('light:')) {
        return {
          matcher: matcher.slice(6),
          selector: selector => `html[data-theme="light"] ${selector}`,
        }
      }
    },
  ],
  presets: [
    presetStarlightIcons(),
    presetIcons({
      collections: {
        icons: {
          drizzle: () => fs.readFile('./src/assets/adapters/drizzle.svg', 'utf-8'),
          elysia: () => fs.readFile('./src/assets/integrations/elysia.svg', 'utf-8'),
        },
        bigicons: {
          discord: () => fs.readFile('./src/assets/providers/discord.svg', 'utf-8'),
        },
      },
      extraProperties: {
        'display': 'inline-block',
        'vertical-align': 'middle',
      },
      customizations: {
        iconCustomizer(collection, _icon, props) {
          if (['devicon', 'simple-icons', 'logos'].includes(collection))
            props.transform = 'scale(0.8)'

          if (collection === 'icons')
            props.transform = 'scale(0.8)'

          if (collection === 'bigicons')
            props.transform = 'scale(0.9)'
        },
      },
    }),
  ],
})
