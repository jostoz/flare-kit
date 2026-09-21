import { env } from "cloudflare:workers";
import { describe, it, expect } from "vitest";
import worker from "../../src/index";

/**
 * Regression test for the missing `ratelimit` binding bug (commit 6bf7e18,
 * item 3): `bootstrap.ts`'s raw deploy metadata omitted the `API_LIMITER`
 * binding present in wrangler.jsonc, so `env.API_LIMITER` was `undefined`
 * in production and every `/api/*` request 500'd on
 * `c.env.API_LIMITER.limit(...)` before ever reaching a route handler or
 * `requireSession`. This test exercises the real binding wrangler.jsonc
 * declares — if it's ever dropped from a deploy path again, this fails
 * with the same crash instead of surfacing only after a live deploy.
 */
describe("/api/* rate-limit middleware", () => {
  it("returns 401 (unauthenticated), not 500 (missing binding), for an unauthenticated POST", async () => {
    const request = new Request("http://example.com/api/stripe/checkout", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    const res = await worker.fetch(request, env, {
      waitUntil: () => {},
      passThroughOnException: () => {},
    } as ExecutionContext);
    expect(res.status).toBe(401);
  });
});
