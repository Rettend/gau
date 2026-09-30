import type { UserConfig as PackConfig } from 'vite-plus/pack'
import { execFile } from 'node:child_process'
import { copyFile, glob, mkdir, unlink } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import process from 'node:process'
import { promisify } from 'node:util'
import { emitDts } from 'svelte2tsx'
import { defineConfig } from 'vite-plus'

const require = createRequire(import.meta.url)
const exec = promisify(execFile)

const commonConfig = {
  format: ['esm'],
  target: 'node20',
  sourcemap: true,
  dts: false,
  clean: true,
  outDir: 'dist',
  fixedExtension: false,
  minify: true,
} satisfies PackConfig

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
  } finally {
    process.chdir(currentCwd)
  }
}

export default defineConfig(async () => {
  let allEntries = (await Array.fromAsync(glob('src/**/index.{ts,tsx,svelte,svelte.ts}'))).map((path) =>
    path.replaceAll('\\', '/'),
  )

  allEntries = allEntries.filter((e) => !/\.test\.(?:ts|tsx|svelte|svelte\.ts)$/.test(e))

  const solidEntries = allEntries.filter((e) => /src[\\/]client[\\/]solid[\\/]index\.(?:ts|tsx)$/.test(e))
  const solid2Entries = allEntries.filter((e) => /src[\\/]client[\\/]solid2[\\/]index\.(?:ts|tsx)$/.test(e))
  const svelteTsEntries = allEntries.filter((e) => /src[\\/]client[\\/]svelte[\\/].*\.svelte\.ts$/.test(e))
  const svelteComponentEntries = allEntries.filter((e) => /src[\\/]client[\\/]svelte[\\/].*\.svelte$/.test(e))

  const otherEntries = allEntries.filter(
    (e) =>
      !solidEntries.includes(e) &&
      !solid2Entries.includes(e) &&
      !svelteTsEntries.includes(e) &&
      !svelteComponentEntries.includes(e),
  )

  return {
    run: {
      tasks: {
        bundle: {
          command: 'vp pack',
          cache: {
            env: ['NODE_ENV'],
            input: [
              'src/**',
              'package.json',
              'tsconfig.json',
              'vite.config.ts',
              { pattern: 'bun.lock', base: 'workspace' },
              { pattern: 'package.json', base: 'workspace' },
              { pattern: '.node-version', base: 'workspace' },
            ],
            output: ['dist/**', 'client/marko/**'],
          },
        },
      },
    },
    pack: [
      {
        ...commonConfig,
        entry: toEntryObject(otherEntries),
        plugins: [
          {
            name: 'watch-framework-sources',
            async buildStart() {
              // Refresh declarations and copied components on client-only edits too.
              for await (const file of glob('src/**/*.{ts,tsx,svelte,marko}', {
                exclude: ['**/.svelte-kit/**', '**/*.d.ts'],
              }))
                this.addWatchFile(resolve(file))
            },
          },
        ],
        deps: {
          neverBundle: [
            '@sveltejs/kit',
            '$app/navigation',
            '@solidjs/router',
            '@solidjs/web',
            '@tauri-apps/plugin-opener',
            '@tauri-apps/api/event',
          ],
        },
        async onSuccess() {
          console.log('⚡️ Generating .d.ts files with tsgo...')
          await Promise.all([
            exec('bun', ['tsgo', '--project', 'tsconfig.json', '--outDir', 'dist/src']),
            exec('bun', ['tsgo', '--project', 'src/client/solid/tsconfig.json']),
            exec('bun', ['tsgo', '--project', 'src/client/solid2/tsconfig.json']),
            exec('bun', ['tsgo', '--project', 'src/client/marko/tsconfig.json']),
          ])
          console.log('⚡️ Generating Svelte .d.ts files with svelte2tsx...')
          await generateSvelteDeclarations()
          await exec('bun', ['run', 'marko-type-check', '-p', 'src/client/marko/tsconfig.tags.json'])
          console.log('✅ Successfully generated .d.ts files.')

          const dtsFiles = await Array.fromAsync(glob('src/**/*.d.ts{,.map}'))
          if (dtsFiles.length > 0) {
            console.log(`🧹 Cleaning up ${dtsFiles.length} errant .d.ts files from src...`)
            await Promise.all(dtsFiles.map((f) => unlink(f)))
            console.log('✅ Cleanup complete.')
          }
          for (const path of svelteComponentEntries) {
            const outPath = path.replace(/^src/, 'dist/src')
            await mkdir(dirname(outPath), { recursive: true })
            await copyFile(path, outPath)
          }
          for await (const path of glob('src/client/marko/*.marko')) {
            const outPath = path.replace(/^src/, 'dist/src')
            await mkdir(dirname(outPath), { recursive: true })
            await copyFile(path, outPath)
          }
          // Marko's type checker resolves tag imports by physical package path.
          await mkdir('client/marko', { recursive: true })
          await copyFile('src/client/marko/Auth.marko', 'client/marko/Auth.marko')
          await copyFile('dist/src/client/marko/Auth.d.marko', 'client/marko/Auth.d.marko')
        },
      },
      {
        ...commonConfig,
        entry: toEntryObject(solidEntries),
        tsconfig: 'src/client/solid/tsconfig.json',
        minify: false,
        deps: { neverBundle: ['@solidjs/router', '@tauri-apps/plugin-opener', '@tauri-apps/api/event'] },
        outExtensions() {
          return { js: '.jsx' }
        },
      },
      {
        ...commonConfig,
        entry: toEntryObject(solid2Entries),
        tsconfig: 'src/client/solid2/tsconfig.json',
        minify: false,
        deps: {
          neverBundle: [
            '@solidjs/router',
            '@solidjs/web',
            '@tauri-apps/plugin-opener',
            '@tauri-apps/api/event',
            'solid-js',
          ],
        },
        outExtensions() {
          return { js: '.jsx' }
        },
      },
      {
        ...commonConfig,
        // Keep rune names intact for the consuming app's Svelte compiler.
        minify: false,
        entry: toEntryObject(svelteTsEntries),
        tsconfig: 'src/client/svelte/tsconfig.json',
        deps: {
          neverBundle: ['@sveltejs/kit', '$app/navigation', '@tauri-apps/plugin-opener', '@tauri-apps/api/event'],
        },
        outExtensions() {
          return { js: '.svelte.js' }
        },
      },
    ],
  }
})
