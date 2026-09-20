import { Hono, type Context } from "hono";
import { createDb, type Db } from "./db/client";
import { createAuth } from "./server/auth";
import { createStripeRouter, type StripeEnv } from "./server/stripe";
import { createAiRouter, type AiEnv } from "./server/ai";
import { createR2Router, type R2Env } from "./server/r2";
import { renderPage } from "./app/render";
import { Dashboard } from "./app/components/Dashboard";

export interface Env extends StripeEnv, AiEnv, R2Env {
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

app.route("/api/stripe", createStripeRouter());
app.route("/api/ai", createAiRouter());
app.route("/api/r2", createR2Router());

app.get("/", async (c) => {
  const rows = [
    { id: "1", label: "Welcome to flare-kit", status: "active" as const },
    { id: "2", label: "$0/month on Cloudflare Free Tier", status: "active" as const },
  ];
  return renderPage(<Dashboard rows={rows} />, "flare-kit");
});

async function requireSession(c: Context<{ Bindings: Env; Variables: Variables }>, next: () => Promise<void>) {
  const auth = createAuth(c.get("db"), c.env);
  const session = await auth.api.getSession({ headers: c.req.raw.headers });
  if (!session) return c.json({ error: "unauthorized" }, 401);
  c.set("userId", session.user.id);
  await next();
}

export default app;
