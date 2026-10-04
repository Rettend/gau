import { defineConfig } from '@rttnd/release'

export default defineConfig({
  versionFiles: ['packages/gau/package.json'],
  commitFiles: [
    'bun.lock',
    'packages/tauri-plugin-gau/Cargo.toml',
    'packages/tauri-plugin-gau/Cargo.lock',
    'packages/example-sveltekit-tauri/src-tauri/Cargo.lock',
  ],
  prepare: 'bun scripts/release-prepare.ts',
  publish: 'bun scripts/release-publish.ts',
})
