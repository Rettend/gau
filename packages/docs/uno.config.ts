import fs from 'node:fs/promises'
import { presetStarlightIcons } from 'starlight-plugin-icons/uno'
import { defineConfig, presetIcons } from 'unocss'

export default defineConfig({
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
        iconCustomizer(collection, icon, props) {
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
