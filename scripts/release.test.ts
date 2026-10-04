import { describe, expect, test } from 'bun:test'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { syncBunLock, syncCargoVersions } from './release-prepare'
import { release } from './release'
import {
  assertVersion,
  cargoLocks,
  cargoManifest,
  isPublished,
  npmManifest,
  publishRelease,
  replaceCargoVersion,
  type RegistryFetch,
} from './release-shared'

const version = '1.6.1'
const manifest =
  '[package]\r\nname = "tauri-plugin-gau"\r\nversion = "0.1.0" # keep this\r\n\r\n[dependencies]\r\nother = "0.1.0"\r\n'
const lock =
  '# Generated lockfile\nversion = 4\n\n[[package]]\nname = "other"\nversion = "0.1.0"\n\n[[package]]\nname = "tauri-plugin-gau"\nversion = "0.1.0"\ndependencies = ["other"]\n'

function metadata(url: string): object {
  return url.includes('crates.io')
    ? {
        version: {
          crate: 'tauri-plugin-gau',
          num: version,
          yanked: false,
          repository: 'https://github.com/Rettend/gau',
          published_by: { login: 'Rettend' },
        },
      }
    : {
        name: '@rttnd/gau',
        version,
        repository: { url: 'git+https://github.com/Rettend/gau.git' },
        maintainers: [{ name: 'rettend1' }],
      }
}

const missing: RegistryFetch = async () => new Response(null, { status: 404 })
const published: RegistryFetch = async (url) => Response.json(metadata(url))

describe('release version synchronization', () => {
  test('changes only the local package version, preserves comments and newlines, and is idempotent', () => {
    for (const [source, isLock] of [
      [manifest, false],
      [lock, true],
    ] as const) {
      const updated = replaceCargoVersion(source, version, isLock)
      expect(updated).toBe(
        isLock
          ? source.replace(
              'name = "tauri-plugin-gau"\nversion = "0.1.0"',
              `name = "tauri-plugin-gau"\nversion = "${version}"`,
            )
          : source.replace('version = "0.1.0"', `version = "${version}"`),
      )
      expect(replaceCargoVersion(updated, version, isLock)).toBe(updated)
    }
  })

  test('rejects invalid versions, missing packages, and registry packages', () => {
    for (const value of ['1.6', '01.6.1', '1.6.1; echo bad', '1.6.1-01']) expect(() => assertVersion(value)).toThrow()
    expect(() => assertVersion('1.6.1-rc.2+build.3')).not.toThrow()
    expect(() => replaceCargoVersion(lock.replaceAll('tauri-plugin-gau', 'wrong'), version, true)).toThrow()
    expect(() => replaceCargoVersion(lock + '\nsource = "registry+https://example.com"\n', version, true)).toThrow()
  })

  test('synchronizes both locks from npm without touching other dependency versions', async () => {
    const root = await mkdtemp(
      resolve(process.env.LOCALAPPDATA ? resolve(process.env.LOCALAPPDATA, 'Temp/opencode') : tmpdir(), 'gau-release-'),
    )
    try {
      for (const path of [npmManifest, cargoManifest, ...cargoLocks]) {
        await mkdir(resolve(root, path, '..'), { recursive: true })
        await Bun.write(
          resolve(root, path),
          path === npmManifest
            ? JSON.stringify({ name: '@rttnd/gau', version })
            : path === cargoManifest
              ? manifest
              : lock,
        )
      }
      await syncCargoVersions(root)
      const first = await Promise.all(
        [cargoManifest, ...cargoLocks].map((path) => Bun.file(resolve(root, path)).text()),
      )
      await syncCargoVersions(root)
      expect(
        await Promise.all([cargoManifest, ...cargoLocks].map((path) => Bun.file(resolve(root, path)).text())),
      ).toEqual(first)
      expect(first.every((source) => source.includes(`version = "${version}"`))).toBe(true)
      expect(first[1]).toContain('name = "other"\nversion = "0.1.0"')
      const bunLock = {
        workspaces: { 'packages/gau': { name: '@rttnd/gau', version: '1.6.0' } },
        packages: { other: '0.1.0' },
      }
      await Bun.write(resolve(root, 'bun.lock'), JSON.stringify(bunLock))
      await syncBunLock(root, async (args, cwd) => {
        expect(args).toEqual(['bun', 'install', '--lockfile-only', '--ignore-scripts', '--offline'])
        expect(cwd).toBe(root)
        bunLock.workspaces['packages/gau'].version = version
        await Bun.write(resolve(root, 'bun.lock'), JSON.stringify(bunLock))
      })
      await expect(
        syncBunLock(root, async () => {
          bunLock.packages.other = '0.2.0'
          await Bun.write(resolve(root, 'bun.lock'), JSON.stringify(bunLock))
        }),
      ).rejects.toThrow('unrelated Bun dependencies')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

test('checks npm authentication before the release CLI and forwards retry arguments', async () => {
  const commands: string[][] = []
  await release(['--publish-only'], async (args) => {
    commands.push(args)
  })
  expect(commands[0]?.slice(0, 3)).toEqual(['bun', 'pm', 'whoami'])
  expect(commands[1]).toEqual(['bun', 'node_modules/@rttnd/release/dist/cli.js', '--publish-only'])
  commands.length = 0
  await release(['--help'], async (args) => {
    commands.push(args)
  })
  expect(commands).toHaveLength(1)
  commands.length = 0
  await expect(
    release([], async (args) => {
      commands.push(args)
      throw new Error('not logged in')
    }),
  ).rejects.toThrow('npm authentication')
  expect(commands).toHaveLength(1)
})

describe('registry-aware publication', () => {
  test('only HTTP 404 is treated as missing', async () => {
    expect(await isPublished('npm', version, missing)).toBe(false)
    for (const status of [401, 403, 429, 500]) {
      await expect(isPublished('npm', version, async () => new Response(null, { status }))).rejects.toThrow(
        `HTTP ${status}`,
      )
    }
    await expect(
      isPublished('cargo', version, async () => {
        throw new Error('offline')
      }),
    ).rejects.toThrow('offline')
    await expect(isPublished('npm', version, async () => new Response('not json'))).rejects.toThrow()
  })

  test('encodes the scoped npm name and requires the exact version and known identity', async () => {
    let requested = ''
    expect(
      await isPublished('npm', version, async (url) => {
        requested = url
        return Response.json(metadata(url))
      }),
    ).toBe(true)
    expect(requested).toBe(`https://registry.npmjs.org/%40rttnd%2Fgau/${version}`)
    for (const patch of [
      { name: 'wrong' },
      { version: '1.6.0' },
      { repository: { url: 'https://github.com/other/gau' } },
      { maintainers: [{ name: 'other' }] },
    ]) {
      await expect(
        isPublished('npm', version, async (url) => Response.json({ ...metadata(url), ...patch })),
      ).rejects.toThrow('expected package')
    }
    await expect(
      isPublished('cargo', version, async () =>
        Response.json({ version: { crate: 'tauri-plugin-gau', num: version, yanked: true } }),
      ),
    ).rejects.toThrow('expected crate')
  })

  test('checks both registries before publishing Cargo, then npm', async () => {
    const events: string[] = []
    await publishRelease(version, {
      request: async (url) => {
        events.push(url.includes('crates.io') ? 'check cargo' : 'check npm')
        return missing(url, {})
      },
      run: async (args) => {
        events.push(args[0])
      },
    })
    expect(events).toEqual(['check cargo', 'check npm', 'cargo', 'bun'])
  })

  test('retry skips Cargo after partial success and skips both after complete success', async () => {
    const commands: string[][] = []
    await publishRelease(version, {
      request: async (url) => (url.includes('crates.io') ? published(url, {}) : missing(url, {})),
      run: async (args) => {
        commands.push(args)
      },
      log: () => {},
    })
    expect(commands.map((args) => args[0])).toEqual(['bun'])
    await publishRelease(version, {
      request: published,
      run: async (args) => {
        commands.push(args)
      },
      log: () => {},
    })
    expect(commands).toHaveLength(1)
  })

  test('a registry error prevents either upload', async () => {
    const commands: string[][] = []
    await expect(
      publishRelease(version, {
        request: async (url) => (url.includes('crates.io') ? missing(url, {}) : new Response(null, { status: 503 })),
        run: async (args) => {
          commands.push(args)
        },
      }),
    ).rejects.toThrow('HTTP 503')
    expect(commands).toHaveLength(0)
  })

  test('a failed command continues only if that exact upload is confirmed', async () => {
    let uploaded = false
    const commands: string[] = []
    await publishRelease(version, {
      request: async (url) => (uploaded && url.includes('crates.io') ? published(url, {}) : missing(url, {})),
      run: async (args) => {
        commands.push(args[0]!)
        if (args[0] === 'cargo') {
          uploaded = true
          throw new Error('response lost')
        }
      },
      log: () => {},
    })
    expect(commands).toEqual(['cargo', 'bun'])
    commands.length = 0
    await expect(
      publishRelease(version, {
        request: missing,
        run: async (args) => {
          commands.push(args[0]!)
          throw new Error('permission denied')
        },
      }),
    ).rejects.toThrow('permission denied')
    expect(commands).toEqual(['cargo'])
  })
})
