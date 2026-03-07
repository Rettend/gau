/* eslint-disable no-console */
import type { Options } from 'tsup'
import { createRequire } from 'node:module'
import { mkdir, unlink } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { $, Glob, write } from 'bun'
import { emitDts } from 'svelte2tsx'
import { defineConfig } from 'tsup'

const require = createRequire(import.meta.url)

const commonConfig = {
  format: ['esm'],
  target: 'node20',
  splitting: true,
  sourcemap: true,
  dts: false,
  clean: true,
  outDir: 'dist',
  minify: 'terser',
  terserOptions: {
    mangle: {
      reserved: ['$'],
    },
    format: {
      comments: /@vite-ignore/,
    },
  },
} satisfies Options

function toEntryObject(paths: string[]) {
  return paths.reduce<Record<string, string>>((acc, path) => {
    const entryName = path.replace(/\.(ts|tsx|svelte|svelte\.ts)$/, '')
    acc[entryName] = path
    return acc
  }, {})
}

async function generateSvelteDeclarations() {
  const currentCwd = process.cwd()
  process.chdir(resolve('src/client/svelte'))

  try {
    await emitDts({
      libRoot: '.',
      declarationDir: '../../../dist/src/client/svelte',
      tsconfig: 'tsconfig.json',
      svelteShimsPath: require.resolve('svelte2tsx/svelte-shims-v4.d.ts'),
    })
  }
  finally {
    process.chdir(currentCwd)
  }
}

export default defineConfig(async () => {
  const glob = new Glob('src/**/index.{ts,tsx,svelte,svelte.ts}')
  let allEntries = await Array.fromAsync(glob.scan('.'))

  allEntries = allEntries.filter(e => !/\.test\.(?:ts|tsx|svelte|svelte\.ts)$/.test(e))

  const solidEntries = allEntries.filter(e => /src[\\/]client[\\/]solid[\\/]index\.(?:ts|tsx)$/.test(e))
  const svelteTsEntries = allEntries.filter(e => /src[\\/]client[\\/]svelte[\\/].*\.svelte\.ts$/.test(e))
  const svelteComponentEntries = allEntries.filter(e => /src[\\/]client[\\/]svelte[\\/].*\.svelte$/.test(e))

  const otherEntries = allEntries.filter(
    e => !solidEntries.includes(e) && !svelteTsEntries.includes(e) && !svelteComponentEntries.includes(e),
  )

  return [
    {
      ...commonConfig,
      entry: toEntryObject(otherEntries),
      external: [
        '@sveltejs/kit',
        '$app/navigation',
        '@solidjs/router',
        '@tauri-apps/plugin-opener',
        '@tauri-apps/api/event',
      ],
      async onSuccess() {
        console.log('⚡️ Generating .d.ts files with tsgo...')
        await Promise.all([
          $`bun tsgo --project tsconfig.json --outDir dist/src`,
          $`bun tsgo --project src/client/solid/tsconfig.json`,
        ])
        console.log('⚡️ Generating Svelte .d.ts files with svelte2tsx...')
        await generateSvelteDeclarations()
        console.log('✅ Successfully generated .d.ts files.')

        const dtsGlob = new Glob('src/**/*.d.ts{,.map}')
        const dtsFiles = await Array.fromAsync(dtsGlob.scan('.'))
        if (dtsFiles.length > 0) {
          console.log(`🧹 Cleaning up ${dtsFiles.length} errant .d.ts files from src...`)
          await Promise.all(dtsFiles.map(f => unlink(f)))
          console.log('✅ Cleanup complete.')
        }
        for (const path of svelteComponentEntries) {
          const file = Bun.file(path)
          const outPath = path.replace(/^src/, 'dist/src')
          await mkdir(dirname(outPath), { recursive: true })
          await write(outPath, await file.text())
        }
      },
    },
    {
      ...commonConfig,
      entry: toEntryObject(solidEntries),
      tsconfig: 'src/client/solid/tsconfig.json',
      splitting: false,
      external: [
        '@solidjs/router',
        '@tauri-apps/plugin-opener',
        '@tauri-apps/api/event',
      ],
      esbuildOptions(options) {
        options.jsx = 'preserve'
        options.jsxImportSource = 'solid-js'
      },
      outExtension() {
        return { js: '.jsx' }
      },
    },
    {
      ...commonConfig,
      splitting: false,
      minify: 'terser',
      entry: toEntryObject(svelteTsEntries),
      tsconfig: 'src/client/svelte/tsconfig.json',
      external: [
        '@sveltejs/kit',
        '$app/navigation',
        '@tauri-apps/plugin-opener',
        '@tauri-apps/api/event',
      ],
      outExtension() {
        return { js: '.svelte.js' }
      },
    },
  ]
})
