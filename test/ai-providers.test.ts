import { describe, it, expect } from "vitest";
import { resolveAiProvider, WorkersAiProvider, GeminiProvider } from "../src/server/ai-providers";

describe("resolveAiProvider", () => {
  it("defaults to Workers AI when GOOGLE_AI_API_KEY is unset", () => {
    const provider = resolveAiProvider({ AI: {} as Ai });
    expect(provider).toBeInstanceOf(WorkersAiProvider);
  });

  it("switches to Gemini when GOOGLE_AI_API_KEY is set — no code change needed", () => {
    const provider = resolveAiProvider({ AI: {} as Ai, GOOGLE_AI_API_KEY: "test-key" });
    expect(provider).toBeInstanceOf(GeminiProvider);
  });
});
