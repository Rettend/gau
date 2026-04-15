# gau

## Workspace

- Use `bun` only. The repo pins `bun@1.3.5`, and CI installs with `bun install --frozen-lockfile`.
- This is a Bun workspace, but root `build`, `check`, `check:test`, `test`, `test:pg`, and `dev` target `packages/gau`. Root `lint` is the exception: it runs `eslint . --fix` across the whole repo (eslint is very very slow, never use it).
- CI only runs `bun run test` (the fast Vitest project). If you change types, packaging, docs, or example apps, run the relevant checks yourself.

## Package Map

- `packages/gau` is the published library.
- `packages/gau/src/core` is the framework-agnostic auth engine and HTTP handler.
- `packages/gau/src/adapters` exports `drizzle` and `memory`; `oauth` holds providers; `client` holds vanilla/Svelte/Solid helpers; `sveltekit`, `solidstart`, and `runtimes/tauri` are integration layers.
- `packages/gau/test` mirrors `packages/gau/src`.
- `packages/docs` is the Astro/Starlight docs site.
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
- Single fast test file: `bunx vitest --project fast packages/gau/test/core/createAuth.test.ts`
- PG adapter test file: `bunx vitest --project pg packages/gau/test/adapters/drizzle/pg.test.ts`
- Docs/examples use package-local scripts, e.g. `bun --cwd packages/docs run check` or `bun --cwd packages/example-sveltekit run check`

## Repo Quirks

- `packages/gau` typechecking uses `tsgo`, not `tsc`. `bun run check` also runs the separate client tsconfigs under `src/client/solid` and `src/client/svelte`; plain `tsc` misses those.
- `bun run lint` and package-local `lint` scripts use `--fix`. Do not use lint as a read-only verifier.
- `vitest.config.ts` has two projects: `fast` runs every test except `packages/gau/test/adapters/drizzle/pg.test.ts`; `pg` runs only that file.
- The `pg` suite uses in-memory `@electric-sql/pglite`, so it does not require an external Postgres service.
- `packages/gau/tsup.config.ts` builds every `src/**/index.{ts,tsx,svelte,svelte.ts}` entry, generates declarations with `bun tsgo` plus `svelte2tsx`, and copies `.svelte` components into `dist`. New public entrypoints need both an `index.*` file and a matching `packages/gau/package.json` `exports` entry.
- `bun run test:all` also lints `coverage.json`, so that file will be regenerated/modified.
- Auth `POST` routes enforce origin checks via `trustHosts`; development only auto-trusts `localhost` and `127.0.0.1`.
