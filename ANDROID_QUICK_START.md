# Android Mobile Quick Start Guide

> **TL;DR**: Android mobile support is currently not working due to incomplete OAuth redirect and deep-link configuration. See [ANDROID_MOBILE_ANALYSIS.md](./ANDROID_MOBILE_ANALYSIS.md) for full technical details.

## Quick Problem Summary

gau works on web and desktop Tauri but **not on Android mobile** because:

1. ❌ OAuth callbacks can't reach the app (missing App Links)
2. ❌ Deep links aren't configured for production domains
3. ❌ Mobile browsers don't redirect properly back to app
4. ❌ Token passing mechanism incomplete for mobile

## Quick Solution Path

### For Development
1. Use a tunnel service (ngrok, cloudflare tunnel) instead of localhost
2. Configure OAuth providers with tunnel URL
3. Test on physical Android device

### For Production
1. Set up Android App Links
   - Add `.well-known/assetlinks.json` to your web server
   - Configure `tauri.conf.json` with your domain
   - Update Android manifest (auto-generated)

2. Modify OAuth redirect URLs
   - Desktop: `gau://oauth/callback`
   - Mobile: `https://yourdomain.com/auth/mobile/callback`

3. Test complete flow on physical device

## Estimated Effort

- **Basic working implementation**: 2-3 days
- **Production-ready with testing**: 1 week

## Next Steps

1. Read [ANDROID_MOBILE_ANALYSIS.md](./ANDROID_MOBILE_ANALYSIS.md) for:
   - Detailed root cause analysis (7 key issues)
   - Two solution architectures
   - Specific code changes needed
   - Testing checklist

2. Follow the implementation guide in the analysis document

3. Test on physical Android devices

## Key Files to Modify

- `packages/gau/src/runtimes/tauri/index.ts` - OAuth redirect logic
- `packages/example-sveltekit-tauri-mobile/src-tauri/tauri.conf.json` - Deep link config
- `packages/gau/src/core/handlers/callback.ts` - Server callback handler
- `packages/example-sveltekit-tauri-mobile/static/.well-known/assetlinks.json` - Android verification (new)

## Status

✅ Analysis complete
⏳ Implementation pending
📝 Technical roadmap available

See [TODO.md](./TODO.md) line 19 for tracking status.
