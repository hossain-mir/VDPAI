#!/usr/bin/env node
/* HSAI 2.0 — pure unit checks for the data model, providers and URL safety.
 *
 * No network access is required. The real HTTP paths are covered by
 * tests/hsai_smoke.mjs, which mocks fetch and drives the actual HUD.
 */
import {
  APP_ID,
  APP_NAME,
  APP_VERSION,
  defaultSettings,
  titleFrom,
} from "../frontend/js/store.js";
import {
  PROVIDER_TYPES,
  ProviderError,
  normalizeBaseUrl,
  resolveEndpoint,
  providerType,
} from "../frontend/js/providers.js";
import { validateBackendUrl } from "../frontend/js/backend.js";
import { splitForSpeech } from "../frontend/js/voice.js";

const failures = [];
let passed = 0;

function check(name, condition, detail = "") {
  if (condition) {
    passed += 1;
    console.log(`PASS  ${name}`);
  } else {
    failures.push(`${name}${detail ? ` — ${detail}` : ""}`);
    console.log(`FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

function throws(fn, code) {
  try {
    fn();
    return false;
  } catch (error) {
    return error instanceof ProviderError ? error.code === code : false;
  }
}

/* ----------------------------------------------------------------- constants */
check("app identity is VDPAI", APP_NAME === "VDPAI" && APP_VERSION === "1.0.0" && APP_ID === "com.hsai.assistant");

/* ------------------------------------------------------------------- defaults */
const settings = defaultSettings();
check("default settings are offline-first", settings.backendUrl === "" && settings.activeProviderId === null);
check("spoken replies default on, geometry safe", settings.ttsEnabled === true && settings.speechRate >= 0.5 && settings.speechRate <= 1.8);
check("system prompt identifies VDPAI", settings.systemPrompt.includes("VDPAI"));
check("theme and privacy defaults are valid", ["cyan", "emerald", "violet"].includes(settings.theme) && settings.persistHistory === true);

/* --------------------------------------------------------------------- titles */
check("conversation titles flatten whitespace", titleFrom("  hello\n\n   world  ") === "hello world");
check("long titles are truncated", titleFrom("x".repeat(200)).length === 52 && titleFrom("x".repeat(200)).endsWith("…"));
check("empty titles have a fallback", titleFrom("   ") === "New conversation");

/* ------------------------------------------------------------------ providers */
const expected = ["openai", "gemini", "groq", "openrouter", "anthropic", "deepseek", "mistral", "custom"];
check("all required providers are catalogued", expected.every((type) => PROVIDER_TYPES[type]));
check("known provider bases are HTTPS", expected.filter((type) => type !== "custom").every((type) => PROVIDER_TYPES[type].baseUrl.startsWith("https://")));
check("custom provider has no hidden endpoint", PROVIDER_TYPES.custom.baseUrl === "" && providerType("unknown").label.includes("Custom"));

check(
  "OpenAI endpoint resolves correctly",
  resolveEndpoint({ type: "openai", model: "gpt-4o-mini" }) === "https://api.openai.com/v1/chat/completions",
);
check(
  "Groq endpoint resolves correctly",
  resolveEndpoint({ type: "groq", model: "llama-3.3-70b-versatile" }) === "https://api.groq.com/openai/v1/chat/completions",
);
check(
  "custom endpoint joins base and path once",
  resolveEndpoint({ type: "custom", baseUrl: "https://llm.example.test/v1/", endpoint: "/chat/completions" }) ===
    "https://llm.example.test/v1/chat/completions",
);
check(
  "custom endpoint accepts a full URL",
  resolveEndpoint({ type: "custom", baseUrl: "https://ignored.test", endpoint: "https://other.test/v1/chat" }) ===
    "https://other.test/v1/chat",
);
check(
  "custom endpoint without a leading slash is normalised",
  resolveEndpoint({ type: "custom", baseUrl: "https://llm.example.test/v1", endpoint: "responses" }) ===
    "https://llm.example.test/v1/responses",
);
check("missing custom base is rejected", throws(() => resolveEndpoint({ type: "custom", endpoint: "/chat" }), "missing_base_url"));
check("non-HTTP base is rejected", throws(() => resolveEndpoint({ type: "custom", baseUrl: "file:///etc/passwd" }), "invalid_base_url"));
check("normalizeBaseUrl removes trailing slashes", normalizeBaseUrl("https://api.example.test/v1///") === "https://api.example.test/v1");
check("normalizeBaseUrl strips markup characters", !/[<>"'\\]/.test(normalizeBaseUrl("https://x.test/<script>")));

/* --------------------------------------------------------------- backend URL */
check("empty backend URL means local-only", validateBackendUrl("").ok === true && validateBackendUrl("").url === "");
check(
  "HTTPS backend URL normalises path",
  validateBackendUrl("https://server.example.com/api/").url === "https://server.example.com/api",
);
check(
  "HTTP backend URL warns about Android policy",
  validateBackendUrl("http://server.example.com").ok === true &&
    validateBackendUrl("http://server.example.com").warning.includes("HTTPS"),
);
check("localhost backend URL is rejected", validateBackendUrl("http://localhost:8000").ok === false);
check("loopback backend URL is rejected", validateBackendUrl("https://127.0.0.1").ok === false);
check("credentialed backend URL is rejected", validateBackendUrl("https://user:pass@server.example.com").ok === false);
check("non-HTTP backend scheme is rejected", validateBackendUrl("javascript:alert(1)").ok === false);
check("malformed backend URL is rejected", validateBackendUrl("not a url").ok === false);

/* ------------------------------------------------------------------- speech */
const short = splitForSpeech("VDPAI is ready. Ask a question.");
check("short speech stays one chunk", short.length === 1 && short[0].includes("VDPAI is ready"));
const long = splitForSpeech(Array.from({ length: 80 }, (_, index) => `Sentence ${index + 1} is spoken aloud.`).join(" "));
check("long speech is chunked", long.length > 1 && long.every((chunk) => chunk.length <= 700));
check("empty speech produces no chunks", splitForSpeech("   \n\t ").length === 0);
check("control characters are removed", !/[\u0000-\u0008]/.test(splitForSpeech("hi\u0000there").join("")));

console.log();
if (failures.length) {
  console.error(`RESULT: ${passed} passed, ${failures.length} failed.`);
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}
console.log(`RESULT: all ${passed} unit checks passed.`);
