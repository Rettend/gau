import { defineConfig } from '@rttnd/release'

export default defineConfig({
  versionFiles: [
    'packages/gau/package.json',
    'packages/gau/jsr.json',
  ],
  prepare: 'bun run build',
  publish: 'bun publish --cwd packages/gau',
})
