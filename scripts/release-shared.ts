import { resolve } from 'node:path'

export const npmManifest = 'packages/gau/package.json'
export const cargoManifest = 'packages/tauri-plugin-gau/Cargo.toml'
export const cargoLocks = [
  'packages/tauri-plugin-gau/Cargo.lock',
  'packages/example-sveltekit-tauri/src-tauri/Cargo.lock',
]
export const npmName = '@rttnd/gau'
export const crateName = 'tauri-plugin-gau'
export const npmRegistry = 'https://registry.npmjs.org'
const repository = 'https://github.com/rettend/gau'

export type RunCommand = (args: string[], cwd?: string) => Promise<void>

export const runCommand: RunCommand = async (args, cwd = process.cwd()) => {
  console.log(`$ ${args.join(' ')}`)
  const child = Bun.spawn(args, { cwd, stdin: 'inherit', stdout: 'inherit', stderr: 'inherit' })
  const code = await child.exited
  if (code !== 0) throw new Error(`${args[0]} failed with exit code ${code}.`)
}

export function assertVersion(version: unknown): asserts version is string {
  if (
    typeof version !== 'string' ||
    !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(?:0|[1-9]\d*|\d*[a-zA-Z-][\da-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][\da-zA-Z-]*))*)?(?:\+[\da-zA-Z-]+(?:\.[\da-zA-Z-]+)*)?$/.test(
      version,
    )
  ) {
    throw new Error('The release version must be a semantic version.')
  }
}

type CargoPackage = { name: string; version: string; source?: string; repository?: string }

export function replaceCargoVersion(source: string, version: string, lockfile = false): string {
  assertVersion(version)
  const parsed = Bun.TOML.parse(source) as { package: CargoPackage | CargoPackage[] }
  const packages = Array.isArray(parsed.package) ? parsed.package : [parsed.package]
  const matches = packages.filter((item) => item?.name === crateName && !item.source)
  if (matches.length !== 1) throw new Error(`Expected exactly one local ${crateName} package.`)
  const section = lockfile ? /^\[\[package\]\][^]*?(?=^\[|$(?![^]))/gm : /^\[package\][^]*?(?=^\[|$(?![^]))/gm
  let replaced = 0
  const updated = source.replace(section, (text) => {
    const entry = Bun.TOML.parse(text) as { package: CargoPackage | CargoPackage[] }
    const item = Array.isArray(entry.package) ? entry.package[0] : entry.package
    if (item?.name !== crateName || item.source) return text
    return text.replace(/^(version\s*=\s*)(["'])([^"'\r\n]+)\2/gm, (_match, prefix, quote) => {
      replaced++
      return `${prefix}${quote}${version}${quote}`
    })
  })
  if (replaced !== 1) throw new Error(`Could not locate the ${crateName} version without rewriting TOML.`)
  return updated
}

export async function readReleaseVersion(root = process.cwd(), requireSynced = false): Promise<string> {
  const manifest = await Bun.file(resolve(root, npmManifest)).json()
  if (manifest.name !== npmName) throw new Error(`Expected npm package ${npmName}.`)
  assertVersion(manifest.version)
  if (requireSynced) {
    const cargo = Bun.TOML.parse(await Bun.file(resolve(root, cargoManifest)).text()) as { package: CargoPackage }
    if (cargo.package.name !== crateName || cargo.package.version !== manifest.version) {
      throw new Error('npm and Cargo release versions do not match. Run release preparation first.')
    }
  }
  return manifest.version
}

function matchesRepository(value: unknown): boolean {
  return (
    typeof value === 'string' &&
    value
      .toLowerCase()
      .replace(/^git\+/, '')
      .replace(/\.git$/, '')
      .replace(/\/$/, '') === repository
  )
}

export type RegistryFetch = (url: string, options: RequestInit) => Promise<Response>
type Registry = 'npm' | 'cargo'

export async function isPublished(
  registry: Registry,
  version: string,
  request: RegistryFetch = fetch,
): Promise<boolean> {
  assertVersion(version)
  const url =
    registry === 'npm'
      ? `${npmRegistry}/${encodeURIComponent(npmName)}/${encodeURIComponent(version)}`
      : `https://crates.io/api/v1/crates/${crateName}/${encodeURIComponent(version)}`
  const response = await request(url, {
    headers: { Accept: 'application/json', 'User-Agent': 'gau-release (https://github.com/Rettend/gau)' },
    signal: AbortSignal.timeout(30000),
    redirect: 'error',
  })
  if (response.status === 404) return false
  if (!response.ok) throw new Error(`${registry} version lookup failed with HTTP ${response.status}.`)
  const data = await response.json()
  if (registry === 'npm') {
    if (
      data.name !== npmName ||
      data.version !== version ||
      !matchesRepository(data.repository?.url) ||
      !Array.isArray(data.maintainers) ||
      !data.maintainers.some((owner: { name?: string }) => owner.name === 'rettend1')
    )
      throw new Error('Published npm version does not match the expected package, repository, or owner.')
  } else {
    const published = data.version
    if (
      published?.crate !== crateName ||
      published.num !== version ||
      published.yanked !== false ||
      !matchesRepository(published.repository) ||
      published.published_by?.login?.toLowerCase() !== 'rettend'
    )
      throw new Error(
        'Published Cargo version does not match the expected crate, repository, or publisher (or is yanked).',
      )
  }
  return true
}

export async function publishRelease(
  version: string,
  {
    request = fetch,
    run = runCommand,
    log = console.log,
  }: {
    request?: RegistryFetch
    run?: RunCommand
    log?: (message: string) => void
  } = {},
): Promise<void> {
  // Resolve both before uploading either; a registry outage is not a missing version.
  const [cargoPublished, npmPublished] = await Promise.all([
    isPublished('cargo', version, request),
    isPublished('npm', version, request),
  ])
  const publishers: [Registry, boolean, string[]][] = [
    [
      'cargo',
      cargoPublished,
      ['cargo', 'publish', '--locked', '--registry', 'crates-io', '--manifest-path', cargoManifest],
    ],
    ['npm', npmPublished, ['bun', 'publish', '--cwd', 'packages/gau', '--registry', npmRegistry]],
  ]
  for (const [registry, published, command] of publishers) {
    if (published) {
      log(`${registry}: ${version} is already published; skipping.`)
      continue
    }
    try {
      await run(command)
    } catch (error) {
      // An upload may have succeeded even when the client did not receive its response.
      if (!(await isPublished(registry, version, request))) throw error
      log(`${registry}: ${version} was confirmed published after the command failed.`)
    }
  }
}
