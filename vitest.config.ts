import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    globals: true,
    include: ['packages/gau/test/**/*.test.ts'],
    environment: 'node',
    setupFiles: ['packages/gau/test/setup.ts'],
    hookTimeout: 20000,
    coverage: {
      enabled: true,
      provider: 'v8',
      reporter: [
        'text',
        'html',
        ['json-summary', { file: '../coverage.json' }],
      ],
      include: [
        'packages/gau/**/*.ts',
      ],
      exclude: [
        '**/dist/**',
        '**/build/**',
        '**/migrations/**',
        '**/*.config.ts',
      ],
    },
    typecheck: {
      tsconfig: 'packages/gau/tsconfig.json',
    },
  },
})
