# Example UI

All examples use the same dark layout, `gau / framework` header, and Home, Account, and Protected page navigation. Each framework has an accent defined in `styles.css`.

- Bun, Elysia, and Marko use full-page navigation.
- Astro uses ClientRouter for Home and Account, and full-page navigation for Protected page.
- SvelteKit, Solid, and Tauri use their framework routers.

The Svelte examples share the shell, session details, protected view, and error view here. Bun and Elysia share their HTML renderer and browser controls. Solid, Astro, and Marko keep framework-specific components and import the same stylesheet.

Keep example-specific controls in their app, such as email sign-in or impersonation.
