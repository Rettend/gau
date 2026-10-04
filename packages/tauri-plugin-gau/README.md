# tauri-plugin-gau

Native ChatGPT account connections for Tauri desktop apps. Sign in through the system browser, save accounts, and make OpenAI requests from your frontend without exposing credentials.

## Setup

Add the frontend package:

```sh
bun add @rttnd/gau @tauri-apps/api@2
```

Add the Rust plugin from your app's `src-tauri` directory:

```sh
cargo add tauri-plugin-gau
```

Register the plugin on your Tauri builder:

```rust
tauri::Builder::default()
    .plugin(tauri_plugin_gau::init())
    .run(tauri::generate_context!())
    .expect("error while running tauri application");
```

Add `gau:default` to your window's capability permissions:

```json
{
  "permissions": ["core:default", "gau:default"]
}
```

The plugin uses your Tauri `productName`, `identifier`, and app-local data directory. Keep the identifier stable. Credentials are encrypted with a key held in the operating system's credential store. Linux needs a running, unlocked Secret Service keyring.

## Frontend

```ts
import { createChatGPT } from '@rttnd/gau/runtimes/tauri'

const chatgpt = createChatGPT()
const account = await chatgpt.signIn()

if (account.status === 'ready') {
  const fetch = chatgpt.createFetch(account.id)
  const response = await fetch('https://api.openai.com/v1/models')
  if (!response.ok) throw new Error(`Could not load models (${response.status})`)
  const catalog = await response.json()
}
```

Use `listAccounts()` to let users select a saved account and `signOut(account.id)` to disconnect it. `close()` cancels the client's pending work without signing out.

The fetch function supports OpenAI's model catalog and streaming Responses API. See the [ChatGPT guide](https://gau.rettend.me/providers/chatgpt/#local-apps) for account states, inference requests, and OpenAI's eligibility rules.

## Development

Run from the repository root:

```sh
bun run check:tauri
bun run test:tauri
cargo fmt --manifest-path packages/tauri-plugin-gau/Cargo.toml --check
```
