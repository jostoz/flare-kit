/**
 * Tool definitions for the Gemini function-calling loop (see
 * GeminiProvider.generate in ai-providers.ts). Tool-calling is Gemini-only:
 * Workers AI's default model (WORKERS_AI_MODEL, ai-providers.ts) has no
 * function-calling capability, same reasoning as the vision decision.
 */

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: { type: "object"; properties: Record<string, unknown>; required?: string[] };
  execute(args: Record<string, unknown>): Promise<string>;
}

interface DuckDuckGoResponse {
  AbstractText?: string;
  Answer?: string;
  RelatedTopics?: Array<{ Text?: string }>;
}

/**
 * DuckDuckGo's Instant Answer API: free, keyless, no signup — the only
 * search API that fits this repo's $0-tier/no-new-secret constraint.
 * Coverage is narrower than a full web-search API (infobox-style facts,
 * not general page results); documented here rather than silently implied
 * by the tool description shown to the model.
 */
export const webSearchTool: ToolDefinition = {
  name: "web_search",
  description:
    "Search the public web for current information (news, facts, prices, dates) the model doesn't already know. Backed by DuckDuckGo's Instant Answer API: best for factual/infobox-style queries, not general page browsing.",
  parameters: {
    type: "object",
    properties: { query: { type: "string", description: "The search query." } },
    required: ["query"],
  },
  async execute(args) {
    const query = typeof args.query === "string" ? args.query.trim() : "";
    if (!query) return "No query provided.";

    const res = await fetch(`https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1&skip_disambig=1`);
    if (!res.ok) return "Web search request failed.";

    const body = (await res.json()) as DuckDuckGoResponse;
    const parts = [
      body.Answer,
      body.AbstractText,
      ...(body.RelatedTopics ?? []).map((t) => t.Text).filter((t): t is string => Boolean(t)),
    ].filter((p): p is string => Boolean(p && p.trim()));

    return parts.length > 0 ? parts.slice(0, 5).join("\n") : `No results found for "${query}".`;
  },
};
