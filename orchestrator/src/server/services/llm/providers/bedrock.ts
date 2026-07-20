import { joinUrl } from "../utils/http";
import {
  ANTHROPIC_DEFAULT_MAX_TOKENS,
  extractAnthropicText,
  toAnthropicMessages,
} from "./anthropic";
import { createProviderStrategy } from "./factory";

// Bedrock's InvokeModel API is the Anthropic Messages format with two twists:
// the model lives in the URL path (not the body), and the schema version is
// pinned in the body as `anthropic_version` instead of an HTTP header.
const BEDROCK_ANTHROPIC_VERSION = "bedrock-2023-05-31";
const DEFAULT_BEDROCK_REGION = "us-east-1";
// Cross-region inference profile — override with ANTHROPIC_MODEL.
const DEFAULT_BEDROCK_MODEL = "us.anthropic.claude-sonnet-4-5-20250929-v1:0";

function bedrockBaseUrlForRegion(region: string): string {
  return `https://bedrock-runtime.${region}.amazonaws.com`;
}

/** `CLAUDE_CODE_USE_BEDROCK=1` (Claude Code's own convention) forces Bedrock. */
export function isBedrockEnabled(): boolean {
  const flag = process.env.CLAUDE_CODE_USE_BEDROCK?.trim().toLowerCase();
  return flag === "1" || flag === "true";
}

/** Regional Bedrock endpoint from AWS_REGION, else the default region. */
export function resolveBedrockBaseUrl(): string {
  return bedrockBaseUrlForRegion(
    process.env.AWS_REGION?.trim() || DEFAULT_BEDROCK_REGION,
  );
}

/** Bedrock model id from ANTHROPIC_MODEL (Claude Code's var), else the default. */
export function resolveBedrockModel(): string {
  return process.env.ANTHROPIC_MODEL?.trim() || DEFAULT_BEDROCK_MODEL;
}

export const bedrockStrategy = createProviderStrategy({
  provider: "bedrock",
  defaultBaseUrl: bedrockBaseUrlForRegion(DEFAULT_BEDROCK_REGION),
  requiresApiKey: true,
  modes: ["json_object", "text", "none"],
  validationPaths: [],
  buildRequest: ({ mode, baseUrl, apiKey, model, messages, jsonSchema }) => {
    const { system, conversationMessages } = toAnthropicMessages(
      messages,
      mode,
      jsonSchema,
    );

    const body: Record<string, unknown> = {
      anthropic_version: BEDROCK_ANTHROPIC_VERSION,
      max_tokens: ANTHROPIC_DEFAULT_MAX_TOKENS,
      messages: conversationMessages,
    };
    if (system) {
      body.system = system;
    }

    return {
      // The model id (e.g. `us.anthropic.claude-sonnet-4-5`) goes in the path;
      // encode it so on-demand ARNs with `:` don't break the URL.
      url: joinUrl(baseUrl, `/model/${encodeURIComponent(model)}/invoke`),
      headers: {
        "Content-Type": "application/json",
        // AWS_BEARER_TOKEN_BEDROCK — Bedrock's bearer-token auth (no SigV4).
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
      },
      body,
    };
  },
  extractText: extractAnthropicText,
  getValidationUrls: () => [],
});
