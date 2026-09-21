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
}

export interface AiGenerateResult {
  text: string;
  estimatedUsageUnits: number;
}

export interface AiProvider {
  generate(messages: ChatMessage[]): Promise<AiGenerateResult>;
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

interface GeminiResponse {
  candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number; totalTokenCount?: number };
  error?: { message?: string };
}

export class GeminiProvider implements AiProvider {
  constructor(private readonly apiKey: string) {}

  async generate(messages: ChatMessage[]): Promise<AiGenerateResult> {
    // Gemini's turn role is "model", not "assistant" — the only shape
    // difference from the internal ChatMessage type.
    const contents = messages.map((m) => ({
      role: m.role === "assistant" ? "model" : "user",
      parts: [{ text: m.content }],
    }));

    const res = await fetch(`${GEMINI_API_BASE}/${GEMINI_MODEL}:generateContent`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-goog-api-key": this.apiKey },
      body: JSON.stringify({ contents, generationConfig: { maxOutputTokens: MAX_OUTPUT_TOKENS } }),
    });

    const body = (await res.json()) as GeminiResponse;
    if (!res.ok) {
      throw new Error(`Gemini API error (${res.status}): ${body.error?.message ?? "unknown error"}`);
    }

    const text = body.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
    // Real token counts from Gemini, mapped onto the same approximate-unit
    // accounting used for Workers AI (see module docstring) — not a claim
    // that these are Neurons.
    const estimatedUsageUnits = body.usageMetadata?.totalTokenCount
      ? Math.ceil(body.usageMetadata.totalTokenCount / 10)
      : estimateUsageUnits(messages);

    return { text, estimatedUsageUnits };
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
const COMPLEXITY_KEYWORDS = /\b(explain|analyze|analyse|compare|debug|refactor|write (a|an|some)|summari[sz]e|code|function|algorithm|architecture|design|plan|step[- ]by[- ]step)\b/i;

export function classifyComplexity(messages: ChatMessage[]): "simple" | "complex" {
  const latest = messages[messages.length - 1]?.content ?? "";
  if (latest.length > COMPLEXITY_LENGTH_THRESHOLD) return "complex";
  if (COMPLEXITY_KEYWORDS.test(latest)) return "complex";
  if (messages.length > COMPLEXITY_HISTORY_THRESHOLD) return "complex";
  return "simple";
}

/**
 * Gemini only when GOOGLE_AI_API_KEY is set AND the prompt is classified
 * complex; Workers AI for everything else (including every request when
 * no Gemini key is configured at all — no code change needed to add or
 * remove Gemini from the mix).
 */
export function resolveAiProvider(env: { AI: Ai; GOOGLE_AI_API_KEY?: string }, messages: ChatMessage[]): AiProvider {
  if (env.GOOGLE_AI_API_KEY && classifyComplexity(messages) === "complex") {
    return new GeminiProvider(env.GOOGLE_AI_API_KEY);
  }
  return new WorkersAiProvider(env.AI);
}
