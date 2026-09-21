import { env } from "cloudflare:workers";
import { Hono } from "hono";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createDb, type Db } from "../../src/db/client";
import { createTelegramRouter, type TelegramEnv } from "../../src/server/telegram";

/**
 * Telegram channel: same chat+memory core (runChatTurn) as /api/ai/chat,
 * reached over a webhook instead of a session-cookie-authenticated route.
 * Workers AI has no local simulator (see test/integration/ai-memory.test.ts)
 * — env.AI.run is stubbed. Telegram's own API is stubbed via an injected
 * `fetchImpl` (see telegram.ts for why: this repo's `cloudflare:test`
 * version has no in-isolate `fetchMock`).
 */

function buildApp(fetchImpl: typeof fetch) {
  const app = new Hono<{ Bindings: TelegramEnv; Variables: { db: Db } }>();
  app.use("*", async (c, next) => {
    c.set("db", createDb(c.env.DB));
    await next();
  });
  app.route("/api/telegram", createTelegramRouter(fetchImpl));
  return app;
}

const CONFIGURED_ENV = { ...env, TELEGRAM_BOT_TOKEN: "test-bot-token", TELEGRAM_WEBHOOK_SECRET: "test-webhook-secret" };

function post(app: Hono<{ Bindings: TelegramEnv; Variables: { db: Db } }>, env_: typeof CONFIGURED_ENV, body: unknown, secretHeader?: string) {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (secretHeader !== undefined) headers["X-Telegram-Bot-Api-Secret-Token"] = secretHeader;
  const request = new Request("http://example.com/api/telegram/webhook", { method: "POST", headers, body: JSON.stringify(body) });
  return app.fetch(request, env_, { waitUntil: () => {}, passThroughOnException: () => {} } as ExecutionContext);
}

beforeEach(() => {
  // @ts-expect-error — see ai-memory.test.ts's identical stub.
  env.AI.run = async () => ({ response: "mocked telegram reply" });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Telegram webhook", () => {
  it("rejects a request missing the secret token header", async () => {
    const app = buildApp(fetch);
    const res = await post(app, CONFIGURED_ENV, { message: { chat: { id: 1 }, text: "hi" } });
    expect(res.status).toBe(401);
  });

  it("rejects a request with the wrong secret token", async () => {
    const app = buildApp(fetch);
    const res = await post(app, CONFIGURED_ENV, { message: { chat: { id: 1 }, text: "hi" } }, "wrong-secret");
    expect(res.status).toBe(401);
  });

  it("503s when Telegram isn't configured", async () => {
    const app = buildApp(fetch);
    const res = await post(app, env, { message: { chat: { id: 1 }, text: "hi" } }, "anything");
    expect(res.status).toBe(503);
  });

  it("acknowledges non-message updates without calling Telegram's API", async () => {
    const fetchStub = vi.fn();
    const app = buildApp(fetchStub as unknown as typeof fetch);
    const res = await post(app, CONFIGURED_ENV, { edited_message: { chat: { id: 1 }, text: "edited" } }, "test-webhook-secret");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(fetchStub).not.toHaveBeenCalled();
  });

  it("runs a chat turn and replies via Telegram's sendMessage, persisting messages under a synthetic telegram: userId", async () => {
    const chatId = 424242;
    const fetchStub = vi.fn(async (url: string | URL | Request) => {
      expect(String(url)).toBe(`https://api.telegram.org/bottest-bot-token/sendMessage`);
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });
    const app = buildApp(fetchStub as unknown as typeof fetch);

    const res = await post(app, CONFIGURED_ENV, { message: { chat: { id: chatId }, text: "Hello from Telegram" } }, "test-webhook-secret");

    expect(res.status).toBe(200);
    expect(fetchStub).toHaveBeenCalledOnce();
    const sentBody = JSON.parse(String((fetchStub.mock.calls[0][1] as RequestInit).body));
    expect(sentBody).toMatchObject({ chat_id: chatId, text: "mocked telegram reply" });

    const rows = await env.DB.prepare("SELECT user_id, role, content FROM messages WHERE user_id = ? ORDER BY created_at").bind(`telegram:${chatId}`).all();
    expect(rows.results).toHaveLength(2);
    expect(rows.results[0]).toMatchObject({ user_id: `telegram:${chatId}`, role: "user", content: "Hello from Telegram" });
    expect(rows.results[1]).toMatchObject({ user_id: `telegram:${chatId}`, role: "assistant", content: "mocked telegram reply" });
  });
});
