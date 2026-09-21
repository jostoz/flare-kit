import { describe, it, expect, vi, afterEach } from "vitest";
import { resolveAiProvider, classifyComplexity, WorkersAiProvider, GeminiProvider, DeepSeekProvider, VisionUnavailableError, type ChatMessage } from "../src/server/ai-providers";
import type { ToolDefinition } from "../src/server/tools";

const simple: ChatMessage[] = [{ role: "user", content: "Hi there!" }];
const complex: ChatMessage[] = [{ role: "user", content: "Explain step-by-step how to refactor this function for performance." }];

describe("classifyComplexity", () => {
  it("classifies a short, plain message as simple", () => {
    expect(classifyComplexity(simple)).toBe("simple");
  });

  it("classifies a message with analysis keywords as complex", () => {
    expect(classifyComplexity(complex)).toBe("complex");
  });

  it("classifies a long message as complex regardless of keywords", () => {
    const long: ChatMessage[] = [{ role: "user", content: "a".repeat(300) }];
    expect(classifyComplexity(long)).toBe("complex");
  });

  it("classifies a deep conversation as complex regardless of the latest message", () => {
    const deep: ChatMessage[] = Array.from({ length: 6 }, (_, i) => ({
      role: i % 2 === 0 ? "user" : "assistant",
      content: "ok",
    }));
    expect(classifyComplexity(deep)).toBe("complex");
  });

  it("classifies a short 'needs current info' message as complex", () => {
    expect(classifyComplexity([{ role: "user", content: "What's the weather today?" }])).toBe("complex");
  });
});

describe("resolveAiProvider", () => {
  it("stays on Workers AI when GOOGLE_AI_API_KEY is unset, regardless of complexity", () => {
    const provider = resolveAiProvider({ AI: {} as Ai }, complex);
    expect(provider).toBeInstanceOf(WorkersAiProvider);
  });

  it("stays on Workers AI for a simple prompt even when GOOGLE_AI_API_KEY is set", () => {
    const provider = resolveAiProvider({ AI: {} as Ai, GOOGLE_AI_API_KEY: "test-key" }, simple);
    expect(provider).toBeInstanceOf(WorkersAiProvider);
  });

  it("routes to Gemini for a complex prompt when GOOGLE_AI_API_KEY is set", () => {
    const provider = resolveAiProvider({ AI: {} as Ai, GOOGLE_AI_API_KEY: "test-key" }, complex);
    expect(provider).toBeInstanceOf(GeminiProvider);
  });

  it("routes a simple prompt with an image to Gemini when GOOGLE_AI_API_KEY is set", () => {
    const withImage: ChatMessage[] = [{ role: "user", content: "What is this?", image: { mimeType: "image/png", data: "abc123" } }];
    const provider = resolveAiProvider({ AI: {} as Ai, GOOGLE_AI_API_KEY: "test-key" }, withImage);
    expect(provider).toBeInstanceOf(GeminiProvider);
  });

  it("throws VisionUnavailableError for an image when GOOGLE_AI_API_KEY is unset", () => {
    const withImage: ChatMessage[] = [{ role: "user", content: "What is this?", image: { mimeType: "image/png", data: "abc123" } }];
    expect(() => resolveAiProvider({ AI: {} as Ai }, withImage)).toThrow(VisionUnavailableError);
  });

  it("routes to DeepSeek for a complex prompt when only DEEPSEEK_API_KEY is set", () => {
    const provider = resolveAiProvider({ AI: {} as Ai, DEEPSEEK_API_KEY: "ds-key" }, complex);
    expect(provider).toBeInstanceOf(DeepSeekProvider);
  });

  it("prefers DeepSeek over Gemini for a complex prompt when both keys are set", () => {
    const provider = resolveAiProvider({ AI: {} as Ai, GOOGLE_AI_API_KEY: "g-key", DEEPSEEK_API_KEY: "ds-key" }, complex);
    expect(provider).toBeInstanceOf(DeepSeekProvider);
  });

  it("still routes an image to Gemini even when DEEPSEEK_API_KEY is set", () => {
    const withImage: ChatMessage[] = [{ role: "user", content: "What is this?", image: { mimeType: "image/png", data: "abc123" } }];
    const provider = resolveAiProvider({ AI: {} as Ai, GOOGLE_AI_API_KEY: "g-key", DEEPSEEK_API_KEY: "ds-key" }, withImage);
    expect(provider).toBeInstanceOf(GeminiProvider);
  });
});

describe("GeminiProvider tool-calling loop", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("executes a tool call and feeds the result back for a final answer", async () => {
    const searchTool: ToolDefinition = {
      name: "web_search",
      description: "test tool",
      parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
      execute: vi.fn(async () => "It is sunny today."),
    };

    const fetchMock = vi
      .fn()
      // Round 1: model asks to call the tool.
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          candidates: [{ content: { parts: [{ functionCall: { name: "web_search", args: { query: "weather" } } }] } }],
          usageMetadata: { totalTokenCount: 20 },
        }),
      })
      // Round 2: model returns a final text answer using the tool result.
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          candidates: [{ content: { parts: [{ text: "It's sunny today." }] } }],
          usageMetadata: { totalTokenCount: 15 },
        }),
      });
    vi.stubGlobal("fetch", fetchMock);

    const provider = new GeminiProvider("test-key");
    const result = await provider.generate([{ role: "user", content: "What's the weather today?" }], [searchTool]);

    expect(searchTool.execute).toHaveBeenCalledWith({ query: "weather" });
    expect(result.text).toBe("It's sunny today.");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("strips JSON-Schema keywords Gemini's functionDeclarations don't accept (e.g. exclusiveMinimum, $schema)", async () => {
    const mcpStyleTool: ToolDefinition = {
      name: "analyze_data",
      description: "test tool with a real MCP-style schema",
      parameters: {
        type: "object",
        properties: {
          limit: { type: "integer", exclusiveMinimum: 0, maximum: 100, description: "max results" },
        },
        required: ["limit"],
        $schema: "https://json-schema.org/draft/2020-12/schema",
      } as ToolDefinition["parameters"],
      execute: vi.fn(async () => "ok"),
    };

    const fetchMock = vi.fn().mockResolvedValueOnce({
      ok: true,
      json: async () => ({ candidates: [{ content: { parts: [{ text: "done" }] } }], usageMetadata: { totalTokenCount: 5 } }),
    });
    vi.stubGlobal("fetch", fetchMock);

    await new GeminiProvider("test-key").generate([{ role: "user", content: "go" }], [mcpStyleTool]);

    const sentBody = JSON.parse(fetchMock.mock.calls[0][1].body);
    const sentParams = sentBody.tools[0].functionDeclarations[0].parameters;
    expect(sentParams).not.toHaveProperty("$schema");
    expect(sentParams.properties.limit).not.toHaveProperty("exclusiveMinimum");
    expect(sentParams.properties.limit).not.toHaveProperty("maximum");
    expect(sentParams.properties.limit.type).toBe("integer");
    expect(sentParams.required).toEqual(["limit"]);
  });
});

describe("DeepSeekProvider tool-calling loop", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("executes a tool call and feeds the result back for a final answer", async () => {
    const searchTool: ToolDefinition = {
      name: "web_search",
      description: "test tool",
      parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
      execute: vi.fn(async () => "It is sunny today."),
    };

    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          choices: [{ message: { role: "assistant", content: null, tool_calls: [{ id: "call_1", type: "function", function: { name: "web_search", arguments: '{"query":"weather"}' } }] } }],
          usage: { total_tokens: 20 },
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          choices: [{ message: { role: "assistant", content: "It's sunny today." } }],
          usage: { total_tokens: 15 },
        }),
      });
    vi.stubGlobal("fetch", fetchMock);

    const provider = new DeepSeekProvider("test-key");
    const result = await provider.generate([{ role: "user", content: "What's the weather today?" }], [searchTool]);

    expect(searchTool.execute).toHaveBeenCalledWith({ query: "weather" });
    expect(result.text).toBe("It's sunny today.");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
