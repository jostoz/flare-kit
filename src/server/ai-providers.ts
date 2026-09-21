import type { ToolDefinition } from "./tools";

/**
 * Inference provider abstraction. Two implementations, same interface, so
 * `createAiRouter` doesn't care which one is active:
 *
 * - Workers AI (default): runs inside Cloudflare's own network, no outbound
 *   fetch, billed in Neurons against the account's shared free-tier pool.
 * - Gemini (opt-in via GOOGLE_AI_API_KEY): a real outbound `fetch()` to
 *   Google's API — same pattern as the existing Stripe integration, not a
 *   new deployment target. Chosen when a token-budget-heavy assistant
 *   outgrows Workers AI's 10,000 Neurons/day shared pool; see docs/adding-a-route.md
 *   or the project README for the tradeoffs (latency, an external
 *   dependency, a larger/more capable model).
 *
 * `estimatedUsageUnits` is intentionally provider-agnostic: the same
 * `ai_usage.neurons` column and PER_USER_DAILY_NEURON_CAP apply to both,
 * as an approximate per-user throttle reconciled later — not a claim that
 * Gemini tokens and Cloudflare Neurons are the same unit.
 *
 * `generate` takes the full turn history (already windowed by the caller —
 * see AI_HISTORY_WINDOW in ai.ts), not a single prompt: conversation memory
 * requires the model to see prior turns, and both providers' native chat
 * formats (Workers AI's `messages`, Gemini's `contents`) are built for
 * exactly this rather than string concatenation.
 */

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
  /** Vision input for this turn only — never persisted to D1 history (see ai.ts); Gemini-only, see resolveAiProvider. */
  image?: { mimeType: string; data: string };
}

export interface AiGenerateResult {
  text: string;
  estimatedUsageUnits: number;
}

export interface AiProvider {
  /** `tools` is Gemini-only (see GeminiProvider below); WorkersAiProvider ignores it. */
  generate(messages: ChatMessage[], tools?: ToolDefinition[]): Promise<AiGenerateResult>;
}

function estimateUsageUnits(messages: ChatMessage[]): number {
  const totalChars = messages.reduce((sum, m) => sum + m.content.length, 0);
  return Math.ceil(totalChars / 4 / 10) + 5;
}

const WORKERS_AI_MODEL = "@cf/meta/llama-3.1-8b-instruct-fp8"; // plain llama-3.1-8b-instruct was deprecated 2026-05-30 (error 5028); confirmed live.
const MAX_OUTPUT_TOKENS = 256;

export class WorkersAiProvider implements AiProvider {
  constructor(private readonly ai: Ai) {}

  async generate(messages: ChatMessage[]): Promise<AiGenerateResult> {
    const result = await this.ai.run(WORKERS_AI_MODEL, { messages, max_tokens: MAX_OUTPUT_TOKENS });
    const text = "response" in result && typeof result.response === "string" ? result.response : "";
    // Neuron accounting is approximate here; reconciled nightly against the
    // GraphQL Analytics API by the cron in TRD §3.5.
    return { text, estimatedUsageUnits: estimateUsageUnits(messages) };
  }
}

const GEMINI_MODEL = "gemini-3.6-flash"; // gemini-2.5-flash was retired for new accounts; confirmed live against a real key.
const GEMINI_API_BASE = "https://generativelanguage.googleapis.com/v1beta/models";

interface GeminiFunctionCall {
  name: string;
  args?: Record<string, unknown>;
}

interface GeminiPart {
  text?: string;
  functionCall?: GeminiFunctionCall;
  /** Gemini 3 requires the first functionCall part of a turn to echo back
   * its thoughtSignature verbatim on the next request, or the call fails
   * with a 400 — treated as an opaque blob, never inspected/modified. */
  thoughtSignature?: string;
}

interface GeminiResponse {
  candidates?: Array<{ content?: { parts?: GeminiPart[] } }>;
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number; totalTokenCount?: number };
  error?: { message?: string };
}

interface GeminiContent {
  role: "user" | "model";
  parts: Array<{
    text?: string;
    inlineData?: { mimeType: string; data: string };
    functionCall?: GeminiFunctionCall;
    functionResponse?: { name: string; response: { result: string } };
    thoughtSignature?: string;
  }>;
}

// Bounds a single request to at most this many tool round-trips: protects
// the CPU-time budget (TRD §7.1) and the tool's own external API budget
// (e.g. DuckDuckGo) against a model stuck in a call/respond loop.
const MAX_TOOL_ROUNDS = 3;

/**
 * Gemini's function-declaration `parameters` accept only a restricted
 * subset of JSON Schema (roughly OpenAPI 3.0's Schema object) — not full
 * JSON Schema. Tool authors (this repo's own webSearchTool, and any
 * remote MCP server's tools/list output, see mcp.ts) may reasonably use
 * standard JSON Schema keywords Gemini rejects outright with a 400
 * ("Unknown name ... Cannot find field"); confirmed live against a real
 * MCP server's schema (`exclusiveMinimum`). Recursively keeps only the
 * keys Gemini documents support and drops the rest, rather than trying to
 * translate every JSON Schema keyword into an OpenAPI equivalent.
 */
const GEMINI_SCHEMA_KEYS = new Set(["type", "description", "enum", "items", "properties", "required", "format", "nullable"]);

function sanitizeGeminiSchema(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(sanitizeGeminiSchema);
  if (schema === null || typeof schema !== "object") return schema;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(schema as Record<string, unknown>)) {
    if (!GEMINI_SCHEMA_KEYS.has(key)) continue;
    out[key] = key === "properties" && value && typeof value === "object" ? Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, sanitizeGeminiSchema(v)])) : sanitizeGeminiSchema(value);
  }
  return out;
}

export class GeminiProvider implements AiProvider {
  constructor(private readonly apiKey: string) {}

  async generate(messages: ChatMessage[], tools: ToolDefinition[] = []): Promise<AiGenerateResult> {
    // Gemini's turn role is "model", not "assistant" — the only shape
    // difference from the internal ChatMessage type. An attached image
    // becomes an extra `inlineData` part alongside the text part.
    let contents: GeminiContent[] = messages.map((m) => ({
      role: m.role === "assistant" ? "model" : "user",
      parts: m.image
        ? [{ text: m.content }, { inlineData: { mimeType: m.image.mimeType, data: m.image.data } }]
        : [{ text: m.content }],
    }));

    const toolsPayload = tools.length
      ? [{ functionDeclarations: tools.map((t) => ({ name: t.name, description: t.description, parameters: sanitizeGeminiSchema(t.parameters) })) }]
      : undefined;

    let totalUsageUnits = 0;
    let lastToolResult: string | undefined;

    for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
      const res = await fetch(`${GEMINI_API_BASE}/${GEMINI_MODEL}:generateContent`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-goog-api-key": this.apiKey },
        body: JSON.stringify({ contents, tools: toolsPayload, generationConfig: { maxOutputTokens: MAX_OUTPUT_TOKENS } }),
      });

      const body = (await res.json()) as GeminiResponse;
      if (!res.ok) {
        throw new Error(`Gemini API error (${res.status}): ${body.error?.message ?? "unknown error"}`);
      }

      // Real token counts from Gemini, mapped onto the same approximate-unit
      // accounting used for Workers AI (see module docstring) — not a claim
      // that these are Neurons. Summed across every tool round-trip.
      totalUsageUnits += body.usageMetadata?.totalTokenCount ? Math.ceil(body.usageMetadata.totalTokenCount / 10) : 0;

      const parts = body.candidates?.[0]?.content?.parts ?? [];
      const functionCallPart = parts.find((p) => p.functionCall);

      if (functionCallPart?.functionCall && round < MAX_TOOL_ROUNDS) {
        const functionCall = functionCallPart.functionCall;
        const tool = tools.find((t) => t.name === functionCall.name);
        const result = tool ? await tool.execute(functionCall.args ?? {}) : `Unknown tool: ${functionCall.name}`;
        lastToolResult = result;
        contents = [
          ...contents,
          // Echo the functionCall part back exactly as received, including
          // thoughtSignature (see GeminiPart) — Gemini 3 rejects a
          // reconstructed {name, args} pair missing that field.
          { role: "model", parts: [functionCallPart] },
          // gemini-3.6-flash rejects role "function" (400: "Role 'function'
          // is not supported"); functionResponse parts travel on a "user"
          // turn instead — confirmed against a live key.
          { role: "user", parts: [{ functionResponse: { name: functionCall.name, response: { result } } }] },
        ];
        continue;
      }

      const text = parts
        .map((p) => p.text)
        .filter((t): t is string => Boolean(t))
        .join("");
      return { text, estimatedUsageUnits: totalUsageUnits || estimateUsageUnits(messages) };
    }

    // Exhausted MAX_TOOL_ROUNDS still asking for another tool call: surface
    // the last tool result directly rather than an empty answer.
    return { text: lastToolResult ?? "", estimatedUsageUnits: totalUsageUnits };
  }
}

/**
 * DeepSeek (opt-in via DEEPSEEK_API_KEY): OpenAI-compatible chat-completions
 * REST API, chosen as the preferred "complex" escalation tier over Gemini
 * when configured — DeepSeek's per-token pricing (deepseek-chat, ~$0.28/1M
 * input, ~$0.42/1M output as of this writing) is a fraction of Gemini's
 * paid tier and its free tier has no aggressive per-minute rate limit to
 * fight in testing/production. Text-only: vision stays Gemini-specific
 * (see resolveAiProvider) since DeepSeek's standard chat model has no
 * public multimodal endpoint.
 */
const DEEPSEEK_MODEL = "deepseek-chat";
const DEEPSEEK_API_BASE = "https://api.deepseek.com/chat/completions";

interface DeepSeekToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

interface DeepSeekMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: DeepSeekToolCall[];
  tool_call_id?: string;
}

interface DeepSeekResponse {
  choices?: Array<{ message?: DeepSeekMessage }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
  error?: { message?: string };
}

export class DeepSeekProvider implements AiProvider {
  constructor(private readonly apiKey: string) {}

  async generate(messages: ChatMessage[], tools: ToolDefinition[] = []): Promise<AiGenerateResult> {
    let apiMessages: DeepSeekMessage[] = messages.map((m) => ({ role: m.role, content: m.content }));
    const toolsPayload = tools.length
      ? tools.map((t) => ({ type: "function" as const, function: { name: t.name, description: t.description, parameters: t.parameters } }))
      : undefined;

    let totalUsageUnits = 0;
    let lastToolResult: string | undefined;

    for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
      const res = await fetch(DEEPSEEK_API_BASE, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${this.apiKey}` },
        body: JSON.stringify({ model: DEEPSEEK_MODEL, messages: apiMessages, tools: toolsPayload, max_tokens: MAX_OUTPUT_TOKENS }),
      });

      const body = (await res.json()) as DeepSeekResponse;
      if (!res.ok) {
        throw new Error(`DeepSeek API error (${res.status}): ${body.error?.message ?? "unknown error"}`);
      }

      totalUsageUnits += body.usage?.total_tokens ? Math.ceil(body.usage.total_tokens / 10) : 0;

      const message = body.choices?.[0]?.message;
      const toolCall = message?.tool_calls?.[0];

      if (toolCall && round < MAX_TOOL_ROUNDS) {
        const tool = tools.find((t) => t.name === toolCall.function.name);
        const args = tool ? (JSON.parse(toolCall.function.arguments || "{}") as Record<string, unknown>) : {};
        const result = tool ? await tool.execute(args) : `Unknown tool: ${toolCall.function.name}`;
        lastToolResult = result;
        apiMessages = [
          ...apiMessages,
          { role: "assistant", content: message?.content ?? null, tool_calls: message?.tool_calls },
          { role: "tool", content: result, tool_call_id: toolCall.id },
        ];
        continue;
      }

      return { text: message?.content ?? "", estimatedUsageUnits: totalUsageUnits || estimateUsageUnits(messages) };
    }

    return { text: lastToolResult ?? "", estimatedUsageUnits: totalUsageUnits };
  }
}

/**
 * Smart routing (PicoClaw-inspired: "simple queries go to lightweight
 * models, saving API costs"). Only meaningful when GOOGLE_AI_API_KEY is
 * set — Gemini costs real money per call beyond its own free tier, while
 * Workers AI's Neuron pool is Cloudflare's, already budgeted. Routing a
 * short, simple prompt to Gemini would spend external API budget on
 * something the free in-network model handles fine; routing a complex
 * prompt to the small in-network model risks a worse answer.
 *
 * A short, single-sentence question stays on Workers AI. A long prompt,
 * one with code/analysis intent, or one already carrying enough
 * conversation history to need real reasoning gets escalated to Gemini.
 * This is a heuristic, not a classifier model — tune the thresholds/regex
 * against real usage, not this comment.
 */
const COMPLEXITY_LENGTH_THRESHOLD = 240; // chars in the latest user turn
const COMPLEXITY_HISTORY_THRESHOLD = 4; // turns of context already accumulated
const COMPLEXITY_KEYWORDS =
  /\b(explain|analyze|analyse|compare|debug|refactor|write (a|an|some)|summari[sz]e|code|function|algorithm|architecture|design|plan|step[- ]by[- ]step|current|latest|today|right now|this week|breaking|news|weather|stock price|who won|score)\b/i;

export function classifyComplexity(messages: ChatMessage[]): "simple" | "complex" {
  const latest = messages[messages.length - 1]?.content ?? "";
  if (latest.length > COMPLEXITY_LENGTH_THRESHOLD) return "complex";
  if (COMPLEXITY_KEYWORDS.test(latest)) return "complex";
  if (messages.length > COMPLEXITY_HISTORY_THRESHOLD) return "complex";
  return "simple";
}

/**
 * Gemini or DeepSeek when a key is configured AND the prompt is classified
 * complex; Workers AI for everything else (including every request when
 * no external key is configured at all — no code change needed to add or
 * remove either from the mix).
 *
 * DeepSeek is preferred over Gemini for the "complex" text tier when both
 * keys are set: cheaper per token and no aggressive free-tier rate limit
 * (see DeepSeekProvider above). Gemini remains the only vision-capable
 * option, so an attached image always routes to Gemini specifically,
 * regardless of which text-tier key is configured.
 *
 * An attached image forces Gemini regardless of complexity: Workers AI's
 * default model (WORKERS_AI_MODEL, above) is text-only, and swapping the
 * default model to a heavier vision-capable one would tax every plain-text
 * request's latency/Neuron cost for a capability most turns don't use.
 * Vision without a configured Gemini key throws VisionUnavailableError
 * (caught in ai.ts) rather than silently dropping the image or crashing on
 * an incompatible model call.
 */
export class VisionUnavailableError extends Error {
  constructor() {
    super("Image input requires GOOGLE_AI_API_KEY to be configured.");
  }
}

export function resolveAiProvider(
  env: { AI: Ai; GOOGLE_AI_API_KEY?: string; DEEPSEEK_API_KEY?: string },
  messages: ChatMessage[],
): AiProvider {
  const hasImage = messages.some((m) => m.image);
  if (hasImage) {
    if (!env.GOOGLE_AI_API_KEY) throw new VisionUnavailableError();
    return new GeminiProvider(env.GOOGLE_AI_API_KEY);
  }
  if ((env.DEEPSEEK_API_KEY || env.GOOGLE_AI_API_KEY) && classifyComplexity(messages) === "complex") {
    if (env.DEEPSEEK_API_KEY) return new DeepSeekProvider(env.DEEPSEEK_API_KEY);
    return new GeminiProvider(env.GOOGLE_AI_API_KEY!);
  }
  return new WorkersAiProvider(env.AI);
}
