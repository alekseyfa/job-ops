import { buildHeaders, joinUrl } from "../utils/http";
import {
  buildChatCompletionsBody,
  createProviderStrategy,
  extractChatCompletionsText,
  suppressLocalThinking,
} from "./factory";

// See lmstudio.ts: local servers aren't consistently generous with default
// max_tokens the way cloud providers are — send an explicit value so long
// scoring JSON doesn't get silently truncated.
const LOCAL_MAX_TOKENS = 4096;

export const ollamaStrategy = createProviderStrategy({
  provider: "ollama",
  defaultBaseUrl: "http://localhost:11434",
  requiresApiKey: false,
  // See lmstudio.ts: skip strict "json_schema" mode for the same reason —
  // local grammar compilers have inconsistent JSON Schema support and don't
  // fail in a way the capability-fallback cascade recognizes.
  modes: ["text", "none"],
  validationPaths: ["/v1/models", "/api/tags"],
  buildRequest: ({ mode, baseUrl, model, messages, jsonSchema }) => {
    return {
      url: joinUrl(baseUrl, "/v1/chat/completions"),
      headers: buildHeaders({ apiKey: null, provider: "ollama" }),
      body: buildChatCompletionsBody({
        mode,
        model,
        messages: suppressLocalThinking(messages),
        jsonSchema,
        extra: { max_tokens: LOCAL_MAX_TOKENS },
      }),
    };
  },
  extractText: extractChatCompletionsText,
});
