import { describe, expect, it } from "vitest";
import { bedrockStrategy } from "./bedrock";
import { geminiStrategy } from "./gemini";
import { lmStudioStrategy } from "./lmstudio";
import { ollamaStrategy } from "./ollama";
import { openAiStrategy } from "./openai";
import { openAiCompatibleStrategy } from "./openai-compatible";
import { openRouterStrategy } from "./openrouter";

const schema = {
  name: "test_schema",
  schema: {
    type: "object" as const,
    properties: { value: { type: "string" } },
    required: ["value"],
    additionalProperties: false,
  },
};

const messages = [{ role: "user" as const, content: "hello" }];

describe("provider adapters", () => {
  it("builds requests for each provider/mode path", () => {
    const cases = [
      {
        name: "openrouter-json_schema",
        strategy: openRouterStrategy,
        args: {
          mode: "json_schema" as const,
          baseUrl: "https://openrouter.ai",
          apiKey: "x",
          model: "model-a",
        },
        expectedUrl: "https://openrouter.ai/api/v1/chat/completions",
        expectedResponseFormat: "json_schema",
      },
      {
        name: "openai-json_object",
        strategy: openAiStrategy,
        args: {
          mode: "json_object" as const,
          baseUrl: "https://api.openai.com",
          apiKey: "x",
          model: "model-a",
        },
        expectedUrl: "https://api.openai.com/v1/responses",
      },
      {
        name: "openai-compatible-json_object",
        strategy: openAiCompatibleStrategy,
        args: {
          mode: "json_object" as const,
          baseUrl: "https://llm.example.com/v1/chat/completions",
          apiKey: "x",
          model: "model-a",
        },
        expectedUrl: "https://llm.example.com/v1/chat/completions",
        expectedResponseFormat: "json_object",
      },
      {
        name: "openai-compatible-json_object-base-root",
        strategy: openAiCompatibleStrategy,
        args: {
          mode: "json_object" as const,
          baseUrl: "https://llm.example.com",
          apiKey: "x",
          model: "model-a",
        },
        expectedUrl: "https://llm.example.com/v1/chat/completions",
        expectedResponseFormat: "json_object",
      },
      {
        name: "openai-compatible-json_object-base-v1",
        strategy: openAiCompatibleStrategy,
        args: {
          mode: "json_object" as const,
          baseUrl: "https://llm.example.com/v1/",
          apiKey: "x",
          model: "model-a",
        },
        expectedUrl: "https://llm.example.com/v1/chat/completions",
        expectedResponseFormat: "json_object",
      },
      {
        name: "gemini-json_schema",
        strategy: geminiStrategy,
        args: {
          mode: "json_schema" as const,
          baseUrl: "https://generativelanguage.googleapis.com",
          apiKey: "x",
          model: "gemini-1.5-flash",
        },
        expectedUrlContains: [":generateContent", "key=x"],
      },
      {
        name: "lmstudio-text",
        strategy: lmStudioStrategy,
        args: {
          mode: "text" as const,
          baseUrl: "http://localhost:1234",
          apiKey: null,
          model: "local",
        },
        expectedUrl: "http://localhost:1234/v1/chat/completions",
        expectedResponseFormat: "text",
      },
      {
        name: "ollama-none",
        strategy: ollamaStrategy,
        args: {
          mode: "none" as const,
          baseUrl: "http://localhost:11434",
          apiKey: null,
          model: "local",
        },
        expectedUrl: "http://localhost:11434/v1/chat/completions",
      },
    ];

    for (const testCase of cases) {
      const request = testCase.strategy.buildRequest({
        ...testCase.args,
        messages,
        jsonSchema: schema,
      });

      if (testCase.expectedUrl) {
        expect(request.url, testCase.name).toBe(testCase.expectedUrl);
      }
      if (testCase.expectedUrlContains) {
        for (const expectedPart of testCase.expectedUrlContains) {
          expect(request.url, testCase.name).toContain(expectedPart);
        }
      }

      if (testCase.expectedResponseFormat) {
        const body = request.body as Record<string, unknown>;
        expect(
          (body.response_format as Record<string, unknown>).type,
          testCase.name,
        ).toBe(testCase.expectedResponseFormat);
      }
    }
  });

  it("puts the Bedrock model in the URL path and version in the body", () => {
    const request = bedrockStrategy.buildRequest({
      mode: "text",
      baseUrl: "https://bedrock-runtime.us-east-1.amazonaws.com",
      apiKey: "bearer-token",
      model: "us.anthropic.claude-sonnet-4-5-20250929-v1:0",
      messages: [
        { role: "system", content: "be terse" },
        { role: "user", content: "hi" },
      ],
      jsonSchema: schema,
    });

    // Model lives in the path (encoded), never in the body.
    expect(request.url).toBe(
      "https://bedrock-runtime.us-east-1.amazonaws.com/model/us.anthropic.claude-sonnet-4-5-20250929-v1%3A0/invoke",
    );
    const body = request.body as Record<string, unknown>;
    expect(body.anthropic_version).toBe("bedrock-2023-05-31");
    expect(body.model).toBeUndefined();
    expect(body.system).toBe("be terse");
    expect((request.headers as Record<string, string>).Authorization).toBe(
      "Bearer bearer-token",
    );
  });

  it("extracts Anthropic-shaped content for Bedrock", () => {
    expect(
      bedrockStrategy.extractText({
        content: [{ type: "text", text: "ok" }],
      }),
    ).toBe("ok");
  });

  it("extracts text consistently for chat-completions providers", () => {
    const response = {
      choices: [{ message: { content: "ok" } }],
    };
    expect(openRouterStrategy.extractText(response)).toBe("ok");
    expect(lmStudioStrategy.extractText(response)).toBe("ok");
    expect(ollamaStrategy.extractText(response)).toBe("ok");
  });

  it("builds validation URLs for OpenAI-compatible base URLs and endpoints", () => {
    expect(
      openAiCompatibleStrategy.getValidationUrls({
        baseUrl: "https://llm.example.com",
        apiKey: "x",
      }),
    ).toEqual(["https://llm.example.com/v1/models"]);
    expect(
      openAiCompatibleStrategy.getValidationUrls({
        baseUrl: "https://llm.example.com/v1/",
        apiKey: "x",
      }),
    ).toEqual(["https://llm.example.com/v1/models"]);
    expect(
      openAiCompatibleStrategy.getValidationUrls({
        baseUrl: "https://llm.example.com/v1/chat/completions",
        apiKey: "x",
      }),
    ).toEqual(["https://llm.example.com/v1/models"]);
  });

  it("extracts text for openai and gemini variants", () => {
    expect(openAiStrategy.extractText({ output_text: "openai-direct" })).toBe(
      "openai-direct",
    );
    expect(
      openAiStrategy.extractText({
        output: [
          {
            content: [{ type: "output_text", text: "openai-nested" }],
          },
        ],
      }),
    ).toBe("openai-nested");

    expect(
      geminiStrategy.extractText({
        candidates: [{ content: { parts: [{ text: "gemini" }] } }],
      }),
    ).toBe("gemini");
  });

  it("strips unsupported additionalProperties keys from Gemini responseSchema", () => {
    const request = geminiStrategy.buildRequest({
      mode: "json_schema",
      baseUrl: "https://generativelanguage.googleapis.com",
      apiKey: "x",
      model: "gemini-2.5-flash",
      messages,
      jsonSchema: {
        name: "resume_tailoring",
        schema: {
          type: "object",
          properties: {
            skills: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  name: { type: "string" },
                  keywords: { type: "array", items: { type: "string" } },
                },
                required: ["name", "keywords"],
                additionalProperties: false,
              },
            },
          },
          required: ["skills"],
          additionalProperties: false,
        },
      },
    });

    const generationConfig = (request.body as Record<string, unknown>)
      .generationConfig as Record<string, unknown>;
    const responseSchema = generationConfig.responseSchema as Record<
      string,
      unknown
    >;
    const skills = (responseSchema.properties as Record<string, unknown>)
      .skills as Record<string, unknown>;
    const itemSchema = skills.items as Record<string, unknown>;

    expect(responseSchema.additionalProperties).toBeUndefined();
    expect(itemSchema.additionalProperties).toBeUndefined();
  });

  it("prefixes only the last message with /no_think for local providers (Qwen thinking suppression)", () => {
    const conversation = [
      { role: "system" as const, content: "be terse" },
      { role: "user" as const, content: "score this job" },
    ];

    for (const strategy of [lmStudioStrategy, ollamaStrategy]) {
      const request = strategy.buildRequest({
        mode: "text",
        baseUrl: strategy.defaultBaseUrl,
        apiKey: null,
        model: "local-model",
        messages: conversation,
        jsonSchema: schema,
      });

      const body = request.body as { messages: Array<{ content: string }> };
      expect(body.messages[0].content).toBe("be terse");
      expect(body.messages[1].content).toBe("/no_think\nscore this job");
    }
  });

  it("sends an explicit generous max_tokens for local providers", () => {
    for (const strategy of [lmStudioStrategy, ollamaStrategy]) {
      const request = strategy.buildRequest({
        mode: "text",
        baseUrl: strategy.defaultBaseUrl,
        apiKey: null,
        model: "local-model",
        messages,
        jsonSchema: schema,
      });

      const body = request.body as Record<string, unknown>;
      expect(body.max_tokens).toBe(4096);
    }
  });
});
