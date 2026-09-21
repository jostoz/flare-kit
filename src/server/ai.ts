import { Hono } from "hono";
import { eq, and } from "drizzle-orm";
import type { Db } from "../db/client";
import { schema } from "../db/client";
import { withQuotaGuard, degradedResponse, QuotaExceededError } from "./quota";

export interface AiEnv {
  AI: Ai;
}

const DEFAULT_MODEL = "@cf/meta/llama-3.1-8b-instruct";
// Conservative per-user ceiling against the account-wide 10,000 Neurons/day
// pool (TRD §3.5). Any single tenant is capped well below the shared total.
export const PER_USER_DAILY_NEURON_CAP = 500;

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

      const { prompt } = await c.req.json<{ prompt: string }>();
      const result = await c.env.AI.run(DEFAULT_MODEL, { prompt, max_tokens: 256 });

      // Neuron accounting is approximate here; reconciled nightly against
      // the GraphQL Analytics API by the cron in TRD §3.5.
      const estimatedNeurons = Math.ceil(prompt.length / 4 / 10) + 5;
      await withQuotaGuard(
        () =>
          db
            .insert(schema.aiUsage)
            .values({ userId, day, neurons: estimatedNeurons })
            .onConflictDoUpdate({
              target: [schema.aiUsage.userId, schema.aiUsage.day],
              set: { neurons: (usage?.neurons ?? 0) + estimatedNeurons },
            }),
        "d1_write",
      );

      return c.json({ result });
    } catch (err) {
      if (err instanceof QuotaExceededError) return degradedResponse(err);
      throw err;
    }
  });

  return router;
}
