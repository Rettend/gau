import solid2 from '@solidjs/vite-plugin'
import { svelte } from '@sveltejs/vite-plugin-svelte'
import solid from 'vite-plugin-solid'
import { defineConfig } from 'vite-plus'

const generatedFiles = [
  '**/dist/**',
  '**/build/**',
  '**/target/**',
  '**/.svelte-kit/**',
  '**/.astro/**',
  '**/.starlight-icons/**',
  '**/.vinxi/**',
  '**/.output/**',
  '**/public/client.js',
  '**/src-tauri/gen/**',
  'coverage/**',
]

export default defineConfig({
  // Compile framework sources so uncovered components appear in coverage too.
  plugins: [
    solid({ include: '**/src/client/solid/**/*.tsx', hot: false, ssr: true }),
    solid2({ include: '**/src/client/solid2/**/*.tsx', hot: false, ssr: true }),
    svelte({ configFile: false }),
  ],
  ssr: { external: ['$app/navigation'] },
  test: {
    environment: 'node',
    coverage: {
      enabled: true,
      provider: 'v8',
      reporter: ['text', 'html', ['json-summary', { file: '../coverage.json' }]],
      include: ['packages/gau/src/**/*.@(ts|tsx|svelte)'],
      exclude: [...generatedFiles, '**/*.d.ts', '**/migrations/**', '**/*.config.ts'],
    },
    projects: [
      {
        test: {
          name: 'fast',
          globals: true,
          include: ['packages/gau/test/**/*.test.{ts,tsx,svelte}'],
          exclude: ['packages/gau/test/adapters/drizzle/pg.test.ts'],
          environment: 'node',
          setupFiles: ['packages/gau/test/setup.ts'],
          hookTimeout: 20000,
          typecheck: { tsconfig: 'packages/gau/tsconfig.json' },
        },
      },
      {
        test: {
          name: 'pg',
          globals: true,
          include: ['packages/gau/test/adapters/drizzle/pg.test.ts'],
          environment: 'node',
          setupFiles: ['packages/gau/test/setup.ts'],
          hookTimeout: 20000,
          typecheck: { tsconfig: 'packages/gau/tsconfig.json' },
        },
      },
    ],
  },
  lint: {
    plugins: ['typescript', 'oxc'],
    categories: { correctness: 'error' },
    env: { browser: true, node: true },
    ignorePatterns: generatedFiles,
    rules: {
      'no-unused-vars': ['error', { ignoreRestSiblings: true, argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
    },
  },
  fmt: {
    semi: false,
    singleQuote: true,
    printWidth: 120,
    sortPackageJson: false,
    ignorePatterns: [...generatedFiles, 'coverage.json', 'bun.lock'],
  },
})
