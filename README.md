# JARVIS AI — Termux-hosted assistant + Capacitor Android APK

A self-hosted, provider-independent AI assistant whose Python backend runs in Termux and is controlled through a futuristic, mobile-first browser HUD. SQLite memory, validated tools, voice input, vision input, live event stream, and optional browser automation. An **optional Capacitor Android wrapper** packages the HUD locally into an APK; you enter your backend address in the app after installing. No Python runs inside the APK.

**Current mode:** `DEMO MODE` — no API key is configured, so replies come from explicit local rules. Everything else (server, memory, tools, HUD, security, WebSocket) is real and running. The HUD labels demo replies clearly and never pretends to be a language model.

**Authentication:** token-gated for public/untrusted networks; trusted localhost and LAN addresses open the HUD directly with no login screen. The server holds a 256-bit access token in the owner-only `.env`. See [Security](#security).

---

## Live URLs

| Access | URL |
| --- | --- |
| Local (phone browser) | **http://127.0.0.1:8000** |
| Same Wi-Fi (other device) | **http://192.168.0.4:8000** (or the device's current LAN IP, e.g. `http://192.0.0.4:8000`) |
| Health check | http://127.0.0.1:8000/api/health |

The server binds `0.0.0.0:8000`, so any interface address on the device works; the exact LAN IP can change with the network. Both `192.168.0.4` and `192.0.0.4` are trusted by default (private RFC1918 ranges plus `192.0.0.0/24`). Add more networks with `JARVIS_TRUSTED_CIDRS` if needed.

> Microphone access requires `127.0.0.1` or HTTPS. Chrome blocks the mic on plain `http://192.168.0.4:8000`. Use the local URL, or an HTTPS tunnel (`bash scripts/tunnel.sh`, needs a token).

---

## Quick start (Termux)

```bash
cd /data/user/0/com.termux/files/home/projects/JARVIS-AI
bash scripts/install.sh          # deps, dirs, .env (600), SQLite
bash scripts/start.sh --bg       # background; logs/jarvis.pid + logs/server.out
bash scripts/stop.sh             # stop
bash scripts/start.sh            # foreground (Ctrl+C to stop)
bash scripts/start.sh --open     # also open Android browser
bash scripts/start.sh --port 8080
```

Requirements: Termux with `python` and `curl` (`pkg install python curl`). **No APK, no Android Studio, no Node.js required for the browser app.** Node is only used by the optional development tests and the APK build.

Open <http://127.0.0.1:8000>. The HUD creates a session cookie and CSRF token automatically on load and opens **directly on the main HUD — there is no Secure Access screen**. Localhost and trusted LAN clients (private RFC1918 ranges, `192.0.0.0/24`, plus any `JARVIS_TRUSTED_CIDRS`) are unauthenticated. Public/untrusted addresses still require the access token. Never expose the unauthenticated server through a public link — add a reverse proxy with its own auth or enable token enforcement first.

---

## Preparing the GitHub repository

The working tree is ready to publish; no secrets are staged. `.gitignore` excludes `.env`, all `.env.*` variants except `.env.example`, keys/certificates/keystores, private databases, logs, virtualenvs, runtime data and build output.

```bash
cd /data/user/0/com.termux/files/home/projects/JARVIS-AI

git init
git add .
git check-ignore -v .env          # must print a .gitignore rule, not "not ignored"
git status --short                # verify .env / *.db / *.log are absent
git commit -m "Initial import: JARVIS AI backend, HUD and Capacitor Android wrapper"
git branch -M main
git remote add origin https://github.com/<your-user>/<your-repo>.git
git push -u origin main
```

If the folder is already a repository, skip `git init`/`remote add`. Never commit a real `.env`, token, DB, or keystore. Copy `.env.example` to `.env` on each machine and set `JARVIS_ACCESS_TOKEN` there. The `scripts/*.sh` files keep their Termux shebang for this device; on other Linux/macOS machines run them as `bash scripts/<name>.sh`.

No repository variable is needed to build the APK. The HUD is bundled with the app and the server address is configured later inside the app. An optional `JARVIS_BACKEND_URL` is supported only for local builds where you want a default address baked in; it must be `https://` (or `http://localhost` for development).

---

## Android APK (Capacitor wrapper)

The APK is a thin WebView wrapper with the HUD bundled locally. The Python/Starlette backend stays **separate** and runs where you host it. Nothing in the APK contains an access token or provider key.

### How it works

* `npm run build` copies the existing `frontend/` into `www/`, generates `www/js/native-config.js`, and injects that script into `www/index.html`. The browser version at `http://127.0.0.1:8000` is untouched: with no configured base it keeps its exact same-origin behaviour.
* The APK launches directly into the HUD with no startup form and works offline. A small backend indicator in the core shows ONLINE / OFFLINE / LOCAL. Configure, test, connect, disconnect, update or clear the address under **System → Backend server**. Disconnecting keeps the saved address but stops automatic retries until Connect is pressed. The URL is saved through Capacitor Preferences (app-private Android storage; browser falls back to `localStorage`). `frontend/js/settings.js` validates it; `frontend/js/api.js` resolves it on every request and reconnects the WebSocket when it changes. An address is not a credential and is never committed to the repository.
* The APK accepts only `https://` addresses: Android requires a secure context for microphone access and the manifest blocks cleartext traffic. The browser HUD still accepts plain HTTP on trusted networks as before. No fake or placeholder production URL is shipped.
* `capacitor.config.js` only uses `server.url` when `JARVIS_BACKEND_URL` is supplied for a local build; GitHub Actions leaves it empty so the bundled HUD is used.
* `frontend/js/native.js` registers an Android `backButton` listener through Capacitor's bridge. It first closes the approval dialog or settings sheet; only then does it minimize (or exit) the app. It is a no-op in the browser and is imported by `app.js`.
* The backend allows credentialed CORS from the APK's `http://localhost` WebView origin and issues `SameSite=None; Secure` session cookies over HTTPS. Requests from your LAN are trusted automatically; if you set `JARVIS_ACCESS_TOKEN`, a publicly hosted backend still requires either a trusted proxy/network or the same-origin mode below.
* Network security config sets `cleartextTrafficPermitted="false"` for the Android app; `INTERNET`, `RECORD_AUDIO` and `CAMERA` permissions are declared, with camera/microphone marked optional so the app installs on devices without them.
* A native **Quick Settings tile** named `J.A.R.V.I.S.` is provided by `JarvisTileService.kt` (Kotlin). Open **Quick Settings → Edit tiles → J.A.R.V.I.S.** to add it. Tap launches the existing HUD; a long press opens Android's **App Info** screen (the platform default for third-party tiles, supported on Android 13/16). It uses a Liquid-Glass-style concentric core icon, Android 13+ immutable `PendingIntent` launching, and binds only with `BIND_QUICK_SETTINGS_TILE` — no extra app permission is requested.
* **System → Settings dashboard** contains working controls for backend connection, AI providers/API keys/model selection, voice TTS/wake phrase, language, permissions, reduced-motion appearance, native bridge diagnostics, privacy (clear local data, audit log), and About. Reduced motion stops the core/waveform animation loops to save battery.

### Required dependencies for an APK build

| Dependency | Version |
| --- | --- |
| Node.js | 22+ (Capacitor 8 requirement; CI uses 22) |
| npm | 10+ (CI uses the bundled npm) |
| JDK | 21 (Temurin in CI) |
| Android SDK platform | 36 |
| Android build-tools | 36.0.0 |
| Gradle | wrapper 8.14.3 (included) |
| npm packages | `@capacitor/android`, `@capacitor/app`, `@capacitor/cli`, `@capacitor/core`, all `8.6.2` / `8.1.2` as pinned in `package.json` |

### Build instructions (GitHub Actions — recommended)

1. Push to `main`, open a pull request, or run the workflow manually from the **Actions** tab → **Build JARVIS AI debug APK** → **Run workflow**. No repository variable is required.
2. The workflow installs Python and Node dependencies, runs all tests, builds the bundled `www/`, regenerates icons/splash, syncs Capacitor, assembles the debug APK, verifies the file exists and uploads it as the `jarvis-ai-debug-apk` artifact.
3. Install the APK and open JARVIS — it launches straight into the HUD, even with no backend. Configure your HTTPS address any time under **System → Backend server**. Your backend does not need to exist yet when the APK is built.

### Build instructions (local machine with Android SDK)

```bash
# Node 22+, JDK 21, ANDROID_HOME set, SDK platform 36 + build-tools 36.0.0 installed
# Optional: export JARVIS_BACKEND_URL="$BACKEND_URL"  # bakes in a default HTTPS address
npm ci
npm run build
npm run assets
npm run cap:sync
cd android && ./gradlew assembleDebug --no-daemon
```

### APK output location

```
android/app/build/outputs/apk/debug/app-debug.apk
```

This exact path is checked (non-empty) by CI before the artifact is uploaded. No APK is claimed as built unless that file exists. A successful build is available as the `jarvis-ai-debug-apk` artifact on the [latest workflow run](https://github.com/hossain-mir/JARVIS-AI/actions/workflows/build-apk.yml).

### Android project structure

```
android/
├── app/
│   ├── build.gradle                    applicationId com.jarvis.ai, SDK versions
│   ├── capacitor.build.gradle          generated Capacitor plugin wiring
│   └── src/main/
│       ├── AndroidManifest.xml         INTERNET/RECORD_AUDIO/CAMERA, tile service, HTTPS config
│       ├── java/com/jarvis/ai/MainActivity.java
│       ├── java/com/jarvis/ai/JarvisTileService.kt   native Quick Settings tile
│       ├── assets/                     generated by `cap sync` (not committed)
│       │   ├── capacitor.config.json
│       │   ├── capacitor.plugins.json
│       │   └── public/                 copy of www/
│       └── res/
│           ├── mipmap-*/               JARVIS launcher icons (generated)
│           ├── drawable/ic_tile_core.xml  Liquid-Glass core tile icon
│           ├── drawable-*/splash.png   JARVIS splash screens (generated)
│           ├── values/colors.xml       #02070A / #58E7FF theme colours
│           ├── values/ic_launcher_background.xml
│           └── xml/network_security_config.xml   cleartext disabled
├── gradle/wrapper/                     gradle 8.14.3 wrapper
├── build.gradle / variables.gradle / settings.gradle
└── gradlew
```

Icons and splash screens are produced by `scripts/make-android-assets.mjs` (pure Node, no image binaries). Microphone permission is requested by the Web Speech / `getUserMedia` code on first use; camera permission is requested when the vision panel opens the device camera via `<input type="file" capture="environment">`.

---

## Architecture

```
JARVIS-AI/
├── main.py                     launcher, port check, startup banner
├── config.py                   .env parsing, provider metadata, validation
├── requirements.txt            Starlette stack (no FastAPI — see below)
├── backend/
│   ├── app.py                  ASGI app, routes, static mounts, middleware
│   ├── api/{routes,ws}.py      REST endpoints + WebSocket event stream
│   ├── core/{events,state,errors}.py   event bus, runtime state, error types
│   ├── security/{auth,middleware,audit}.py  sessions, CSRF, rate limits, audit
│   ├── memory/store.py         SQLite messages/notes/prefs + search + backup
│   ├── intelligence/
│   │   ├── engine.py           chat orchestration, tools, vision, streaming text
│   │   ├── providers.py        provider adapters, keys, selection, test
│   │   └── demo.py             labelled local-rule fallback
│   ├── tools/{registry,builtin}.py  validated tools, approvals, timeouts
│   ├── voice/engine.py         wake phrase, transcript cleanup, language rules
│   ├── automation/browser.py   SSRF-safe fetch/search + optional Playwright
│   └── vision/                 image validation and analysis routing
├── frontend/
│   ├── index.html              HUD layout
│   ├── css/styles.css          black / cyan / emerald glassmorphism
│   └── js/*.js                 core, wave, voice, api, settings, panels, ui, state, app, native
├── scripts/                    install/start/stop/backup/tunnel/set-token/test
│                               + build-www.mjs, make-android-assets.mjs
├── package.json / package-lock.json   Capacitor build manifest (Node 22+, Preferences plugin)
├── capacitor.config.js         app id/name, optional HTTPS default URL, mixed-content policy
├── www/                        generated copy of frontend/ (git-ignored)
├── android/                    generated Capacitor Android project (see above)
├── .github/workflows/build-apk.yml    tests + debug APK + artifact upload
├── tests/                      208-check API suite + jsdom HUD, no-lock and offline smoke tests
└── database/, logs/, workspace/  runtime data (git-ignored)
```

The animated core and waveform are driven by real state transitions from the event bus (`thinking`, `tool`, `speaking`, `idle`) and real microphone amplitude — not decorative fake loops.

---

## Connecting a real AI provider

Either edit `.env` or use the **Settings → Provider / Keys** panel in the HUD (keys are stored server-side, never in browser storage and never returned by the API).

Supported adapters: **OpenAI**, **Gemini**, **Groq**, **OpenRouter**, **Ollama** (local), **Custom OpenAI-compatible**.

```dotenv
# Example: Groq
GROQ_API_KEY=gsk_...
JARVIS_DEFAULT_PROVIDER=groq
```

```dotenv
# Example: local Ollama (BOTH lines must be uncommented)
OLLAMA_BASE_URL=http://127.0.0.1:11434/v1
OLLAMA_MODEL=llama3.2
JARVIS_DEFAULT_PROVIDER=ollama
```

`JARVIS_DEFAULT_PROVIDER=auto` picks the first configured provider. If none is configured or a request fails, JARVIS falls back to clearly labelled demo replies. Use the HUD's **Test** button (`POST /api/providers/test`) to verify a key before selecting it.

API keys are never exposed by `GET /api/providers` or `/api/config`; env var *names* are not leaked either.

---

## Voice

* Browser SpeechRecognition (Web Speech API) + SpeechSynthesis TTS.
* Languages: **English (`en-US`)**, **বাংলা (`bn-BD`)**, **हिन्दी (`hi-IN`)**.
* Wake phrase: **"Hey Jarvis"** while the HUD tab is open (also "Hi Jarvis" / "Ok Jarvis", plus localized variants). Typing always works as a fallback.
* The mic button asks for permission on first use; if recognition is unavailable, JARVIS shows an honest error and keeps text input available.

**Honest limits:** Android Chrome's Web Speech API sends audio to Google's speech service and needs network + mic permission. There is no true background/hotword listener from a browser in Termux — "Hey Jarvis" only works while the HUD tab is active. `file://` and plain-LAN `http://` are not secure contexts for the mic. TTS voice quality depends on what Android has installed.

---

## Memory, tools and automation

* SQLite (`database/jarvis.db`): chat history, notes, preferences. Search, delete with confirmation, JSON export and backup (`scripts/backup.sh`).
* 12 built-in tools: `calculator`, `get_datetime`, `system_info`, `list_files`, `create_file`, `delete_file`, `memory_search`, `note_create`, `note_search`, `web_search`, `fetch_page`, `open_website`.
* Tools are schema-validated, confined to the workspace, time-limited, and audited. Destructive/unusual actions require an explicit approve token (`/api/tools/pending` → `/api/tools/approve/{token}`). **No arbitrary shell execution is ever exposed.**
* `fetch_page`/`web_search` re-validate every redirect to block SSRF into private networks (`JARVIS_ALLOW_PRIVATE_URLS=0` by default). Live `https://example.com` fetch and DuckDuckGo search were verified.
* Optional Playwright screenshots/actions: if Chromium is not installed, endpoints return a clear `UnsupportedError` instead of faking success.
* Vision upload validates size/type and reports a clear 501 when no vision-capable model is connected.

---

## Security

* **Trusted networks** (`127.0.0.0/8`, `::1`, `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`, `192.0.0.0/24`, plus `JARVIS_TRUSTED_CIDRS`) are allowed unauthenticated — the HUD opens directly with no login screen. Every other address must present the token. Set `JARVIS_LOCAL_AUTO_UNLOCK=0` to disable trusted-network bypass.
* A strong token is generated and stored in `.env` (mode `600`). Public / untrusted clients use `POST /api/unlock` to exchange it for an opaque `jarvis_unlock` grant cookie; the real token is **never** stored in a browser cookie, frontend JS/HTML, a URL, or server logs.
* Grant login rotates the session id and CSRF token; a per-IP failed-attempt lockout slows guessing. `POST /api/logout` revokes a grant immediately.
* HttpOnly session cookie + CSRF header (`X-Jarvis-CSRF`) on all mutating API calls. `/api/health`, `/api/session` and `/api/unlock` are public; all other endpoints require a trusted IP or a valid grant/token header.
* WebSocket authenticates with the same browser cookies; API clients can use an `X-Jarvis-Token` header. Tokens in WebSocket URLs are rejected and never logged.
* Per-IP rate limits (global, chat, voice, unlock, tools, provider config), body-size limits, CSP, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`, strict origin checks.
* **Never expose the unauthenticated server publicly.** LAN access is trusted by design; the wider internet requires the token plus an HTTPS tunnel. `scripts/tunnel.sh` refuses to run without a token.

### Authentication — retrieve or reset the token

```bash
bash scripts/show-token.sh     # owner-only: prints the token in THIS terminal
bash scripts/set-token.sh      # generate a new random token and save it to .env
bash scripts/set-token.sh "your-long-token"   # or supply your own
bash scripts/stop.sh && bash scripts/start.sh --bg
```

You can also read the `JARVIS_ACCESS_TOKEN=` line in `/data/user/0/com.termux/files/home/projects/JARVIS-AI/.env` (owner-only permissions). Restarting after a reset revokes all existing browser logins, so every device must unlock again. The token is deliberately not shown in the HUD, API responses, or logs — if you lose it, reset it rather than looking for it somewhere else.

**Why Starlette, not FastAPI:** the Termux Python 3.14 image ships a broken pydantic v1 and has no Rust toolchain for pydantic v2, so FastAPI crashes on import. Starlette is the ASGI layer FastAPI is built on; the REST/WebSocket behaviour is equivalent.

---

## API reference

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/api/health` | Public liveness probe |
| GET | `/api/session` | Public session cookie + CSRF handshake (reports lock state) |
| POST | `/api/unlock` | CSRF-protected token exchange → opaque grant cookie |
| POST | `/api/logout` | Revoke grant and rotate away the session |
| GET | `/api/status` | Runtime status, provider, memory, warnings |
| GET | `/api/config` | Safe client config (no secrets) |
| POST | `/api/chat` | Text chat (tools, memory, provider fallback) |
| POST | `/api/voice` | Voice transcript → command + reply |
| GET | `/api/tools` | Tool catalogue |
| POST | `/api/tools/execute` | Run a validated tool |
| GET | `/api/tools/pending` | Pending approvals |
| POST | `/api/tools/approve/{token}` / `reject/{token}` | Approval decisions |
| GET | `/api/providers` | Provider list/status (no keys) |
| POST | `/api/providers/test` | Test a provider |
| POST | `/api/providers/select` | Choose active provider |
| POST | `/api/providers/config` | Store key/base/model server-side |
| GET/POST | `/api/memory` | Overview/search / create message |
| GET/POST | `/api/memory/notes` | Notes list / create |
| PATCH/DELETE | `/api/memory/notes/{id}` | Edit / delete note |
| GET/DELETE | `/api/memory/messages` | History / confirmed clear |
| POST | `/api/memory/backup` | Create backup |
| GET | `/api/memory/export` | Download JSON |
| GET | `/api/vision/status` | Vision capability |
| POST | `/api/vision/analyze` | Image analysis |
| GET | `/api/automation/status` | Browser automation capability |
| POST | `/api/automation/{fetch,search,screenshot,actions}` | Optional automation |
| GET | `/api/audit` | Recent audit events |
| GET | `/api/network` | Network/LAN diagnostics |
| WS | `/ws` | Live event stream (hello + events + heartbeat) |

Only `/api/health`, `/api/session` and `/api/unlock` are public. All other API calls require either a trusted-network IP, a valid unlock grant cookie, or an API token header, plus the session cookie; mutating calls also require the CSRF header. WebSocket clients use cookies or `X-Jarvis-Token` — never a token in the URL.

---

## Tests

```bash
bash scripts/test.sh                         # 208 Python checks (real subprocess server)

cd tests && npm install                      # optional jsdom-based HUD tests
node frontend_smoke.mjs                      # 42 HUD checks, no token
node no_lock_smoke.mjs                       # 19 checks: no lock screen, HUD boots directly
node offline_smoke.mjs                       # 8 checks: HUD opens with no backend
cd ..

npm ci && npm run test:js                    # all three JS test suites from the repo root
python -m compileall -q backend config.py main.py tests
python -m pip check
```

Full results, environment and honest gaps: **[TEST_REPORT.md](TEST_REPORT.md)**.

---

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| `Port 8000 is already in use` | `bash scripts/stop.sh` or `bash scripts/start.sh --port 8080` |
| `csrf_failed` / `unauthorized` in HUD | Reload the page to refresh session + CSRF |
| `auth_required` from a public/tunnel URL | That address is not trusted; use local/LAN, add its CIDR to `JARVIS_TRUSTED_CIDRS`, or put an authenticated proxy in front |
| Lock screen still cached | Old build — hard-refresh the page; the login UI has been removed from the frontend |
| Lost the token | `bash scripts/set-token.sh` then restart; existing grants are revoked |
| Replies say DEMO MODE | Add a provider key in Settings or `.env`, then restart/test |
| Mic does not start | Use `http://127.0.0.1:8000` or HTTPS; grant mic permission; check device volume |
| LAN URL not reachable | Same Wi-Fi only; check Android firewall/VPN; check `/api/network` |
| Install fails on pip | `pkg install python curl` then `python -m pip install -r requirements.txt` |
| Screenshot unsupported | Install Playwright + Chromium; endpoint reports honestly until then |

---

## Known limitations (no false claims)

* Without a provider key, intelligence is rule-based demo output — clearly labelled as such.
* No background hotword listener; voice wake requires the HUD tab to be open.
* The APK is a WebView wrapper, not a native Python runtime or background service. After installation it needs a reachable HTTPS backend address entered in the app.
* The APK is built in GitHub Actions. This authoring environment has no JDK/Android SDK, so **no APK is claimed built here**; check the Actions artifact for the real file.
* Playwright/Chromium, real microphone/TTS hardware, visual rendering and the compiled APK could not be verified in this environment (see test report).
* Public tunnels are unsafe without `JARVIS_ACCESS_TOKEN`; the script enforces this.

**JARVIS AI v1.0.0 — browser app preserved; Capacitor wrapper added without changing HUD behaviour.**
