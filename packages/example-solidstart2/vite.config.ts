import type { Alias, Plugin } from 'vite'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { solidStart } from '@solidjs/start/config'
import { nitroV2Plugin } from '@solidjs/vite-plugin-nitro-2'
import UnoCSS from 'unocss/vite'
import { defineConfig, loadEnv } from 'vite'

const solidPackages = ['solid-js', '@solidjs/signals', '@solidjs/web'] as const
const envDir = fileURLToPath(new URL('.', import.meta.url))
type SolidStartCanaryOptions = NonNullable<Parameters<typeof solidStart>[0]> & { devOverlay?: boolean }

function packagePath(name: string): string {
  return fileURLToPath(new URL(`./node_modules/${name}`, import.meta.url))
}

function packageAliases(name: string): Alias[] {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const root = packagePath(name)

  return [
    { find: new RegExp(`^${escaped}$`), replacement: root },
    { find: new RegExp(`^${escaped}/(.*)$`), replacement: `${root}/$1` },
  ]
}

function normalizeSolidStartRouteIds(): Plugin {
  return {
    name: 'example-solidstart2-normalize-route-ids',
    enforce: 'post',
    transform(code, id) {
      if (id !== 'solid-start:routes')
        return

      return {
        code: code.replace(/\\\\/g, '/'),
        map: null,
      }
    },
  }
}

function solidStartCanary() {
  const options: SolidStartCanaryOptions = {
    devOverlay: false,
    middleware: './src/middleware.ts',
    solid: {
      refresh: {
        disabled: true,
      },
    },
  }

  return solidStart(options)
}

function loadServerEnv(mode: string): void {
  const env = loadEnv(mode, envDir, '')
  for (const [key, value] of Object.entries(env))
    process.env[key] ??= value
}

export default defineConfig(({ mode }) => {
  loadServerEnv(mode)

  return {
    resolve: {
      alias: solidPackages.flatMap(packageAliases),
      dedupe: ['solid-js', '@solidjs/signals', '@solidjs/web', '@solidjs/router', '@solidjs/meta'],
      preserveSymlinks: false,
    },
    optimizeDeps: {
      exclude: ['@rttnd/gau'],
    },
    ssr: {
      external: ['drizzle-orm'],
    },
    plugins: [
      UnoCSS() as any,
      solidStartCanary(),
      normalizeSolidStartRouteIds(),
      nitroV2Plugin({
        externals: {
          trace: false,
        },
        esbuild: {
          options: {
            target: 'es2022',
          },
        },
      }),
    ],
  }
})
