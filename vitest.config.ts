import solid2 from '@solidjs/vite-plugin'
import { svelte } from '@sveltejs/vite-plugin-svelte'
import solid from 'vite-plugin-solid'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  // Compile framework sources so uncovered components appear in coverage too.
  plugins: [
    solid({ include: '**/src/client/solid/**/*.tsx', hot: false, ssr: true }),
    solid2({ include: '**/src/client/solid2/**/*.tsx', hot: false, ssr: true }),
    svelte({ configFile: false }),
  ],
  // SvelteKit supplies this virtual module in consuming apps.
  ssr: { external: ['$app/navigation'] },
  test: {
    environment: 'node',
    coverage: {
      enabled: true,
      provider: 'v8',
      reporter: [
        'text',
        'html',
        ['json-summary', { file: '../coverage.json' }],
      ],
      include: [
        'packages/gau/src/**/*.@(ts|tsx|svelte)',
      ],
      exclude: [
        '**/dist/**',
        '**/build/**',
        '**/.svelte-kit/**',
        '**/*.d.ts',
        '**/migrations/**',
        '**/*.config.ts',
      ],
    },
    projects: [
      {
        test: {
          name: 'fast',
          globals: true,
          include: [
            'packages/gau/test/**/*.test.{ts,tsx,svelte}',
          ],
          exclude: ['packages/gau/test/adapters/drizzle/pg.test.ts'],
          environment: 'node',
          setupFiles: ['packages/gau/test/setup.ts'],
          hookTimeout: 20000,
          typecheck: {
            tsconfig: 'packages/gau/tsconfig.json',
          },
        },
      },
      {
        test: {
          name: 'pg',
          globals: true,
          include: [
            'packages/gau/test/adapters/drizzle/pg.test.ts',
          ],
          environment: 'node',
          setupFiles: ['packages/gau/test/setup.ts'],
          hookTimeout: 20000,
          typecheck: {
            tsconfig: 'packages/gau/tsconfig.json',
          },
        },
      },
    ],
  },
})
