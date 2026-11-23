#!/usr/bin/env node
/* HSAI 2.0 — static production checks.
 *
 * These checks fail fast on the mistakes that produce a broken APK: missing
 * assets, dead module imports, an unbundled bare import, a startup form, a
 * stale JARVIS route, the wrong package ID or a workflow that uploads nothing.
 *
 * They do not replace the runtime smoke test or the Gradle build.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const FRONTEND = join(ROOT, "frontend");
const failures = [];
const warnings = [];

function check(name, condition, detail = "") {
  if (condition) {
    console.log(`PASS  ${name}`);
  } else {
    failures.push(`${name}${detail ? ` — ${detail}` : ""}`);
    console.log(`FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

function read(relative) {
  return readFileSync(join(ROOT, relative), "utf8");
}

function listFiles(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? listFiles(join(dir, entry.name)) : [join(dir, entry.name)],
  );
}

/* --------------------------------------------------------------- core assets */
const requiredFiles = [
  "frontend/index.html",
  "frontend/css/styles.css",
  "frontend/manifest.webmanifest",
  "frontend/assets/favicon.svg",
  "frontend/js/app.js",
  "frontend/js/store.js",
  "frontend/js/providers.js",
  "frontend/js/ai.js",
  "frontend/js/backend.js",
  "frontend/js/control.js",
  "frontend/js/history.js",
  "frontend/js/voice.js",
  "frontend/js/ui.js",
  "frontend/js/core.js",
  "frontend/js/wave.js",
  "frontend/js/state.js",
  "frontend/js/native.js",
  "frontend/js/native-config.js",
  "scripts/build-www.mjs",
  "scripts/make-android-assets.mjs",
  "android/app/src/main/AndroidManifest.xml",
  "android/app/src/main/java/com/hsai/assistant/MainActivity.java",
  "android/app/src/main/java/com/hsai/assistant/HsaiVoicePlugin.java",
  "android/app/src/main/java/com/hsai/assistant/HsaiTileService.kt",
  "android/app/src/main/res/values/strings.xml",
  "android/app/src/main/res/xml/network_security_config.xml",
  "capacitor.config.js",
  "package.json",
  ".github/workflows/build-apk.yml",
  "assets/icon/README.md",
];
const missingFiles = requiredFiles.filter((file) => !existsSync(join(ROOT, file)));
check("required HSAI files exist", missingFiles.length === 0, missingFiles.join(", "));

const obsolete = ["frontend/js/api.js", "frontend/js/panels.js", "frontend/js/settings.js"].filter((file) =>
  existsSync(join(ROOT, file)),
);
check("obsolete JARVIS frontend modules removed", obsolete.length === 0, obsolete.join(", "));

/* ------------------------------------------------------------------ index.html */
const html = read("frontend/index.html");
check("page declares VDPAI", /<title>VDPAI<\/title>/.test(html) && html.includes("<strong>VDPAI</strong>"));
check("page is a mobile HUD", html.includes('name="viewport"') && html.includes('content="width=device-width'));
check("HUD boots without a startup/server screen", !/bootBackendForm|INITIALISING JARVIS CORE|startup form/i.test(html));
check("no JARVIS product branding remains", !/JARVIS AI|Jarvis AI|JARVIS CORE|Hey Jarvis/.test(html));

const scriptTags = [...html.matchAll(/<script\b([^>]*)><\/script>/g)].map((match) => match[1]);
const configIndex = scriptTags.findIndex((tag) => tag.includes("/js/native-config.js"));
const appIndex = scriptTags.findIndex((tag) => tag.includes("/js/app.js"));
check(
  "native configuration loads before the app module",
  configIndex >= 0 && appIndex > configIndex && scriptTags[appIndex].includes('type="module"'),
  `order: ${scriptTags.join(" | ")}`,
);

const localReferences = [...html.matchAll(/(?:src|href)="([^"]+)"/g)]
  .map((match) => match[1])
  .filter((value) => value.startsWith("/") && !value.startsWith("//"));
const unresolved = localReferences.filter((value) => !existsSync(join(FRONTEND, value.replace(/^\//, ""))));
check("every local HTML asset exists", unresolved.length === 0, unresolved.join(", "));

const requiredIds = [
  "app", "coreCanvas", "waveCanvas", "transcript", "chatForm", "chatInput", "micBtn",
  "chipProvider", "chipMic", "chipVoice", "chipBackend", "responseText", "responseMeta",
  "copyBtn", "replayBtn", "stopGenBtn", "voiceStopBtn", "ttsQuickBtn", "newChatBtn",
  "historyBtn", "controlBtn", "controlCenter", "ccTabs", "addProviderBtn", "providerList",
  "providerForm", "providerType", "providerName", "providerKey", "providerModel",
  "providerBase", "providerEndpoint", "toggleKeyBtn", "providerTestBtn", "providerSaveBtn",
  "systemPrompt", "saveSystemPrompt", "ttsToggle", "languageSelect", "voiceSelect",
  "speechRate", "speechVolume", "testVoiceBtn", "stopVoiceBtn2", "micPermissionBtn",
  "backendForm", "backendUrl", "backendTestBtn", "backendDisconnectBtn", "backendClearBtn",
  "exportHistoryBtn", "clearHistoryBtn", "clearAllDataBtn", "themeSelect", "lowGlowToggle",
  "reduceMotionToggle", "gridToggle", "historySheet", "historyList", "historySearch",
  "confirmModal", "promptModal", "toasts",
];
const missingIds = requiredIds.filter((id) => !new RegExp(`\\bid="${id}"`).test(html));
check("all required controls are present", missingIds.length === 0, missingIds.join(", "));

/* ----------------------------------------------------------------------- JS */
const jsFiles = listFiles(join(FRONTEND, "js")).filter((file) => file.endsWith(".js"));
const jsSources = new Map(jsFiles.map((file) => [file, readFileSync(file, "utf8")]));

function importSpecifiers(source) {
  const specifiers = [];
  const pattern = /\b(?:import|export)\s+(?:[^"']*?\s+from\s+)?["']([^"']+)["']/g;
  let match;
  while ((match = pattern.exec(source))) specifiers.push(match[1]);
  const dynamic = /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g;
  while ((match = dynamic.exec(source))) specifiers.push(match[1]);
  return specifiers;
}

const bareImports = [];
const missingImports = [];
const graph = new Map();
for (const [file, source] of jsSources) {
  const next = [];
  for (const specifier of importSpecifiers(source)) {
    if (specifier.startsWith(".")) {
      const target = normalize(join(dirname(file), specifier));
      if (!existsSync(target)) missingImports.push(`${file} -> ${specifier}`);
      else next.push(target);
    } else if (!/^(https?:|data:|node:)/.test(specifier)) {
      bareImports.push(`${file} -> ${specifier}`);
    }
  }
  graph.set(file, next);
}
check("frontend modules use only relative imports", bareImports.length === 0, bareImports.join(", "));
check("every frontend import resolves", missingImports.length === 0, missingImports.join(", "));

const entry = join(FRONTEND, "js", "app.js");
const reachable = new Set();
const queue = [entry];
while (queue.length) {
  const file = queue.pop();
  if (reachable.has(file)) continue;
  reachable.add(file);
  for (const next of graph.get(file) || []) queue.push(next);
}
reachable.add(join(FRONTEND, "js", "native-config.js")); // loaded by index.html
const orphaned = jsFiles.filter((file) => !reachable.has(file));
check("no orphaned frontend modules are shipped", orphaned.length === 0, orphaned.map((file) => file.replace(`${ROOT}/`, "")).join(", "));

const sourceText = [...jsSources.values()].join("\n");
check("no dynamic HTML injection", !/\.innerHTML\s*=/.test(sourceText) && !/insertAdjacentHTML/.test(sourceText));
check("no eval or Function constructor", !/\beval\s*\(|new\s+Function\s*\(/.test(sourceText));
check("no frontend console logging of user data", !/\bconsole\.(?:log|debug|info|warn|error)\s*\(/.test(sourceText));
check("no fake/demo response engine", !/DEMO MODE|mock response|simulate\s*\(|fabricated assistant/i.test(sourceText));
check(
  "provider credentials are not exported",
  /apiKey:\s*provider\.apiKey\s*\?\s*"\[redacted\]"/.test(read("frontend/js/store.js")),
);
check("unsupported background listening is explicitly disabled", /id="activateBackgroundBtn"[^>]*disabled/.test(html) && sourceText.includes('badge.textContent = "UNAVAILABLE"'));
check("app-private storage is not described as encrypted", !/Encrypted\s*\/\s*App-Private/i.test(html));
check(
  "checked-in backend default is empty",
  /window\.HSAI_DEFAULT_BACKEND_URL = window\.HSAI_DEFAULT_BACKEND_URL \|\| "";/.test(read("frontend/js/native-config.js")),
);

let syntaxOk = true;
for (const file of [...jsFiles, join(ROOT, "scripts/build-www.mjs"), join(ROOT, "scripts/make-android-assets.mjs"), join(ROOT, "capacitor.config.js")]) {
  try {
    execFileSync(process.execPath, ["--check", file], { stdio: "pipe" });
  } catch (error) {
    syntaxOk = false;
    warnings.push(`${file.replace(`${ROOT}/`, "")}: ${error.stderr?.toString().split("\n")[0] || "syntax error"}`);
  }
}
check("all JavaScript parses", syntaxOk, warnings.join("; "));

/* ---------------------------------------------------------------------- CSS */
const css = read("frontend/css/styles.css");
check("HUD stylesheet is bundled", ["--primary", ".hud", ".overlay", "@media", "prefers-reduced-motion"].every((item) => css.includes(item)));
check("stylesheet braces balance", (css.match(/{/g) || []).length === (css.match(/}/g) || []).length);

/* -------------------------------------------------------------- Android config */
const manifest = read("android/app/src/main/AndroidManifest.xml");
const gradle = read("android/app/build.gradle");
const variables = read("android/variables.gradle");
const strings = read("android/app/src/main/res/values/strings.xml");
const capacitor = read("capacitor.config.js");
const workflow = read(".github/workflows/build-apk.yml");

check("INTERNET permission declared", manifest.includes('android.permission.INTERNET'));
check("microphone permission declared", manifest.includes('android.permission.RECORD_AUDIO'));
check("no unused camera/storage permissions", !/CAMERA|READ_EXTERNAL_STORAGE|WRITE_EXTERNAL_STORAGE|FileProvider/.test(manifest));
check("Android 11 speech/TTS package visibility declared", manifest.includes("android.speech.RecognitionService") && manifest.includes("android.intent.action.TTS_SERVICE"));
check("tile service registered under HSAI name", manifest.includes('android:name=".HsaiTileService"') && !manifest.includes("JarvisTileService"));
check("tile binding permission and intent filter present", manifest.includes("BIND_QUICK_SETTINGS_TILE") && manifest.includes("android.service.quicksettings.action.QS_TILE"));
check("keyboard handling configured", manifest.includes("windowSoftInputMode"));
check("cleartext traffic disabled", manifest.includes('android:usesCleartextTraffic="false"') && read("android/app/src/main/res/xml/network_security_config.xml").includes('cleartextTrafficPermitted="false"'));
check("package ID is com.hsai.assistant", ['applicationId "com.hsai.assistant"', 'namespace = "com.hsai.assistant"', 'appId: "com.hsai.assistant"', '<string name="package_name">com.hsai.assistant</string>'].every((item) => `${gradle}\n${capacitor}\n${strings}`.includes(item)));
check("version is VDPAI 1.0 (1.0.0 / code 3)", gradle.includes('versionName "1.0.0"') && /versionCode 3\b/.test(gradle));
check("Android SDK 36 configured", variables.includes("compileSdkVersion = 36") && variables.includes("targetSdkVersion = 36"));
check("application labels are VDPAI", strings.includes('<string name="app_name">VDPAI</string>') && strings.includes('<string name="tile_label">VDPAI</string>'));
check("native voice plugin registered", read("android/app/src/main/java/com/hsai/assistant/MainActivity.java").includes("registerPlugin(HsaiVoicePlugin.class)"));
check("native voice plugin has speech and TTS", ["SpeechRecognizer", "TextToSpeech", "UtteranceProgressListener"].every((item) => read("android/app/src/main/java/com/hsai/assistant/HsaiVoicePlugin.java").includes(item)));
check("tile uses the API 34 PendingIntent overload safely", read("android/app/src/main/java/com/hsai/assistant/HsaiTileService.kt").includes("Build.VERSION_CODES.UPSIDE_DOWN_CAKE"));

/* ----------------------------------------------------------------- workflow */
check("workflow builds a debug APK", workflow.includes("assembleDebug") && workflow.includes("VDPAI-Android-APK"));
check("workflow verifies the APK exists", /if \[ ! -s "\$APK" \]/.test(workflow));
check("workflow verifies VDPAI package and tile in the APK", gradle.includes('applicationId "com.hsai.assistant"') && workflow.includes("HsaiTileService"));
check("workflow runs frontend and Python checks", workflow.includes("npm run check") && workflow.includes("npm run test:js") && workflow.includes("tests/run_tests.py"));

/* -------------------------------------------------------------------- package */
const pkg = JSON.parse(read("package.json"));
check("package name and version", pkg.name === "vdpai" && pkg.version === "1.0.0");
check("required npm scripts exist", ["build", "check", "test:js", "test", "build:android", "assets"].every((name) => typeof pkg.scripts?.[name] === "string"));
check("Capacitor Android and Preferences are pinned", Boolean(pkg.devDependencies?.["@capacitor/android"]) && Boolean(pkg.dependencies?.["@capacitor/preferences"]));
check("icon import workflow is documented", read("assets/icon/README.md").includes("byte-for-byte"));
if (existsSync(join(ROOT, "assets", "icon", "icon.png"))) {
  console.log("INFO  owner icon present — npm run assets will import it unchanged");
} else {
  console.log("INFO  owner icon absent — the neutral placeholder must be replaced before release");
}

/* ---------------------------------------------------------------------- result */
console.log();
if (failures.length) {
  console.error(`RESULT: ${failures.length} static check(s) failed.`);
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}
console.log("RESULT: all static production checks passed.");
