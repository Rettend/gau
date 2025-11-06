# Android Mobile Support Analysis for gau

**Date:** November 6, 2024  
**Status:** gau works on web and Tauri desktop but not yet on mobile

## Executive Summary

This document provides a detailed analysis of why `gau` and `example-sveltekit-tauri-mobile` are not working on Android yet, based on the latest Tauri 2 documentation and the current codebase implementation.

## Current Implementation Status

### What Works ✅
- **Web (SvelteKit)**: Full OAuth flow with cookie-based sessions
- **Tauri Desktop (Windows/macOS/Linux)**: OAuth flow with deep-link redirects (`gau://oauth/callback`)
- Deep-link plugin is configured in `tauri.conf.json`
- Android project is generated in `src-tauri/gen/android/`

### What Doesn't Work ❌
- **Tauri Mobile (Android/iOS)**: OAuth authentication flow
- TODO item confirmed in `TODO.md`: "sveltekit tauri android dev/build"

## Root Cause Analysis

### 1. **OAuth Redirect URI Mismatch for Mobile**

#### Issue
The current implementation in `packages/gau/src/runtimes/tauri/index.ts` handles mobile differently:

```typescript
// Lines 27-30
if (currentPlatform === 'android' || currentPlatform === 'ios')
  redirectTo = new URL(baseUrl).origin
else
  redirectTo = `${scheme}://oauth/callback`
```

For mobile platforms, the redirect is set to the web origin (e.g., `https://yourdomain.com`), but this creates several problems:

**Problem 1: OAuth Provider Configuration**
- OAuth providers (GitHub, Google, Microsoft) need to have the redirect URI explicitly allowlisted
- For mobile, the current code redirects back to the web origin, but the callback needs special handling
- The Android app needs to intercept HTTPS URLs via App Links (Android) or Universal Links (iOS)

**Problem 2: Deep Link Configuration**
In `src-tauri/capabilities/mobile.json` and `tauri.conf.json`:
```json
{
  "mobile": [
    {
      "host": "tauri.localhost"
    }
  ]
}
```

And in `AndroidManifest.xml`:
```xml
<data android:scheme="https" />
<data android:scheme="http" />
<data android:host="tauri.localhost" />
```

This configuration only listens for `https://tauri.localhost` deep links, NOT the actual OAuth callback URLs from the web server.

#### Tauri 2 Specification
According to Tauri 2 deep-link documentation, mobile apps should use:
- **App Links (Android)** - verified HTTPS URLs associated with the app
- **Custom URL schemes** - but these have limitations on mobile (security, browser warnings)

### 2. **Missing Android App Links Configuration**

#### Issue
To properly handle OAuth redirects on Android, the app needs to be configured as the handler for specific HTTPS URLs.

**Required:** Android App Links with Digital Asset Links verification
- Server must host `.well-known/assetlinks.json` 
- AndroidManifest must include the correct intent filters
- The app should intercept `https://yourdomain.com/oauth/callback` or similar

**Current State:**
- `AndroidManifest.xml` only configured for `tauri.localhost` domain
- No production domain is configured
- No `.well-known/assetlinks.json` file exists in the web project

#### Tauri 2 Specification
From Tauri 2 docs, mobile deep links require:
```json
// tauri.conf.json
{
  "plugins": {
    "deep-link": {
      "mobile": [
        {
          "scheme": "https",
          "host": "your-domain.com",
          "pathPrefix": "/oauth/"
        }
      ]
    }
  }
}
```

This would generate the proper Android intent filters.

### 3. **Browser-based OAuth Flow on Mobile**

#### Issue
The current implementation opens OAuth in an external browser using `openUrl`:

```typescript
// packages/gau/src/runtimes/tauri/index.ts
await openUrl(authUrl)
```

**Problems:**
1. **External Browser Flow**: Opens in Chrome/Safari, not an in-app browser
2. **Return Path Unclear**: After authentication, how does the user get back to the app?
3. **Token Passing**: The callback HTML page tries to redirect to a deep link with the token in the hash

**Current Callback Handling** (from `callback.ts` lines 456-526):
```typescript
if (forceToken || (!forceCookie && (isDesktopRedirect || isMobileRedirect))) {
  const destination = new URL(redirectUrl)
  destination.hash = `token=${sessionToken}`
  
  // Returns HTML that redirects to deep link
  const html = `...
    window.location.href = url;
    setTimeout(window.close, 500);
  ...`
}
```

This works on desktop because:
- Desktop browsers can handle `gau://` custom protocol
- The browser window can be closed programmatically

This fails on mobile because:
- Mobile browsers often don't allow `window.close()` on tabs that weren't opened by scripts
- The redirect from `https://your-web-server.com` to `https://tauri.localhost/#token=...` won't work if App Links aren't configured
- Users are left with an orphaned browser tab

### 4. **Deep Link Listener Not Receiving Events**

#### Issue
The app listens for deep-link events in `packages/gau/src/client/svelte/index.svelte.ts`:

```typescript
const { startAuthBridge } = await import('../../runtimes/tauri')
const unlisten = await startAuthBridge(baseUrl, scheme, async (token) => {
  await client.applySessionToken(token)
  session = await fetchSession()
})
```

And in `lib.rs`:
```rust
handle.deep_link().on_open_url(move |event| {
  if let Some(window) = handle_for_closure.get_webview_window("main") {
    if let Some(url) = event.urls().first() {
      let _ = window.emit("deep-link", url.to_string());
    }
  }
});
```

**Problem:** 
- If the Android manifest isn't configured to intercept the right URLs, the deep link never reaches the app
- The callback page redirects to `baseUrl.origin` but the app isn't registered to handle those URLs
- No deep-link event is fired, so the token is never received

### 5. **Missing Tauri Mobile Plugin Initialization**

#### Observation
Looking at `src-tauri/src/lib.rs`, the mobile entry point uses conditional compilation:

```rust
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
```

The plugins are initialized:
- `tauri_plugin_deep_link`
- `tauri_plugin_opener`
- `tauri_plugin_os`

However, there's no specific mobile initialization or handling for the OAuth redirect flow.

#### Tauri 2 Specification
Mobile apps in Tauri 2 need special handling:
- Deep links received via Android intents
- Must be processed when app is in background or foreground
- Need to handle both cold start (app not running) and warm start (app in background)

### 6. **Development vs Production URLs**

#### Issue
The `tauri.conf.json` has:
```json
{
  "build": {
    "devUrl": "http://localhost:4173"
  }
}
```

**Problems:**
1. OAuth providers cannot redirect to `localhost` for mobile apps
2. The mobile device cannot access `localhost` on the development machine
3. Need to use a tunnel (ngrok, cloudflare tunnel) or a staging server for development

### 7. **Session Token Storage Mechanism**

#### Issue
Mobile web views have different behavior regarding:
- `localStorage` persistence
- Cookie handling across the web view and browser
- Session restoration when app is backgrounded

The current token storage (`packages/gau/src/client/token.ts`) uses `localStorage`:
```typescript
export function storeSessionToken(token: string) {
  if (typeof localStorage !== 'undefined')
    localStorage.setItem(GAU_SESSION_TOKEN_KEY, token)
}
```

**Potential Problem:**
- If the OAuth flow opens in an external browser (not the Tauri webview), the token stored in that browser's localStorage won't be accessible to the app's webview
- The token should be passed via deep link, not localStorage

## Proposed Solution Architecture

### Solution 1: HTTPS Deep Links with App Links (Recommended for Production)

**Requirements:**
1. **Server Setup:**
   - Host `.well-known/assetlinks.json` on your domain
   - Configure OAuth callback URL: `https://yourdomain.com/auth/mobile/callback`

2. **Tauri Configuration:**
```json
{
  "plugins": {
    "deep-link": {
      "mobile": [
        {
          "scheme": "https",
          "host": "yourdomain.com",
          "pathPrefix": "/auth/mobile/"
        }
      ]
    }
  }
}
```

3. **OAuth Flow:**
   - User clicks "Sign in with GitHub" in app
   - App opens `https://yourdomain.com/api/auth/github?mobile=true&redirectTo=https://yourdomain.com/auth/mobile/callback`
   - GitHub redirects to `https://yourdomain.com/api/auth/callback/github?code=...`
   - Server processes OAuth, creates session
   - Server redirects to `https://yourdomain.com/auth/mobile/callback#token=...`
   - Android App Links intercepts this URL
   - Deep link event fires in app with full URL
   - App extracts token from URL and applies session

4. **Code Changes Required:**
   - Modify server callback handler to detect mobile and use specific mobile redirect paths
   - Update Android manifest generation to include production domain
   - Deploy assetlinks.json to server
   - Update mobile OAuth initialization to use HTTPS deep link

**Pros:**
- Secure (verified App Links)
- No browser warnings
- Seamless user experience
- Works on both development and production

**Cons:**
- Requires server configuration
- Need domain verification
- More complex setup

### Solution 2: Custom URL Scheme (Simpler, but with Limitations)

**Requirements:**
1. **Tauri Configuration:**
```json
{
  "plugins": {
    "deep-link": {
      "mobile": {
        "scheme": "gaumobile"
      }
    }
  }
}
```

2. **OAuth Flow:**
   - Use custom scheme: `gaumobile://oauth/callback`
   - Server redirects to this after OAuth
   - App intercepts the custom protocol

**Pros:**
- Simpler to implement
- No server verification needed
- Works offline for deep links

**Cons:**
- Security warnings on some browsers
- User may see "Open in app?" dialogs
- Can be hijacked by malicious apps (no verification)
- Not recommended by Android for OAuth flows

## Required Code Changes

### 1. Update `tauri.conf.json`

```json
{
  "plugins": {
    "deep-link": {
      "desktop": {
        "schemes": ["gau"]
      },
      "mobile": [
        {
          "scheme": "https",
          "host": "your-domain.com",
          "pathPrefix": "/auth/mobile/"
        },
        {
          "scheme": "gaumobile"
        }
      ]
    }
  }
}
```

### 2. Update `packages/gau/src/runtimes/tauri/index.ts`

Add mobile-specific redirect handling:

```typescript
export async function signInWithTauri<...>(
  provider: P,
  baseUrl: string,
  scheme: string = 'gau',
  redirectOverride?: string,
  profile?: PR,
) {
  if (!isTauri())
    return

  const { platform } = await import('@tauri-apps/plugin-os')
  const { openUrl } = await import('@tauri-apps/plugin-opener')

  const currentPlatform = platform()
  let redirectTo: string

  if (redirectOverride) {
    redirectTo = redirectOverride
  }
  else if (currentPlatform === 'android' || currentPlatform === 'ios') {
    // Use HTTPS deep link for mobile
    const baseOrigin = new URL(baseUrl).origin
    redirectTo = `${baseOrigin}/auth/mobile/callback`
  }
  else {
    redirectTo = `${scheme}://oauth/callback`
  }

  const params = new URLSearchParams()
  params.set('redirectTo', redirectTo)
  params.set('mobile', currentPlatform === 'android' || currentPlatform === 'ios' ? 'true' : 'false')
  if (profile)
    params.set('profile', String(profile))
  const authUrl = `${baseUrl}/${provider}?${params.toString()}`
  await openUrl(authUrl)
}
```

### 3. Update Server Callback Handler

Modify `packages/gau/src/core/handlers/callback.ts` to better detect mobile:

```typescript
// Around line 443-450
const requestUrl = new URL(request.url)
const redirectUrl = new URL(redirectTo, request.url)

const forceToken = auth.sessionStrategy === 'token'
const forceCookie = auth.sessionStrategy === 'cookie'

const isDesktopRedirect = redirectUrl.protocol === 'gau:'
const isMobileRedirect = requestUrl.host !== redirectUrl.host || 
                         url.searchParams.get('mobile') === 'true'
```

### 4. Add Mobile Callback Route (SvelteKit Example)

Create `packages/example-sveltekit-tauri-mobile/src/routes/auth/mobile/callback/+page.svelte`:

```svelte
<script lang="ts">
  import { onMount } from 'svelte';
  import { browser } from '$app/environment';
  
  onMount(() => {
    if (!browser) return;
    
    // Extract token from hash
    const hash = window.location.hash.substring(1);
    const params = new URLSearchParams(hash);
    const token = params.get('token');
    
    if (token) {
      // Token will be handled by deep link in the Tauri app
      // This page is just for when viewed in browser
      console.log('Token received, redirect handled by app');
    }
  });
</script>

<div class="flex items-center justify-center min-h-screen">
  <div class="text-center">
    <h1>Authentication Complete</h1>
    <p>You can close this page and return to the app.</p>
  </div>
</div>
```

### 5. Add `.well-known/assetlinks.json` for Android

In `packages/example-sveltekit-tauri-mobile/static/.well-known/assetlinks.json`:

```json
[
  {
    "relation": ["delegate_permission/common.handle_all_urls"],
    "target": {
      "namespace": "android_app",
      "package_name": "gau.sveltekit_mobile.dev",
      "sha256_cert_fingerprints": [
        "YOUR_APP_SHA256_FINGERPRINT"
      ]
    }
  }
]
```

### 6. Update Capabilities

Ensure `src-tauri/capabilities/mobile.json` includes:

```json
{
  "$schema": "../gen/schemas/mobile-schema.json",
  "identifier": "mobile-capability",
  "windows": ["main"],
  "platforms": ["iOS", "android"],
  "permissions": [
    "core:default",
    "core:event:default",
    "deep-link:default",
    "opener:default",
    "os:default",
    "core:window:allow-set-focus",
    "core:webview:allow-internal-toggle-devtools"
  ]
}
```

## Development Workflow Improvements

### 1. Use Tunneling for Development

Since mobile devices can't access `localhost`, use:
- **ngrok**: `ngrok http 4173`
- **Cloudflare Tunnel**: `cloudflare tunnel --url localhost:4173`
- **localtunnel**: `lt --port 4173`

Update `VITE_PUBLIC_API_URL` to use the tunnel URL.

### 2. Test with Physical Device

Android emulators have limited deep link support. Test on physical devices:

```bash
# Build and install on device
cd packages/example-sveltekit-tauri-mobile
bun run build
bun tauri android dev
```

### 3. Debug Deep Links

Use ADB to test deep links:

```bash
# Test app link
adb shell am start -W -a android.intent.action.VIEW \
  -d "https://your-domain.com/auth/mobile/callback#token=test" \
  gau.sveltekit_mobile.dev

# Test custom scheme
adb shell am start -W -a android.intent.action.VIEW \
  -d "gaumobile://oauth/callback#token=test" \
  gau.sveltekit_mobile.dev
```

## Testing Checklist

- [ ] Deep link registration verified on Android
- [ ] App Links verification passing (assetlinks.json accessible)
- [ ] OAuth redirect to mobile callback URL working
- [ ] Deep link event received in Tauri app
- [ ] Token extracted and session created
- [ ] User redirected back to app after auth
- [ ] Browser tab closes/redirects appropriately
- [ ] Works when app is in background
- [ ] Works when app is not running (cold start)
- [ ] Multiple OAuth providers tested
- [ ] Account linking flow works on mobile
- [ ] Token persists across app restarts
- [ ] Sign out clears session properly

## Additional Considerations

### iOS Support
iOS has similar requirements with Universal Links:
- Needs `apple-app-site-association` file
- Similar configuration in Tauri
- Different manifest structure

### Security
- Always use HTTPS for production
- Implement PKCE flow (already done in gau)
- Validate deep link origins
- Don't expose tokens in logs
- Use short-lived tokens

### User Experience
- Show loading state while opening browser
- Handle errors gracefully (user cancels, network errors)
- Provide fallback if deep links fail
- Consider in-app browser for smoother flow (if Tauri supports it)

## References

1. **Tauri 2 Deep Link Plugin**: https://v2.tauri.app/plugin/deep-link/
2. **Android App Links**: https://developer.android.com/training/app-links
3. **Digital Asset Links**: https://developers.google.com/digital-asset-links
4. **OAuth 2.0 for Native Apps (RFC 8252)**: https://datatracker.ietf.org/doc/html/rfc8252
5. **Tauri Mobile Guide**: https://v2.tauri.app/start/create-project/#mobile

## Conclusion

The main blocker for Android mobile support in gau is the **incomplete deep link and OAuth redirect configuration**. The OAuth flow initiates correctly but fails at the callback stage because:

1. The Android app isn't configured to intercept the callback URLs
2. The server needs to be aware of mobile-specific redirect requirements
3. App Links verification is not set up

Implementing Solution 1 (HTTPS Deep Links with App Links) is recommended for production use, providing the most secure and seamless user experience.

**Estimated Implementation Effort**: 2-3 days
- Day 1: Update OAuth flow and deep link configuration
- Day 2: Test and debug on physical Android devices
- Day 3: Refine UX and add error handling

---

**Status**: This analysis provides a comprehensive roadmap for implementing Android mobile support. The code examples are based on Tauri 2 specifications and the current gau architecture. Implementation should be tested thoroughly on physical devices before production deployment.
