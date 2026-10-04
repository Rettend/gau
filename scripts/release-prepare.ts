import { resolve } from 'node:path'
import {
  cargoLocks,
  cargoManifest,
  npmRegistry,
  readReleaseVersion,
  replaceCargoVersion,
  runCommand,
  type RunCommand,
} from './release-shared'

export async function syncCargoVersions(root = process.cwd()): Promise<void> {
  const version = await readReleaseVersion(root)
  // Validate every file before changing any of them.
  const updates = await Promise.all(
    [cargoManifest, ...cargoLocks].map(async (path) => {
      const file = Bun.file(resolve(root, path))
      const source = await file.text()
      return { file, source, updated: replaceCargoVersion(source, version, path.endsWith('.lock')) }
    }),
  )
  for (const { file, source, updated } of updates) {
    if (source !== updated) await Bun.write(file, updated)
  }
}

export async function syncBunLock(root = process.cwd(), run: RunCommand = runCommand): Promise<void> {
  const version = await readReleaseVersion(root)
  const lock = Bun.file(resolve(root, 'bun.lock'))
  const expectedLock = Bun.JSONC.parse(await lock.text()) as {
    workspaces?: Record<string, { name?: string; version?: string }>
  }
  if (expectedLock.workspaces?.['packages/gau']?.name !== '@rttnd/gau') {
    throw new Error('bun.lock does not contain the Gau workspace.')
  }
  expectedLock.workspaces['packages/gau'].version = version
  // Offline resolution preserves dependency versions and runs no lifecycle scripts.
  await run(['bun', 'install', '--lockfile-only', '--ignore-scripts', '--offline'], root)
  if (!Bun.deepEquals(expectedLock, Bun.JSONC.parse(await lock.text()))) {
    throw new Error('Release preparation changed unrelated Bun dependencies. Inspect bun.lock before retrying.')
  }
}

export async function prepareRelease(): Promise<void> {
  await syncCargoVersions()
  await syncBunLock()
  for (const manifest of [cargoManifest, 'packages/example-sveltekit-tauri/src-tauri/Cargo.toml']) {
    await runCommand([
      'cargo',
      'metadata',
      '--format-version',
      '1',
      '--no-deps',
      '--locked',
      '--offline',
      '--manifest-path',
      manifest,
    ])
  }
  await runCommand(['bun', 'run', 'test:release'])
  await runCommand(['bun', 'run', 'check'])
  await runCommand(['bun', 'run', 'check:test'])
  await runCommand(['bun', 'run', 'test', '--coverage=false'])
  await runCommand(['bun', 'run', 'test:pg', '--coverage=false'])
  await runCommand(['bun', 'run', 'build'])
  await runCommand(['bun', 'run', 'check:tauri'])
  await runCommand(['bun', 'run', 'test:tauri'])
  await runCommand(['cargo', 'fmt', '--manifest-path', cargoManifest, '--check'])
  await runCommand(['bun', 'publish', '--dry-run', '--cwd', 'packages/gau', '--registry', npmRegistry])
  // Version files are intentionally dirty until the release CLI commits them.
  await runCommand([
    'cargo',
    'publish',
    '--dry-run',
    '--allow-dirty',
    '--locked',
    '--registry',
    'crates-io',
    '--manifest-path',
    cargoManifest,
  ])
}

if (import.meta.main) await prepareRelease()
