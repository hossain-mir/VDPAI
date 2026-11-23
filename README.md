# VDPAI — Personal AI Assistant

VDPAI is a private, voice-enabled assistant project for Android and Termux. The Android app bundles its own local interface and can run without a backend. You can connect a supported AI provider in the app, or separately run the Python service in Termux. Provider requests send the prompt and conversation context to that provider; local-only mode does not call an AI model.

## What works today

- Futuristic dark HUD with four swipeable pages for AI Home, Personal Assistant, Control Center, and AI & Personalization; animated assistant core, waveform, live state, clock, quick prompts, and responsive layout.
- Streaming chat with provider adapters, conversation context, local conversation history, search, rename, delete, and export.
- Native Android speech recognition and Text-to-Speech through the system services, with language and voice controls where the device supports them.
- Provider configuration for supported OpenAI-compatible services and local/provider endpoints. Keys are not embedded in the APK or source repository.
- Local appearance, voice, prompt, and provider settings; user-managed memories, tasks, notes, reminders, data deletion, and conversation export.
- Profile names and switching controls, plus confirmed shortcuts to compose external actions.
- Optional Termux Python backend with local SQLite memory, validated tools, approval checks, and optional browser/vision features. Without a configured cloud provider, its replies are explicitly labelled local demo responses. The backend is separate from the Android app.
- Android Quick Settings tile to launch the app.

The default launcher icon is a temporary placeholder. Replace it with the owner's supplied artwork when available; see [assets/icon/README.md](assets/icon/README.md).

## Current limitations

This repository is a Capacitor/WebView Android app plus an optional Python service, not a Kotlin/Jetpack Compose app. The profile picker is present, but profiles do not yet isolate chats, memories, provider keys, or settings; do not use profiles to separate users or private data. The memory editor stores facts the user enters, but there is no encrypted API-key storage. Persistent Android foreground listening is unavailable; its control is disabled and voice input only runs after the user starts it while the app is open. Wake phrase recognition is limited to the active app session; Android speech recognition may use a network service depending on device settings. External shortcuts can open or prepare a dialer, SMS, email, WhatsApp, and websites, but VDPAI does not send messages or place calls. Some device controls depend on WebView and hardware support. There is no Windows companion application.

Android API keys and conversation data are stored in app-private preferences, but the JavaScript storage is not encrypted at rest. Device/root access or an app-data extraction can expose it. Use provider-side key restrictions and delete credentials from the app before sharing a device. Cloud AI providers receive the content needed to answer your request. No analytics are enabled by default.

## Requirements

### Android APK build

- Node.js 22 or newer and npm 10 or newer
- JDK 21
- Android SDK platform 36 and build-tools 36.0.0
- Gradle wrapper 8.14.3 (included)

Build on a computer with Android SDK installed:

```sh
npm ci
npm run build
npm run cap:sync
cd android
./gradlew assembleDebug --no-daemon
```

APK: `android/app/build/outputs/apk/debug/app-debug.apk`.

The debug APK is not a Play Store release. Release distribution requires a privately managed signing key and a release build configuration. Never commit signing keys or API credentials.

GitHub Actions runs the checks and debug APK build on pushes, pull requests, and manual dispatch. A successful run uploads `VDPAI-Android-APK` as a downloadable workflow artifact. Pushing a `v*` tag also publishes that same **debug-signed test APK** as a GitHub prerelease with release notes. A production-signed release is not configured because this repository has no release keystore; never add a private keystore to source control.

### Termux backend (optional)

The Android app does not need Python or a server to launch. To run the optional Python backend in Termux:

```sh
pkg install python curl
bash scripts/install.sh
bash scripts/start.sh --bg
```

Open `http://127.0.0.1:8000` in a browser. Configure backend/provider settings according to `.env.example` and the in-app settings. Do not expose the backend to the public internet without configuring authentication and HTTPS. The Android app's optional backend URL accepts HTTPS; the bundled HUD itself remains available offline.

## Project layout

```text
backend/                 Optional Starlette service, tools, SQLite memory
frontend/                Bundled responsive assistant interface
android/                 Capacitor Android wrapper and native voice/tile bridge
scripts/                 Termux setup, server, asset, and web bundle scripts
tests/                   Existing backend and JavaScript checks
```

## Privacy and permissions

The Android manifest requests Internet and microphone access. The microphone is used only after the user starts voice input and grants permission. Android's recognition and speech engines process voice according to the selected system service; network use may occur. The app does not declare notification-reading access or run an always-on microphone service. No provider secret is hardcoded. A cloud provider receives user prompts and recent conversation context when selected. The optional backend has its own storage and network behavior; review its configuration before exposing it to another device.

App-local data can be exported or deleted in Control Center → Privacy. Export redacts provider API keys. Clearing app data through Android also removes local settings and history.

## Testing and troubleshooting

The repository contains existing automated checks under `tests/` and an Android build workflow under `.github/workflows/`. Run checks from a Node/Python development environment with dependencies installed. A successful build in CI or on your machine is required before calling an APK release-ready; no APK is included in this repository by default.

Common issues:

- **Voice unavailable:** allow microphone access and check that Android has a speech recognition and TTS service installed.
- **Provider request fails:** verify the API key, model ID, endpoint, network, and provider account limits in Control Center.
- **Microphone unavailable on LAN browser:** browser microphone access generally requires HTTPS or localhost. The bundled Android app uses the native bridge.
- **Gradle cannot find the SDK:** install Android SDK platform 36/build-tools 36.0.0 and set `ANDROID_HOME` or `local.properties` on the build machine.
- **APK cannot connect to an HTTP backend:** cleartext networking is disabled in Android. Use HTTPS or run the HUD fully locally.

## Repository hygiene

`.gitignore` excludes `.env`, databases, logs, build output, APKs, credentials, and signing material. Before publishing, inspect `git status --short` and confirm that no private data or keys are staged. Keep the owner-provided launcher artwork out of the repository until approved.
