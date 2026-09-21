import { Hono } from "hono";
import { eq, and, desc } from "drizzle-orm";
import type { Db } from "../db/client";
import { schema } from "../db/client";
import { withQuotaGuard, degradedResponse, QuotaExceededError } from "./quota";
import { resolveAiProvider, GeminiProvider, DeepSeekProvider, VisionUnavailableError, type ChatMessage } from "./ai-providers";
import { webSearchTool } from "./tools";
import { mcpToolDefinitions } from "./mcp";

export interface AiEnv {
  AI: Ai;
  /** Opt-in: routes complex-tier inference to Gemini instead of Workers AI when set. See src/server/ai-providers.ts. */
  GOOGLE_AI_API_KEY?: string;
  /** Opt-in: preferred over GOOGLE_AI_API_KEY for the complex text tier (cheaper per token, no aggressive rate limit). Vision stays Gemini-only regardless. */
  DEEPSEEK_API_KEY?: string;
  /** Opt-in: a single remote MCP server URL (Streamable HTTP transport) whose tools are exposed to the chat tool-calling loop alongside web_search. See src/server/mcp.ts. */
  MCP_SERVER_URL?: string;
}

// Conservative per-user ceiling against the shared daily inference budget
// (Workers AI's account-wide 10,000 Neurons/day, or Gemini's own free-tier
// rate limit) — provider-agnostic, see ai-providers.ts. Any single tenant
// is capped well below the shared total.
export const PER_USER_DAILY_NEURON_CAP = 500;

// Sliding window, not full history: bounds both the D1 read cost (TRD
// §2.1 PER_REQUEST_BUDGET.d1RowsRead) and the tokens sent to the model on
// every turn — the same "retrieve only what's needed" principle
// Cloudflare's own Agent Memory product uses (private beta; see
// docs/adding-a-route.md), implemented by hand here since that product
// isn't generally available. A longer conversation costs the same per-turn
// token budget as a short one; older turns simply fall out of the window.
export const AI_HISTORY_WINDOW = 10;

// Request-body caps for the optional image attachment: bounds the D1
// row size indirectly (images are never persisted, see below) and the
// bytes sent to Gemini per turn. 4M base64 chars ≈ 3MB raw image.
const MAX_IMAGE_BASE64_CHARS = 4_000_000;
const ALLOWED_IMAGE_MIME_TYPES = /^image\/(png|jpeg|webp|gif)$/;

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

export function createAiRouter() {
  const router = new Hono<{ Bindings: AiEnv; Variables: { userId: string; db: Db } }>();

  router.post("/chat", async (c) => {
    const db = c.get("db");
    const userId = c.get("userId");
    const day = today();

    try {
      const [usage] = await withQuotaGuard(() =>
        db.select().from(schema.aiUsage).where(and(eq(schema.aiUsage.userId, userId), eq(schema.aiUsage.day, day))).limit(1),
      );
      if (usage && usage.neurons >= PER_USER_DAILY_NEURON_CAP) {
        return c.json({ error: "ai_quota_exceeded", message: "Daily AI quota reached for this account." }, 429);
      }

      const { prompt, image } = await c.req.json<{ prompt: string; image?: { mimeType: string; data: string } }>();
      if (image) {
        if (!ALLOWED_IMAGE_MIME_TYPES.test(image.mimeType)) {
          return c.json({ error: "invalid_image", message: "image.mimeType must be image/png, image/jpeg, image/webp, or image/gif." }, 400);
        }
        if (image.data.length > MAX_IMAGE_BASE64_CHARS) {
          return c.json({ error: "invalid_image", message: "Image too large (max ~3MB)." }, 400);
        }
      }

      const recentRows = await withQuotaGuard(() =>
        db
          .select()
          .from(schema.messages)
          .where(eq(schema.messages.userId, userId))
          .orderBy(desc(schema.messages.createdAt))
          .limit(AI_HISTORY_WINDOW),
      );
      const history: ChatMessage[] = recentRows.reverse().map((m) => ({ role: m.role, content: m.content }));
      // Images live only in this turn's request to the provider — never
      // written to D1 (see the persisted `storedPrompt` below), so history
      // rows loaded above are always text-only.
      const turnMessages: ChatMessage[] = [...history, { role: "user", content: prompt, ...(image ? { image } : {}) }];

      const provider = resolveAiProvider(c.env, turnMessages);
      // Tool-calling (web_search, plus any configured MCP server's tools)
      // is Gemini/DeepSeek-only, see ai-providers.ts. The model decides
      // per-turn whether to invoke any tool; offering the declarations
      // doesn't change behavior for turns that don't need them.
      const toolCallingSupported = provider instanceof GeminiProvider || provider instanceof DeepSeekProvider;
      let tools = toolCallingSupported ? [webSearchTool] : [];
      if (toolCallingSupported && c.env.MCP_SERVER_URL) {
        try {
          tools = [...tools, ...(await mcpToolDefinitions(c.env.MCP_SERVER_URL))];
        } catch {
          // A misbehaving/unreachable MCP server degrades to web_search
          // only, rather than failing the whole chat turn.
        }
      }

      let generated: { text: string; estimatedUsageUnits: number };
      try {
        generated = await provider.generate(turnMessages, tools);
      } catch (err) {
        // DeepSeek can fail independently of the app (rate limit, billing —
        // e.g. a real "Insufficient Balance" seen live in this repo's own
        // testing). Falling back to Gemini keeps the request working
        // instead of surfacing a 500 for an external provider outage; only
        // meaningful when both keys are configured, since DeepSeek is only
        // ever chosen over Gemini, never instead of Workers AI.
        if (provider instanceof DeepSeekProvider && c.env.GOOGLE_AI_API_KEY) {
          generated = await new GeminiProvider(c.env.GOOGLE_AI_API_KEY).generate(turnMessages, tools);
        } else {
          throw err;
        }
      }
      const { text, estimatedUsageUnits } = generated;

      const now = Date.now();
      const storedPrompt = image ? `${prompt} [image attached]` : prompt;
      await withQuotaGuard(
        () =>
          db.insert(schema.messages).values([
            { id: crypto.randomUUID(), userId, role: "user", content: storedPrompt, createdAt: now },
            { id: crypto.randomUUID(), userId, role: "assistant", content: text, createdAt: now },
          ]),
        "d1_write",
      );
      await withQuotaGuard(
        () =>
          db
            .insert(schema.aiUsage)
            .values({ userId, day, neurons: estimatedUsageUnits })
            .onConflictDoUpdate({
              target: [schema.aiUsage.userId, schema.aiUsage.day],
              set: { neurons: (usage?.neurons ?? 0) + estimatedUsageUnits },
            }),
        "d1_write",
      );

      return c.json({ result: text });
    } catch (err) {
      if (err instanceof QuotaExceededError) return degradedResponse(err);
      if (err instanceof VisionUnavailableError) return c.json({ error: "vision_unavailable", message: err.message }, 503);
      throw err;
    }
  });

  return router;
}
