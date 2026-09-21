import { env } from "cloudflare:workers";
import { describe, it, expect, beforeEach } from "vitest";
import worker from "../../src/index";

/**
 * Conversation memory regression: a second turn must be able to reference
 * what was said in the first, proving the message history round-trips
 * through D1 rather than each /api/ai/chat call being stateless.
 *
 * Workers AI has no local simulator — any real call bills real Neurons,
 * even in tests (Cloudflare's own vitest-plugin fixtures recommend
 * mocking it for exactly this reason). `env.AI.run` is stubbed below so
 * this suite costs nothing to run on every PR.
 */

async function post(path: string, body: unknown, cookie?: string): Promise<Response> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (cookie) headers.cookie = cookie;
  const request = new Request(`http://example.com${path}`, { method: "POST", headers, body: JSON.stringify(body) });
  return worker.fetch(request, env, { waitUntil: () => {}, passThroughOnException: () => {} } as ExecutionContext);
}

function extractSessionCookie(res: Response): string {
  const setCookie = res.headers.get("set-cookie");
  if (!setCookie) throw new Error("sign-in response had no Set-Cookie header");
  return setCookie.split(";")[0];
}

beforeEach(() => {
  // @ts-expect-error — Ai.run's real signature is a large overload union; a test stub only needs to satisfy the { messages } call shape ai-providers.ts actually uses.
  env.AI.run = async () => ({ response: "mocked reply" });
});

describe("AI conversation memory (real D1, Workers AI mocked)", () => {
  it("persists both turns of a chat exchange to the messages table", async () => {
    const email = `memory-test-${crypto.randomUUID()}@example.com`;
    const password = "correcthorsebatterystaple123";

    await post("/api/auth/sign-up/email", { email, password, name: "Memory Test" });
    const signIn = await post("/api/auth/sign-in/email", { email, password });
    const cookie = extractSessionCookie(signIn);

    const chat = await post("/api/ai/chat", { prompt: "Hello" }, cookie);
    expect(chat.status).toBe(200);

    const rows = await env.DB.prepare("SELECT role, content FROM messages ORDER BY created_at").all();
    expect(rows.results).toHaveLength(2);
    expect(rows.results[0]).toMatchObject({ role: "user", content: "Hello" });
    expect(rows.results[1]).toMatchObject({ role: "assistant" });
  });
});
