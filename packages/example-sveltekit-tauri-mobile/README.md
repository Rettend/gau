# Tauri 2

Tauri on mobile is hard, figure it out yourself. glhf

## Dev

- Use `adb reverse` to forward the ports to your device (once)

```bash
adb reverse tcp:1420 tcp:1420
adb reverse tcp:1430 tcp:1430
```

- Start android dev

```bash
nr tauri android dev
```

- Note the host that Tauri picks

```bash
Info Using 192.168.0.7 to access the development server.
```

- Set `PUBLIC_API_URL` to this host (the app uses it for `/api/auth`).

```bash
PUBLIC_API_URL=http://192.168.0.7:1420/api/auth
```

### Notes

- If `PUBLIC_API_URL` is not set on Android, relative `/api/auth` which will not work on mobile, so set it.
- GitHub works with plain http/IP in dev. Google doesn’t, skip Google in dev, or use a real domain for Google.

## Prod

- Web (Cloudflare Workers): Deploy SvelteKit with adapter-cloudflare. Base URL: <https://yourapp.com/api/auth>
- Tauri Desktop: system browser → <https://yourapp.com/api/auth/github> → GitHub → <https://yourapp.com/api/auth/github/callback> → deep link back via gau://oauth/callback
- Tauri Mobile: system browser → <https://yourapp.com/api/auth/github> → GitHub → <https://yourapp.com/api/auth/github/callback> → deep link back via gau://oauth/callback

Server config (gau):

- Keep trustHosts to include `'tauri.localhost'` for desktop/mobile, plus your production host if needed.
- For simplicity you can use `trustHosts: 'all'` in dev; in prod, specify allowed hosts.

Provider redirect URIs (prod): <https://yourapp.com/api/auth/github/callback>

## Release build

### Desktop

- `nr tauri build -- --bundle`
- Desktop uses the same OAuth flow via system browser and returns to `gau://oauth/callback`.

### Android

#### 0. One‑time setup

- If you haven’t initialized Android yet:
  - `bun run tauri -- android init`
- Ensure Android toolchain is installed (Android Studio → SDK, Platform Tools, NDK).
- Ensure Rust targets are installed (at least arm64): `rustup target add aarch64-linux-android`
- You can use Android Studio’s bundled JDK `keytool` at `C:\Program Files\Android\Android Studio\jbr\bin\keytool.exe`.

#### 1. Create an upload keystore (Windows CMD)

```cmd
keytool -genkey -v -keystore %USERPROFILE%\upload-keystore.jks -storetype JKS -keyalg RSA -keysize 2048 -validity 10000 -alias upload
```

Do not commit this file.

#### 2. Create `keystore.properties`

- File: `src-tauri/gen/android/keystore.properties`
- Content:

```txt
password=<password you entered when creating the keystore>
keyAlias=upload
storeFile=C:\\Users\\<your user>\\upload-keystore.jks
```

Keep this file private (do not commit it).

#### 3. Configure Gradle to use the signing key

- File: `src-tauri/gen/android/app/build.gradle.kts`
  1. Add import at the top:

     ```kotlin
     import java.io.FileInputStream
     ```

  2. Add a `signingConfigs` block before `buildTypes`:

     ```kotlin
     signingConfigs {
         create("release") {
             val keystorePropertiesFile = rootProject.file("keystore.properties")
             val keystoreProperties = Properties()
             if (keystorePropertiesFile.exists()) {
                 keystoreProperties.load(FileInputStream(keystorePropertiesFile))
             }
             keyAlias = keystoreProperties["keyAlias"] as String
             keyPassword = keystoreProperties["password"] as String
             storeFile = file(keystoreProperties["storeFile"] as String)
             storePassword = keystoreProperties["password"] as String
         }
     }
     ```

  3. Point `buildTypes.release` to the signing config:

     ```kotlin
     buildTypes {
         getByName("release") {
             signingConfig = signingConfigs.getByName("release")
         }
     }
     ```

References: Tauri Android signing docs — see link at the end.

#### 4. Build signed release

- Signed APK (default):

```cmd
bun run tauri -- android build --release
```

- Play Store bundle (AAB):

```cmd
bun run tauri -- android build --release -- --aab
```

Outputs (typical Gradle locations):

- APK: `src-tauri/gen/android/app/build/outputs/apk/release/app-release.apk`
- AAB: `src-tauri/gen/android/app/build/outputs/bundle/release/app-release.aab`

Notes:

- For Play Console, upload the AAB. Google Play App Signing can be used; your `upload-keystore.jks` is your upload key.
- In production, make sure the app points to your hosted auth base, e.g. set `PUBLIC_API_URL=https://yourapp.com/api/auth`. The deep-link scheme remains `gau://oauth/callback`.

Android Code Signing (Tauri): <https://v2.tauri.app/distribute/sign/android/>
