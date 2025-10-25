# TODO

## now

- [ ] docs
  - [ ] protected routes: sveltekit, solidstart
  - [ ] refresh method
  - [ ] vanilla client
- [ ] examples
  - [ ] move elysia example to vanilla client
  - [ ] move bun.serve example to vanilla client
- [ ] fix
  - [ ] solid client provider inside or outside router?

## focus

- [ ] email provider, send verification email?
- [ ] FAILED (No max-age or expires): <https://formate.app/api/auth/session>

## docs

## fix

- [ ] move to tsdown
- [ ] how to test svelte 5 runes man..........
- [ ] add a ton of type tests, every config, method etc. that should be typed should be typed
- [ ] better role types
- [ ] dev: when editing only svelte nr dev deletes all files in dist but svelte files, entries delete each other's work
- [ ] ssr
- [x] sveltekit tauri dev/build
- [ ] sveltekit tauri android dev/build

## v0.4.0

- [x] manual account linking and unlinking
  - [x] allowDifferentEmails
  - [x] updateUserInfoOnLink or updateUserInfoOnUnlink
- [x] refresh-token rotation
- [x] bun.serve frameworkless guide
  - [x] elysia

## later

- [ ] drizzle drivers when drizzle 1.0
- [ ] Passkeys/WebAuthn
- [ ] eliminate waterfalls, currently: initial html, css, some js -> auth/session -> rest of the js
