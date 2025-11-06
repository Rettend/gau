<h1 align="center">gau</h1>
<p align="center">
  /ɡɔː/ <br>
  <strong>good auth</strong>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@rttnd/gau"><img src="https://img.shields.io/npm/v/%40rttnd%2Fgau?color=red" alt="NPM Version"></a>
  <a href="https://jsr.io/@rttnd/gau"><img src="https://img.shields.io/jsr/v/%40rttnd/gau?color=yellow" alt="JSR Version"></a>
</p>

**Read the docs**: [gau.rettend.me](https://gau.rettend.me)

- **Flexible** - Small and self-hostable, works with backend-only, full-stack, and native apps, and on different hosts
- **Framework agnostic** - Core is framework-free and uses Web Crypto and Fetch, with helpers for frameworks and runtimes
- **Runtime agnostic** - Runs on Bun, Node, Deno, Cloudflare Workers, and even Tauri
- **Database agnostic** - Can support any database via adapters

## examples

Check out the [`packages`](https://github.com/Rettend/gau/tree/main/packages) folder in this repo for complete working apps:

- `example-sveltekit`: SvelteKit + Turso
- `example-sveltekit-tauri`: SvelteKit + Turso + Tauri (desktop)
- `example-sveltekit-tauri-mobile`: SvelteKit + Turso + Tauri (mobile and desktop) - **Note:** Mobile support is WIP. See [ANDROID_MOBILE_ANALYSIS.md](./ANDROID_MOBILE_ANALYSIS.md) for details.
- `example-solidstart`: SolidStart + Turso
- `example-bun`: Bun.serve
- `example-elysia`: Elysia

To use them as starter templates:

`bunx degit Rettend/gau/packages/example-sveltekit`

## contributing

`gau` core is everything-agnostic, but it's missing a ton of specific integrations.
If you want to add a new...

- OAuth provider
- Database adapter
- Framework integration
- Platform integration

... PRs are welcome!

## license

MIT
