import antfu from '@antfu/eslint-config'

export default antfu({
  unocss: true,
  svelte: true,
  solid: true,
  astro: true,
  typescript: true,
  formatters: {
    html: true,
  },
  rules: {
    'no-console': 'warn',
    'curly': ['warn', 'multi-or-nest', 'consistent'],
    'antfu/no-top-level-await': 'off',
  },
  ignores: [
    '**/build/**',
    '**/dist/**',
    '**/coverage/**',
    '**/target/**',
    '**/.astro/**',
    '**/.vinxi/**',
    '**/public/client.js',
  ],
})
