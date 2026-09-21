import { describe, it, expect } from "vitest";
import { resolveAiProvider, classifyComplexity, WorkersAiProvider, GeminiProvider, VisionUnavailableError, type ChatMessage } from "../src/server/ai-providers";

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
});
