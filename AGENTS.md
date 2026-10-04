# gau

## Workspace

- Use `bun` only. The repo pins `bun@1.4.2` and Node 24 in `.node-version`; CI installs with `bun install --frozen-lockfile`.
- This is a Bun workspace, but root `build`, `check`, `check:test`, `test`, `test:pg`, and `dev` target `packages/gau`. Root `lint` runs Vite+ Oxlint across the repo without modifying files.
- Vite+ 1.0 manages Vite, Vitest, Oxlint, Oxfmt, and library packaging. Use Bun scripts to invoke it. Astro 7 uses Vite 8 through Vite+; legacy SolidStart keeps Vite 6. The `vite@>=8` override only redirects compatible ranges to Vite+.
- CI runs the fast and PostgreSQL Vitest projects, library typechecks, Oxlint, and the library build. If you change docs or example apps, run their relevant checks yourself.

## Package Map

- `packages/gau` is the published library.
- `packages/gau/src/core` is the framework-agnostic auth engine and HTTP handler.
- `packages/gau/src/adapters` exports `drizzle` and `memory`; `oauth` holds providers; `client` holds vanilla/Svelte/Solid helpers; `sveltekit`, `solidstart`, and `runtimes/tauri` are integration layers.
- `packages/gau/test` mirrors `packages/gau/src`.
- `packages/docs` is the Astro/Starlight docs site.
- `packages/tauri-plugin-gau` is the native Rust Tauri plugin for ChatGPT connections. Its TypeScript client lives in `packages/gau/src/runtimes/tauri/oauth` and is exported from `@rttnd/gau/runtimes/tauri`.
- `packages/example-*` are standalone apps; root scripts do not verify them.

## Library Shape

- `packages/gau/src/index.ts` only re-exports `./core`; adapters, providers, clients, and framework integrations are consumed through subpath exports in `packages/gau/package.json`.
- `src/core/createAuth.ts` and `src/core/handler.ts` are the real engine. `src/sveltekit` and `src/solidstart` mostly wrap `createHandler(auth)` and attach framework-specific session helpers.
- `createHandler` owns the auth route surface: `GET /session`, `GET /link/:provider`, `GET /callback/:provider`, `GET /:provider`, `POST /signout`, `POST /token`, `POST /unlink/:provider`.
- Preserve the server/client session split: `GauServerSession` may include linked-account tokens, while `toClientSession()` strips sensitive account data and removes `session.id` before serialization.
- Tauri-specific login/link/token bridge logic lives under `src/runtimes/tauri`; Svelte and Solid clients call into it when `isTauri()` is true.

## Commands

- Default library verification: `bun run check && bun run test`
- Add `bun run test:pg` when touching the Postgres Drizzle adapter.
- Add `bun run build` when changing public exports, build logic, or client entrypoints.
- Native Tauri verification: `bun run check:tauri`, `bun run test:tauri`, and `cargo fmt --manifest-path packages/tauri-plugin-gau/Cargo.toml --check`. Changes to the native bridge also need the TypeScript Tauri tests and library build.
- Single fast test file: `bun run test --run packages/gau/test/core/createAuth.test.ts`
- PG adapter test file: `bun run test:pg --run packages/gau/test/adapters/drizzle/pg.test.ts`
- Docs/examples use package-local scripts, e.g. `bun run --cwd packages/docs check` or `bun run --cwd packages/example-sveltekit check`.
- `bun run fmt -- <files>` formats selected files; `bun run fmt:check` checks the whole repo. Repository-wide formatting is deferred, so existing style differences are expected. Keep formatting changes focused.

## Repo Quirks

- `packages/gau` typechecking uses `tsgo`, not `tsc`. `bun run check` also runs the separate client tsconfigs under `src/client/solid` and `src/client/svelte`; plain `tsc` misses those.
- Lint scripts use Oxlint and are read-only. Keep the framework-specific typechecks; `vp check` does not replace them.
- Root `vite.config.ts` contains lint, formatting, and test configuration. Its two test projects are `fast` (all tests except the PostgreSQL adapter) and `pg` (only that adapter).
- The `pg` suite uses in-memory `@electric-sql/pglite`, so it does not require an external Postgres service.
- `packages/gau/vite.config.ts` configures `vp pack`: it builds every `src/**/index.{ts,tsx,svelte,svelte.ts}` entry, generates declarations with `bun tsgo` plus `svelte2tsx`, and copies `.svelte` components into `dist`. Solid JSX and Svelte runes remain uncompiled for consuming apps. New public entrypoints need both an `index.*` file and a matching `packages/gau/package.json` `exports` entry.
- `bun run build` uses the cached `bundle` task. Its inputs include source, package/compiler config, and the workspace lockfile; outputs are `packages/gau/dist/**`. `bun run --cwd packages/gau vp pack` forces a fresh build.
- Test runs write `coverage.json` unless a different coverage reporter is selected.
- Auth `POST` routes enforce origin checks via `trustHosts`; development only auto-trusts `localhost` and `127.0.0.1`.
