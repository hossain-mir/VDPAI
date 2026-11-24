/* VDPAI — chat orchestration and conversation context. */

import {
  addMessage,
  ensureConversation,
  getActiveProvider,
  getConversation,
  getEffectiveSystemPrompt,
  getSettings,
  setConversationProvider,
} from "./store.js";
import { ProviderError, requestChat } from "./providers.js";

const CONTEXT_MESSAGES = 24;

export function buildContext(conversation) {
  if (!conversation) return [];
  return conversation.messages
    .filter((message) => message.role === "user" || message.role === "assistant")
    .filter((message) => message.content.trim())
    .slice(-CONTEXT_MESSAGES)
    .map((message) => ({ role: message.role, content: message.content }));
}

/**
 * Send a real message to the selected provider.
 *
 * The user's message is persisted before the request. An assistant message is
 * persisted only after text genuinely arrived (or after a user-stopped partial
 * response). Failures never create an invented assistant reply.
 */
export async function sendChat({ text, conversationId, onDelta, signal }) {
  const content = String(text || "").trim();
  if (!content) throw new ProviderError("Type a message first.", { code: "empty_message" });

  const provider = getActiveProvider();
  if (!provider) {
    throw new ProviderError("No AI provider is configured. Open Control Center → AI & API to add one.", {
      code: "no_provider",
    });
  }
  if (provider.type !== "custom" && !provider.apiKey) {
    throw new ProviderError(`Add an API key for ${provider.name} in Control Center → AI & API.`, {
      code: "missing_key",
    });
  }
  if (!provider.model) {
    throw new ProviderError(`Set a model ID for ${provider.name}.`, { code: "missing_model" });
  }

  const conversation = (conversationId && getConversation(conversationId)) || ensureConversation();
  const lastMsg = conversation.messages[conversation.messages.length - 1];
  let userMessage;
  if (lastMsg && lastMsg.role === "user" && lastMsg.content.trim() === content.trim()) {
    userMessage = lastMsg;
  } else {
    userMessage = addMessage(conversation.id, "user", content);
  }
  setConversationProvider(conversation.id, provider.id, provider.model);

  const messages = buildContext(conversation);
  const settings = getSettings();
  let streamed = "";

  try {
    const result = await requestChat(provider, {
      messages,
      system: getEffectiveSystemPrompt() || settings.systemPrompt,
      maxTokens: 1200,
      temperature: 0.7,
      stream: true,
      signal,
      onDelta: (delta, full) => {
        streamed = full || `${streamed}${delta}`;
        onDelta?.(delta, streamed);
      },
    });
    const assistant = addMessage(conversation.id, "assistant", result.text);
    return {
      conversation,
      userMessage,
      assistantMessage: assistant,
      text: result.text,
      provider: result.provider,
      model: result.model,
      providerId: provider.id,
    };
  } catch (error) {
    if (error?.code === "aborted") {
      const partial = String(streamed || "").trim();
      if (partial) {
        const assistant = addMessage(conversation.id, "assistant", `${partial}\n\n[stopped]`);
        return {
          conversation,
          userMessage,
          assistantMessage: assistant,
          text: partial,
          provider: provider.name,
          model: provider.model,
          providerId: provider.id,
          stopped: true,
        };
      }
    }
    throw Object.assign(error, { conversation, userMessage });
  }
}

/** True when the user has a usable configuration (no network call). */
export function providerReady() {
  const provider = getActiveProvider();
  if (!provider) return { ok: false, reason: "No AI provider configured.", provider: null };
  if (!provider.model) return { ok: false, reason: "No model ID configured.", provider };
  if (provider.type !== "custom" && !provider.apiKey) {
    return { ok: false, reason: `No API key saved for ${provider.name}.`, provider };
  }
  return { ok: true, reason: "", provider };
}
