import { describe, expect, test } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const dist = resolve(import.meta.dir, '../packages/docs/dist')
const read = (path: string) => readFileSync(resolve(dist, path), 'utf8')

// These paths were public before the Nimbus migration, including the Markdown URLs.
const pages = [
  'index',
  'adapters',
  'adapters/drizzle',
  'advanced',
  'advanced/user-impersonation',
  'advanced/xbox-minecraft',
  'guides/account-linking',
  'guides/configuration',
  'guides/error-handling',
  'guides/getting-started',
  'guides/hooks',
  'guides/middleware',
  'guides/protected-routes',
  'guides/refresh-tokens',
  'guides/role-based-access-control',
  'guides/security',
  'guides/session-management',
  'integrations',
  'integrations/astro',
  'integrations/bun-serve',
  'integrations/elysia',
  'integrations/marko',
  'integrations/solidstart',
  'integrations/sveltekit',
  'integrations/vanilla',
  'providers',
  'providers/chatgpt',
  'providers/discord',
  'providers/email',
  'providers/facebook',
  'providers/github',
  'providers/google',
  'providers/microsoft',
  'reference/cli',
  'reference/core-api',
  'runtimes',
  'runtimes/tauri',
]

function markdownPath(page: string) {
  return page === 'index' ? 'index.md' : `${page}/index.md`
}

function withoutFences(markdown: string) {
  let fence: string | undefined
  return markdown
    .split('\n')
    .filter((line) => {
      const marker = line.trimStart().match(/^(`{3,}|~{3,})/)?.[1]
      if (marker) {
        if (!fence) fence = marker
        else if (marker[0] === fence[0] && marker.length >= fence.length) fence = undefined
        return false
      }
      return !fence
    })
    .join('\n')
}

describe('published documentation (run the docs build first)', () => {
  test.each(pages)('%s keeps its HTML and Markdown URLs', (page) => {
    const html = read(page === 'index' ? 'index.html' : `${page}/index.html`)
    expect(html).toContain('<h1')
    expect(html).toContain('id="_top"')
    const source = existsSync(resolve(dist, `../src/content/docs/${page}.mdx`)) ? `${page}.mdx` : `${page}/index.mdx`
    expect(html).toContain(`https://github.com/Rettend/gau/edit/main/packages/docs/src/content/docs/${source}`)
    const markdown = read(markdownPath(page))
    expect(markdown).toMatch(/^# .+/m)
    expect(withoutFences(markdown)).not.toMatch(/<\/?(?:Tabs|TabItem|Steps|Aside|IconLink|Card|FileTree)\b/)
    expect(withoutFences(markdown)).not.toMatch(/^import .+ from ['"]/m)

    const legacy = `${page}.md`
    if (existsSync(resolve(dist, legacy))) {
      expect(read(legacy)).toBe(markdown)
    } else {
      expect(read('_redirects')).toMatch(
        new RegExp(
          `^/${legacy.replaceAll('.', '\\.')}\\s+/${markdownPath(page).replaceAll('.', '\\.')}\\s+30[18]\\s*$`,
          'm',
        ),
      )
    }
  })

  test('discovery indexes reach all pages and preserve the existing endpoints', () => {
    const index = read('llms.txt')
    const full = read('llms-full.txt')
    for (const page of pages) {
      expect(index).toContain(`https://gau.rettend.me/${markdownPath(page)}`)
    }
    expect(full).toContain('createAuth')
    expect(full).toContain('tauri-plugin-gau')
    expect(read('llms-small.txt')).toBe(full)
    expect(index).not.toContain('Compact documentation')
    expect(read('guides/llms.txt')).toContain('getting-started')
  })

  test('nested alternatives retain both databases and all package managers in Markdown', () => {
    const markdown = read(markdownPath('adapters/drizzle'))
    expect(markdown).toContain('SQLite')
    expect(markdown).toContain('PostgreSQL')
    for (const command of ['npm i', 'pnpm add', 'yarn add', 'bun add', 'ni']) {
      expect(markdown).toContain(`${command} drizzle-orm@1.0.0-rc.4 @libsql/client`)
      expect(markdown).toContain(`${command} drizzle-orm@1.0.0-rc.4 pg`)
    }
    expect(markdown).not.toContain('[!code')
  })

  test('setup and Tauri instructions keep useful anchors and code', () => {
    const setup = read('guides/getting-started/index.html')
    expect(setup).toContain('id="install-the-package"')
    expect(setup).toContain('id="set-up-environment-variables"')
    const tauri = read('runtimes/tauri/index.html')
    expect(tauri).toContain('id="initialize-tauri"')
    expect(tauri).toContain('id="install-tauri-plugins"')
    const markdown = read(markdownPath('runtimes/tauri'))
    expect(markdown).toContain('bun tauri init')
    expect(markdown).toContain('nlx tauri init')
    expect(markdown).toContain('tauri.conf.json')
    expect(markdown).toContain('```')
  })

  test('icon links remain useful links in Markdown', () => {
    const markdown = read(markdownPath('integrations'))
    expect(markdown).not.toContain('<div')
    for (const [label, slug] of [
      ['SvelteKit', 'sveltekit'],
      ['SolidStart', 'solidstart'],
      ['Marko', 'marko'],
      ['Astro', 'astro'],
      ['Bun.serve', 'bun-serve'],
      ['Elysia', 'elysia'],
      ['Vanilla', 'vanilla'],
    ]) {
      expect(markdown).toContain(`[${label}](/integrations/${slug}/)`)
    }
  })

  test('static search and a real not-found page are built', () => {
    expect(existsSync(resolve(dist, 'pagefind/pagefind.js'))).toBe(true)
    const notFound = read('404.html')
    expect(notFound).toMatch(/page not found/i)
    expect(notFound).toMatch(/noindex/)
  })

  test('the homepage keeps its landing-page layout', () => {
    const home = read('index.html')
    expect(home).not.toContain('id="desktop-sidebar"')
    expect(home).not.toContain('data-nb-toc-scroll-host')
    expect(home).toContain('href="/guides/getting-started/"')
  })
})
