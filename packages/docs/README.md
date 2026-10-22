# gau docs

The documentation site is an Astro site built on [Nimbus](https://nimbus-docs.com) through `@cloudflare/nimbus-docs`.

## Commands

Run these from `packages/docs`:

| Command             | Action                                   |
| :------------------ | :--------------------------------------- |
| `bun run dev`       | Start the dev server at `localhost:4321` |
| `bun run build`     | Build the production site into `./dist/` |
| `bun run preview`   | Serve the production build locally       |
| `bun run check`     | Type-check the Astro project             |
| `bun run lint:docs` | Run the Nimbus authoring and link lint   |

`bun run lint:docs` checks internal links against the routes the build produces, so run `bun run build` first.

## What lives here

| Path                             | Contents                                                          |
| :------------------------------- | :---------------------------------------------------------------- |
| `src/content/docs/`              | The documentation pages, one MDX file per page                    |
| `src/components/`                | Local components; `src/components.ts` is the MDX globals registry |
| `src/layouts/`, `src/pages/`     | Layouts, routes, and the agent-facing Markdown endpoints          |
| `src/styles/`                    | Tailwind theme and prose styles                                   |
| `astro.config.ts`, `nimbus.json` | Site configuration and the reviewed Nimbus version                |

Pages import components from `@/components`. Add a new page at `src/content/docs/<slug>.mdx` and add its link to the sidebar in `astro.config.ts`.

After building, run `bun run test:docs` from the repository root to check published page URLs, Markdown output, search, and the existing LLM endpoints.

## Upgrading Nimbus

The Nimbus CLI maintains `nimbus.json`, which records the starter and reviewed package versions.

1. Update `@cloudflare/nimbus-docs` with Bun.
2. Preview the plan with `bun run nimbus-docs migrate --dry-run --diff` and read every entry.
3. Apply the safe edits with `bun run nimbus-docs migrate --yes`, then review the diff.
4. Pull in upstream starter changes: `bun run nimbus-docs outdated` lists what moved, and `bun run nimbus-docs diff <file>` shows one file before you apply it.
5. Run `bun run build`, `bun run check`, and `bun run lint:docs` again, then run `bun run test:docs` from the repository root.

Use `bun run nimbus-docs` to run the version installed in this project.
