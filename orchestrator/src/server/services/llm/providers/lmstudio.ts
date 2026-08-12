import { buildHeaders, joinUrl } from "../utils/http";
import {
  buildChatCompletionsBody,
  createProviderStrategy,
  extractChatCompletionsText,
  suppressLocalThinking,
} from "./factory";

// Cloud strategies (anthropic.ts, bedrock.ts) always send an explicit
// max_tokens because omitting it is safe there — the provider defaults to a
// large model-appropriate value. Local OpenAI-compatible servers are not
// consistently that generous (some default to a few hundred tokens), which
// silently truncates the scoring JSON mid-object. Send a generous explicit
// value instead of trusting the server default.
const LOCAL_MAX_TOKENS = 4096;

export const lmStudioStrategy = createProviderStrategy({
  provider: "lmstudio",
  defaultBaseUrl: "http://localhost:1234",
  requiresApiKey: false,
  // Skip strict "json_schema" mode: local grammar compilers (llama.cpp,
  // MLX) have inconsistent JSON Schema support — e.g. union `type` arrays
  // (`["integer","null"]`, used for nullable fields) crash rather than
  // downgrade gracefully, and their error text doesn't match the
  // capability-fallback keyword list, so it never cascades. Prompts already
  // spell out the JSON format, so plain text mode is reliable and simpler.
  modes: ["text", "none"],
  validationPaths: ["/v1/models"],
  buildRequest: ({ mode, baseUrl, model, messages, jsonSchema }) => {
    return {
      url: joinUrl(baseUrl, "/v1/chat/completions"),
      headers: buildHeaders({ apiKey: null, provider: "lmstudio" }),
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
