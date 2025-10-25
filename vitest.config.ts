import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
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
