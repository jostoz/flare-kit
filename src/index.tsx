import { Hono, type Context } from "hono";
import { eq, and } from "drizzle-orm";
import { createDb, type Db } from "./db/client";
import { schema } from "./db/client";
import { createAuth } from "./server/auth";
import { createStripeRouter, type StripeEnv } from "./server/stripe";
import { createAiRouter, type AiEnv, PER_USER_DAILY_NEURON_CAP } from "./server/ai";
import { createR2Router, type R2Env } from "./server/r2";
import { withQuotaGuard, degradedResponse, QuotaExceededError } from "./server/quota";
import { reconcileNeuronUsage, type CronEnv } from "./server/cron";
import { createTelegramRouter, type TelegramEnv } from "./server/telegram";
import { renderPage } from "./app/render";
import { Landing } from "./app/components/Landing";
import { UserDashboard } from "./app/components/UserDashboard";

export interface Env extends StripeEnv, AiEnv, R2Env, CronEnv, TelegramEnv {
  DB: D1Database;
  CONFIG_KV: KVNamespace;
  API_LIMITER: RateLimit;
  AUTH_SECRET: string;
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  GITHUB_CLIENT_ID?: string;
  GITHUB_CLIENT_SECRET?: string;
}


type Variables = { userId: string; db: Db };

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

// One D1 client per request, exposed to every downstream router via context.
app.use("*", async (c, next) => {
  c.set("db", createDb(c.env.DB));
  await next();
});

// Defense-in-depth for Workers Caching (TRD §7.4): once cache.enabled is set
// in wrangler.jsonc, ANY 200 response without an explicit Cache-Control
// falls back to Cloudflare's heuristic freshness (2 hours for 200s) —
// including responses from third-party handlers like better-auth's
// auth.handler() whose exact header behavior on every internal route isn't
// something this app controls or audits line-by-line. Force private/no-store
// on every per-user and auth path so nothing here is ever accidentally
// cached and replayed to a different user. "/" opts back into public
// caching explicitly below; it is the only route allowed to.
app.use("/api/*", async (c, next) => {
  await next();
  c.res.headers.set("cache-control", "private, no-store");
});
app.use("/dashboard", async (c, next) => {
  await next();
  c.res.headers.set("cache-control", "private, no-store");
});

// Native Rate Limiting binding: zero cost, zero KV writes (TRD §0 item 2).
app.use("/api/*", async (c, next) => {
  const { success } = await c.env.API_LIMITER.limit({ key: c.req.header("cf-connecting-ip") ?? "anonymous" });
  if (!success) return c.json({ error: "rate_limited" }, 429);
  await next();
});

app.on(["GET", "POST"], "/api/auth/*", (c) => {
  const auth = createAuth(c.get("db"), c.env);
  return auth.handler(c.req.raw);
});

app.use("/api/stripe/*", requireSession);
app.use("/api/ai/*", requireSession);
app.use("/api/r2/*", requireSession);
app.use("/dashboard", requireSession);

app.route("/api/stripe", createStripeRouter());
app.route("/api/ai", createAiRouter());
app.route("/api/r2", createR2Router());
// No requireSession: Telegram's webhook has no session cookie. Auth is the
// X-Telegram-Bot-Api-Secret-Token header check inside the handler itself
// (src/server/telegram.ts) — a wrong/missing secret is rejected there,
// before any database access or inference spend.
app.route("/api/telegram", createTelegramRouter());

// Static content, same HTML for every visitor: safe to edge-cache (TRD §7.4
// static-route budget, p75 < 50ms). Never add per-user data to this route
// without dropping this header — see /dashboard for the authenticated case.
app.get("/", () => renderPage(<Landing />, "flare-kit — $0/month AI assistant on Cloudflare", { "cache-control": "public, max-age=60" }));

// Authenticated, per-user, D1 on the hot path every request — the TRD §7.4
// "dynamic route with D1" budget (p75 < 200ms) applies here, not to "/".
// Must never be edge-cached (no cache-control header set).
app.get("/dashboard", async (c) => {
  const db = c.get("db");
  const userId = c.get("userId");
  const day = new Date().toISOString().slice(0, 10);

  try {
    const [[user], [usage]] = await withQuotaGuard(() =>
      Promise.all([
        db.select().from(schema.users).where(eq(schema.users.id, userId)).limit(1),
        db
          .select()
          .from(schema.aiUsage)
          .where(and(eq(schema.aiUsage.userId, userId), eq(schema.aiUsage.day, day)))
          .limit(1),
      ]),
    );
    if (!user) return c.json({ error: "not_found" }, 404);
    return renderPage(
      <UserDashboard
        data={{
          email: user.email,
          name: user.name,
          neuronsToday: usage?.neurons ?? 0,
          neuronsBudget: PER_USER_DAILY_NEURON_CAP,
        }}
      />,
      "flare-kit — dashboard",
    );
  } catch (err) {
    if (err instanceof QuotaExceededError) return degradedResponse(err);
    throw err;
  }
});

async function requireSession(c: Context<{ Bindings: Env; Variables: Variables }>, next: () => Promise<void>) {
  const auth = createAuth(c.get("db"), c.env);
  const session = await auth.api.getSession({ headers: c.req.raw.headers });
  if (!session) return c.json({ error: "unauthorized" }, 401);
  c.set("userId", session.user.id);
  await next();
}

export default {
  fetch: app.fetch,
  async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
    const db = createDb(env.DB);
    ctx.waitUntil(reconcileNeuronUsage(env, db));
  },
};
