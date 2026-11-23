/* VDPAI — provider catalog, real request engine and connection tests.
 *
 * Requests go directly from the device to the provider the owner configured.
 * Requests use the selected provider and report its actual connection state.
 * An API key is only placed in an Authorization header / query parameter for
 * the request and is redacted from every error surfaced to the interface.
 */

export const PROVIDER_TYPES = {
  openai: {
    label: "OpenAI",
    baseUrl: "https://api.openai.com/v1",
    endpoint: "/chat/completions",
    defaultModel: "gpt-4o-mini",
    models: ["gpt-4o-mini", "gpt-4o", "gpt-4.1-mini", "o4-mini"],
    requiresKey: true,
  },
  gemini: {
    label: "Google Gemini",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta",
    endpoint: "",
    defaultModel: "gemini-2.0-flash",
    models: ["gemini-2.0-flash", "gemini-1.5-flash", "gemini-1.5-pro"],
    requiresKey: true,
  },
  groq: {
    label: "Groq",
    baseUrl: "https://api.groq.com/openai/v1",
    endpoint: "/chat/completions",
    defaultModel: "llama-3.3-70b-versatile",
    models: ["llama-3.3-70b-versatile", "llama-3.1-8b-instant", "mixtral-8x7b-32768"],
    requiresKey: true,
  },
  openrouter: {
    label: "OpenRouter",
    baseUrl: "https://openrouter.ai/api/v1",
    endpoint: "/chat/completions",
    defaultModel: "openai/gpt-4o-mini",
    models: ["openai/gpt-4o-mini", "anthropic/claude-3.5-sonnet", "google/gemini-flash-1.5"],
    requiresKey: true,
  },
  anthropic: {
    label: "Anthropic",
    baseUrl: "https://api.anthropic.com/v1",
    endpoint: "/messages",
    defaultModel: "claude-3-5-haiku-latest",
    models: ["claude-3-5-haiku-latest", "claude-3-5-sonnet-latest"],
    requiresKey: true,
  },
  deepseek: {
    label: "DeepSeek",
    baseUrl: "https://api.deepseek.com/v1",
    endpoint: "/chat/completions",
    defaultModel: "deepseek-chat",
    models: ["deepseek-chat", "deepseek-reasoner"],
    requiresKey: true,
  },
  mistral: {
    label: "Mistral",
    baseUrl: "https://api.mistral.ai/v1",
    endpoint: "/chat/completions",
    defaultModel: "mistral-small-latest",
    models: ["mistral-small-latest", "mistral-large-latest"],
    requiresKey: true,
  },
  custom: {
    label: "Custom / OpenAI-compatible",
    baseUrl: "",
    endpoint: "/chat/completions",
    defaultModel: "",
    models: [],
    requiresKey: false,
  },
};

export class ProviderError extends Error {
  constructor(message, { code = "provider_error", status = 0, detail = "" } = {}) {
    super(message);
    this.name = "ProviderError";
    this.code = code;
    this.status = status;
    this.detail = detail;
  }
}

export function providerType(type) {
  return PROVIDER_TYPES[type] || PROVIDER_TYPES.custom;
}

export function normalizeBaseUrl(value) {
  return String(value || "")
    .trim()
    .replace(/[\u2028\u2029<>"'\\]/g, "")
    .replace(/\/+$/, "");
}

/** The exact URL that will receive the request. Visible in the editor. */
export function resolveEndpoint(provider) {
  const spec = providerType(provider?.type);
  let base = normalizeBaseUrl(provider?.baseUrl) || spec.baseUrl;
  if (!base) {
    throw new ProviderError("A Base URL is required for a custom provider.", { code: "missing_base_url" });
  }
  if (!/^https?:\/\//i.test(base)) {
    throw new ProviderError("The Base URL must start with https://.", { code: "invalid_base_url" });
  }
  const endpoint = String(provider?.endpoint || spec.endpoint || "").trim();
  if (endpoint && /^https?:\/\//i.test(endpoint)) return endpoint.replace(/\/+$/, "");
  const combined = `${base}${endpoint.startsWith("/") || !endpoint ? endpoint : `/${endpoint}`}`;
  return combined.replace(/\/+$/, "");
}

export function providerHost(provider) {
  try {
    return new URL(resolveEndpoint(provider)).host;
  } catch {
    return "endpoint not configured";
  }
}

function redact(message, apiKey) {
  let out = String(message || "Provider request failed.");
  if (apiKey) out = out.split(apiKey).join("[redacted]");
  return out.slice(0, 1200);
}

function describeStatus(status) {
  const table = {
    400: "The provider rejected the request (400). Check the model ID and request format.",
    401: "Authentication failed (401). The API key is missing, invalid or expired.",
    403: "Access denied (403). This key may not have permission for the selected model.",
    404: "Not found (404). Check the Base URL, endpoint path and model ID.",
    408: "The provider timed out (408).",
    413: "The request was too large (413).",
    429: "Rate limit or quota reached (429). Wait and try again, or check your billing.",
    500: "The provider had an internal error (500).",
    502: "The provider gateway returned 502.",
    503: "The provider is unavailable (503). Try again shortly.",
  };
  return table[status] || `The provider returned HTTP ${status}.`;
}

async function responseError(response, apiKey) {
  let detail = "";
  try {
    const text = await response.text();
    try {
      const json = JSON.parse(text);
      detail =
        json?.error?.message ||
        json?.error?.status ||
        json?.message ||
        (typeof json?.error === "string" ? json.error : "") ||
        text;
    } catch {
      detail = text;
    }
  } catch {
    detail = "";
  }
  detail = redact(detail, apiKey);
  return new ProviderError(describeStatus(response.status), {
    code: `http_${response.status}`,
    status: response.status,
    detail,
  });
}

function linkAbort(externalSignal, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("timeout")), timeoutMs);
  const onAbort = () => controller.abort(externalSignal?.reason || new Error("aborted"));
  if (externalSignal) {
    if (externalSignal.aborted) controller.abort(externalSignal.reason);
    else externalSignal.addEventListener("abort", onAbort, { once: true });
  }
  return {
    signal: controller.signal,
    cleanup() {
      clearTimeout(timer);
      externalSignal?.removeEventListener?.("abort", onAbort);
    },
  };
}

async function doFetch(url, init, { timeoutMs = 90000, signal } = {}) {
  const link = linkAbort(signal, timeoutMs);
  try {
    return await fetch(url, { ...init, signal: link.signal });
  } catch (error) {
    if (link.signal.aborted) {
      const reason = link.signal.reason;
      if (reason?.message === "timeout") {
        throw new ProviderError("The provider did not respond before the timeout.", {
          code: "timeout",
          detail: `No response within ${Math.round(timeoutMs / 1000)} seconds.`,
        });
      }
      throw new ProviderError("Request cancelled.", { code: "aborted" });
    }
    throw new ProviderError(
      "Cannot reach the provider. Check the device connection, Base URL and HTTPS configuration.",
      { code: "network", detail: redact(error?.message || "network error") },
    );
  } finally {
    link.cleanup();
  }
}

function openAIHeaders(provider, apiKey) {
  const headers = {
    "Content-Type": "application/json",
    Accept: "application/json",
  };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  if (provider.type === "openrouter") {
    headers["HTTP-Referer"] = "https://github.com/hossain-mir/JARVIS-AI";
    headers["X-Title"] = "VDPAI";
  }
  return headers;
}

function sseLines(buffer) {
  const events = [];
  let rest = buffer.replace(/\r\n/g, "\n");
  let index = rest.indexOf("\n\n");
  while (index >= 0) {
    const block = rest.slice(0, index);
    rest = rest.slice(index + 2);
    const data = block
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trim())
      .join("\n");
    if (data) events.push(data);
    index = rest.indexOf("\n\n");
  }
  return { events, rest };
}

async function readSSE(response, extract, onDelta, apiKey) {
  if (!response.body?.getReader) return null;
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let full = "";
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const parsed = sseLines(buffer);
      buffer = parsed.rest;
      for (const data of parsed.events) {
        if (data === "[DONE]") continue;
        let json;
        try {
          json = JSON.parse(data);
        } catch {
          continue;
        }
        if (json?.error) {
          throw new ProviderError(redact(json.error.message || "The provider reported an error.", apiKey), {
            code: "provider_stream_error",
            detail: redact(json.error.message || "", apiKey),
          });
        }
        const delta = extract(json);
        if (delta) {
          full += delta;
          onDelta?.(delta, full);
        }
      }
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      /* ignore */
    }
  }
  return full;
}

function openAIMessages(messages) {
  return messages.map((message) => ({
    role: message.role === "assistant" ? "assistant" : "user",
    content: message.content,
  }));
}

function geminiContents(messages) {
  return messages.map((message) => ({
    role: message.role === "assistant" ? "model" : "user",
    parts: [{ text: message.content }],
  }));
}

async function callOpenAICompatible(provider, { messages, system, maxTokens, temperature, stream, signal, onDelta }) {
  const endpoint = resolveEndpoint(provider);
  const apiKey = provider.apiKey || "";
  if (providerType(provider.type).requiresKey && !apiKey) {
    throw new ProviderError("No API key is configured for this provider.", { code: "missing_key" });
  }
  const payload = {
    model: provider.model,
    messages: [...(system ? [{ role: "system", content: system }] : []), ...openAIMessages(messages)],
    temperature,
    max_tokens: maxTokens,
    stream: Boolean(stream),
  };
  const response = await doFetch(
    endpoint,
    {
      method: "POST",
      headers: openAIHeaders(provider, apiKey),
      body: JSON.stringify(payload),
    },
    { signal },
  );
  if (!response.ok) throw await responseError(response, apiKey);

  if (stream) {
    const contentType = response.headers.get("content-type") || "";
    if (contentType.includes("event-stream") || contentType.includes("stream")) {
      const text = await readSSE(
        response,
        (json) => {
          const choice = json?.choices?.[0];
          if (!choice) return "";
          return choice.delta?.content ?? choice.message?.content ?? choice.text ?? "";
        },
        onDelta,
        apiKey,
      );
      if (text === null) {
        const json = await response.json().catch(() => null);
        const fallback =
          json?.choices?.[0]?.message?.content || json?.choices?.[0]?.text || "";
        if (fallback) onDelta?.(fallback, fallback);
        return { text: fallback };
      }
      return { text };
    }
  }

  const json = await response.json().catch(async () => {
    throw new ProviderError("The provider returned a response that was not valid JSON.", {
      code: "invalid_response",
    });
  });
  const choice = json?.choices?.[0];
  const value = choice?.message?.content ?? choice?.text ?? "";
  const text = typeof value === "string" ? value : Array.isArray(value) ? value.map((part) => part?.text || "").join("") : "";
  if (!text) {
    throw new ProviderError("The provider returned an empty response.", {
      code: "empty_response",
      detail: redact(json?.error?.message || ""),
    });
  }
  onDelta?.(text, text);
  return { text };
}

async function callGemini(provider, { messages, system, maxTokens, temperature, stream, signal, onDelta }) {
  const apiKey = provider.apiKey || "";
  if (!apiKey) throw new ProviderError("No API key is configured for this provider.", { code: "missing_key" });
  const base = normalizeBaseUrl(provider.baseUrl) || providerType("gemini").baseUrl;
  const model = String(provider.model || "").replace(/^models\//, "");
  if (!model) throw new ProviderError("A model ID is required.", { code: "missing_model" });
  if (!/^https:\/\//i.test(base)) {
    throw new ProviderError("Gemini requires an https:// Base URL.", { code: "invalid_base_url" });
  }
  const action = stream ? "streamGenerateContent" : "generateContent";
  const url = `${base}/models/${encodeURIComponent(model)}:${action}?key=${encodeURIComponent(apiKey)}${stream ? "&alt=sse" : ""}`;
  const payload = {
    contents: geminiContents(messages),
    generationConfig: { temperature, maxOutputTokens: maxTokens },
  };
  if (system) payload.systemInstruction = { parts: [{ text: system }] };
  const response = await doFetch(
    url,
    { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) },
    { signal },
  );
  if (!response.ok) throw await responseError(response, apiKey);

  const extract = (json) =>
    (json?.candidates?.[0]?.content?.parts || [])
      .map((part) => part?.text || "")
      .join("");

  if (stream) {
    const text = await readSSE(response, extract, onDelta, apiKey);
    if (text) return { text };
  }
  const json = await response.json().catch(() => null);
  const text = extract(json);
  if (!text) {
    const blocked = json?.promptFeedback?.blockReason;
    throw new ProviderError(
      blocked ? `Gemini blocked the prompt (${blocked}).` : "Gemini returned an empty response.",
      { code: "empty_response" },
    );
  }
  onDelta?.(text, text);
  return { text };
}

async function callAnthropic(provider, { messages, system, maxTokens, temperature, stream, signal, onDelta }) {
  const apiKey = provider.apiKey || "";
  if (!apiKey) throw new ProviderError("No API key is configured for this provider.", { code: "missing_key" });
  const endpoint = resolveEndpoint(provider);
  const payload = {
    model: provider.model,
    max_tokens: maxTokens,
    temperature,
    system: system || undefined,
    messages: openAIMessages(messages),
    stream: Boolean(stream),
  };
  const response = await doFetch(
    endpoint,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify(payload),
    },
    { signal },
  );
  if (!response.ok) throw await responseError(response, apiKey);

  if (stream) {
    const contentType = response.headers.get("content-type") || "";
    if (contentType.includes("event-stream")) {
      const text = await readSSE(
        response,
        (json) => (json?.type === "content_block_delta" ? json?.delta?.text || "" : ""),
        onDelta,
        apiKey,
      );
      if (text) return { text };
    }
  }
  const json = await response.json().catch(() => null);
  const text = (json?.content || [])
    .filter((block) => block?.type === "text")
    .map((block) => block.text)
    .join("");
  if (!text) throw new ProviderError("Anthropic returned an empty response.", { code: "empty_response" });
  onDelta?.(text, text);
  return { text };
}

/**
 * Send one chat request.  Only this function is allowed to talk to a provider.
 * @returns {Promise<{text: string, provider: string, model: string}>}
 */
export async function requestChat(provider, options) {
  if (!provider) throw new ProviderError("Select an AI provider in Control Center first.", { code: "no_provider" });
  if (!provider.model) throw new ProviderError("Set a model ID for this provider.", { code: "missing_model" });
  const opts = {
    messages: [],
    system: "",
    maxTokens: 1024,
    temperature: 0.7,
    stream: true,
    signal: undefined,
    onDelta: undefined,
    ...options,
  };
  try {
    const result =
      provider.type === "gemini"
        ? await callGemini(provider, opts)
        : provider.type === "anthropic"
          ? await callAnthropic(provider, opts)
          : await callOpenAICompatible(provider, opts);
    return { text: result.text.trim(), provider: provider.name, model: provider.model };
  } catch (error) {
    if (error instanceof ProviderError) throw error;
    throw new ProviderError(redact(error?.message || "Provider request failed.", provider.apiKey), {
      code: "unexpected",
    });
  }
}

/**
 * Real connection test: one tiny completion.  The caller receives the actual
 * status, latency and sample.  No result is cached as "connected".
 */
export async function testProvider(provider, { signal } = {}) {
  const started = performance.now();
  try {
    const result = await requestChat(provider, {
      messages: [{ role: "user", content: "Reply with the single word OK." }],
      system: "",
      maxTokens: 12,
      temperature: 0,
      stream: false,
      signal,
    });
    const latency = Math.round(performance.now() - started);
    if (!result.text) throw new ProviderError("The provider replied without any text.", { code: "empty_response" });
    return {
      ok: true,
      latency,
      sample: result.text.slice(0, 120),
      status: "Connected",
    };
  } catch (error) {
    return {
      ok: false,
      latency: Math.round(performance.now() - started),
      sample: "",
      status: error?.code === "aborted" ? "Cancelled" : "Failed",
      error: error?.message || "Connection failed.",
      code: error?.code || "provider_error",
      httpStatus: error?.status || 0,
      detail: error?.detail || "",
    };
  }
}
