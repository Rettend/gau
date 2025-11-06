# Mobile OAuth Setup Guide

This guide explains how to set up OAuth authentication for the Android/iOS mobile app.

## Prerequisites

- A deployed web server with your SvelteKit app
- Android/iOS development environment set up
- OAuth providers (GitHub, Google, etc.) configured

## Android App Links Configuration

### 1. Get Your App's SHA-256 Fingerprint

For debug builds:
```bash
cd src-tauri/gen/android
./gradlew signingReport
```

For release builds, use your release keystore:
```bash
keytool -list -v -keystore path/to/release.keystore -alias your-alias
```

Copy the SHA-256 certificate fingerprint.

### 2. Update assetlinks.json

Edit `static/.well-known/assetlinks.json` and replace `YOUR_APP_SHA256_FINGERPRINT_HERE` with your actual SHA-256 fingerprint (with colons, e.g., `AA:BB:CC:...`).

```json
[
  {
    "relation": ["delegate_permission/common.handle_all_urls"],
    "target": {
      "namespace": "android_app",
      "package_name": "gau.sveltekit_mobile.dev",
      "sha256_cert_fingerprints": [
        "YOUR_ACTUAL_SHA256_FINGERPRINT"
      ]
    }
  }
]
```

### 3. Update Tauri Configuration

Edit `src-tauri/tauri.conf.json` and update the mobile deep-link host to your production domain:

```json
{
  "plugins": {
    "deep-link": {
      "mobile": [
        {
          "scheme": "https",
          "host": "your-production-domain.com",
          "pathPrefix": "/auth/mobile/"
        }
      ]
    }
  }
}
```

### 4. Deploy assetlinks.json

Make sure your SvelteKit app is configured to serve static files from the `static` directory. The file must be accessible at:

```
https://your-domain.com/.well-known/assetlinks.json
```

Test it:
```bash
curl https://your-domain.com/.well-known/assetlinks.json
```

### 5. Configure OAuth Redirect URLs

In your OAuth provider settings (GitHub, Google, etc.), add the mobile callback URL:

```
https://your-domain.com/auth/mobile/callback
```

## Development Setup

### Option 1: Use a Tunnel Service (Recommended)

Since mobile devices can't access `localhost`, use a tunnel:

**Using ngrok:**
```bash
ngrok http 4173
```

**Using Cloudflare Tunnel:**
```bash
cloudflare tunnel --url localhost:4173
```

Update your `.env` file with the tunnel URL:
```env
PUBLIC_API_URL=https://your-tunnel-url.ngrok.io/api/auth
```

### Option 2: Use Local Network IP

Update `tauri.conf.json`:
```json
{
  "build": {
    "devUrl": "http://192.168.x.x:4173"
  }
}
```

And update your `.env`:
```env
PUBLIC_API_URL=http://192.168.x.x:4173/api/auth
```

## Testing

### Test Deep Links on Android

Using ADB:
```bash
# Test the mobile callback deep link
adb shell am start -W -a android.intent.action.VIEW \
  -d "https://your-domain.com/auth/mobile/callback#token=test" \
  gau.sveltekit_mobile.dev
```

### Verify App Links

Use the Android App Links Assistant or test manually:
```bash
# Check if app handles the URL
adb shell dumpsys package d
```

Look for your package name and verify the intent filters.

### Debug OAuth Flow

1. Open the app on a physical Android device
2. Click "Sign in with GitHub" (or another provider)
3. Complete authentication in the browser
4. Check logcat for deep link events:
```bash
adb logcat | grep -i "deep-link\|gau"
```

## iOS Setup (Coming Soon)

iOS requires Universal Links with an `apple-app-site-association` file. The setup is similar to Android App Links.

## Troubleshooting

### Deep link not opening the app

1. Verify assetlinks.json is accessible
2. Check Android manifest has correct intent filters (auto-generated)
3. Ensure SHA-256 fingerprint matches your app's signing certificate
4. Try uninstalling and reinstalling the app
5. Clear Chrome/browser data on the device

### OAuth callback not working

1. Check that the callback URL is added to OAuth provider settings
2. Verify the mobile flag is being passed in the request
3. Check server logs for callback processing
4. Ensure the token is being passed in the URL hash

### Browser tab not closing after auth

This is expected behavior on mobile. The HTML page will show "Authentication Complete" message. The deep link should still trigger and open your app.

## Production Checklist

- [ ] assetlinks.json deployed and accessible
- [ ] Production domain configured in tauri.conf.json
- [ ] SHA-256 fingerprint from release keystore added to assetlinks.json
- [ ] OAuth providers configured with mobile callback URL
- [ ] App tested on physical devices
- [ ] App Links verification passing in Android settings
- [ ] Token persistence working across app restarts

## References

- [Android App Links](https://developer.android.com/training/app-links)
- [Digital Asset Links](https://developers.google.com/digital-asset-links)
- [Tauri Deep Link Plugin](https://v2.tauri.app/plugin/deep-link/)
- [OAuth 2.0 for Native Apps (RFC 8252)](https://datatracker.ietf.org/doc/html/rfc8252)
