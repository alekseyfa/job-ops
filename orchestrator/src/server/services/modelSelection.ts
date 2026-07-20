import * as settingsRepo from "@server/repositories/settings";
import { getOriginalEnvValue } from "@server/services/envSettings";
import { LlmService } from "@server/services/llm/service";
import {
  isBedrockEnabled,
  resolveBedrockBaseUrl,
  resolveBedrockModel,
} from "@server/services/llm/providers/bedrock";
import { getEffectiveSettings } from "@server/services/settings";
import { getDefaultModelForProvider } from "@shared/settings-registry";

export type LlmModelPurpose =
  | "default"
  | "scoring"
  | "tailoring"
  | "projectSelection";

function readStringSettingValue(
  setting: { value?: unknown } | null | undefined,
): string | null {
  if (typeof setting?.value !== "string") {
    return null;
  }

  const trimmed = setting.value.trim();
  return trimmed || null;
}

function resolveDefaultModelFromSettings(
  settings: Awaited<ReturnType<typeof getEffectiveSettings>>,
): string {
  return (
    readStringSettingValue(settings?.model) ??
    getDefaultModelForProvider(
      readStringSettingValue(settings?.llmProvider) ??
        getOriginalEnvValue("LLM_PROVIDER"),
      getOriginalEnvValue("MODEL"),
    )
  );
}

export async function resolveLlmModel(
  purpose: LlmModelPurpose = "default",
): Promise<string> {
  // Bedrock opt-in is env-driven and single-model: env wins over DB settings
  // (DB model ids are gemini/openrouter-shaped and won't resolve on Bedrock).
  if (isBedrockEnabled()) {
    return resolveBedrockModel();
  }

  const settings = await getEffectiveSettings();
  const defaultModel = resolveDefaultModelFromSettings(settings);

  if (purpose === "scoring") {
    return readStringSettingValue(settings?.modelScorer) ?? defaultModel;
  }

  if (purpose === "tailoring") {
    return readStringSettingValue(settings?.modelTailoring) ?? defaultModel;
  }

  if (purpose === "projectSelection") {
    return (
      readStringSettingValue(settings?.modelProjectSelection) ?? defaultModel
    );
  }

  return defaultModel;
}

export async function resolveLlmRuntimeSettings(
  purpose: LlmModelPurpose = "default",
): Promise<{
  model: string;
  provider: string | null;
  baseUrl: string | null;
  apiKey: string | null;
}> {
  const getAllSettings =
    "getAllSettings" in settingsRepo ? settingsRepo.getAllSettings : null;
  const [settings, overrides] = await Promise.all([
    getEffectiveSettings(),
    typeof getAllSettings === "function"
      ? getAllSettings()
      : Promise.resolve({} as Partial<Record<settingsRepo.SettingKey, string>>),
  ]);
  const defaultModel = resolveDefaultModelFromSettings(settings);

  const model =
    purpose === "scoring"
      ? (readStringSettingValue(settings?.modelScorer) ?? defaultModel)
      : purpose === "tailoring"
        ? (readStringSettingValue(settings?.modelTailoring) ?? defaultModel)
        : purpose === "projectSelection"
          ? (readStringSettingValue(settings?.modelProjectSelection) ??
            defaultModel)
          : defaultModel;

  return {
    model,
    provider: readStringSettingValue(settings?.llmProvider),
    baseUrl: readStringSettingValue(settings?.llmBaseUrl),
    apiKey: overrides?.llmApiKey || getOriginalEnvValue("LLM_API_KEY") || null,
  };
}

export async function createConfiguredLlmService(): Promise<LlmService> {
  // CLAUDE_CODE_USE_BEDROCK short-circuits DB settings: point at the regional
  // Bedrock endpoint and authenticate with the AWS_BEARER_TOKEN_BEDROCK token.
  if (isBedrockEnabled()) {
    return new LlmService({
      provider: "bedrock",
      baseUrl: resolveBedrockBaseUrl(),
      apiKey: getOriginalEnvValue("AWS_BEARER_TOKEN_BEDROCK") ?? null,
    });
  }

  const runtime = await resolveLlmRuntimeSettings();
  return new LlmService({
    provider: runtime.provider,
    baseUrl: runtime.baseUrl,
    apiKey: runtime.apiKey,
  });
}
