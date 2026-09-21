import { env } from "cloudflare:workers";
import { describe, it, expect } from "vitest";
import worker from "../../src/index";

/**
 * Full sign-up -> sign-in -> authenticated D1 query loop against the real
 * Workers runtime (workerd + Miniflare D1, not mocks). This exact path is
 * what surfaced three of the four bugs fixed in commit 6bf7e18 — a missing
 * better-auth schema, a PBKDF2 iteration count Workers rejects at runtime,
 * and a Drizzle timestamp-mode mismatch — none of which threw in the
 * previous Node-environment test suite because none of it ran real D1 or
 * real Workers crypto.subtle.
 */

async function post(path: string, body: unknown, cookie?: string): Promise<Response> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (cookie) headers.cookie = cookie;
  const request = new Request(`http://example.com${path}`, { method: "POST", headers, body: JSON.stringify(body) });
  return worker.fetch(request, env, { waitUntil: () => {}, passThroughOnException: () => {} } as ExecutionContext);
}

async function get(path: string, cookie?: string): Promise<Response> {
  const headers: Record<string, string> = {};
  if (cookie) headers.cookie = cookie;
  const request = new Request(`http://example.com${path}`, { headers });
  return worker.fetch(request, env, { waitUntil: () => {}, passThroughOnException: () => {} } as ExecutionContext);
}

function extractSessionCookie(res: Response): string {
  const setCookie = res.headers.get("set-cookie");
  if (!setCookie) throw new Error("sign-in response had no Set-Cookie header");
  // better-auth sets multiple attributes after the first `;` — only the
  // name=value pair is needed for the next request's Cookie header.
  return setCookie.split(";")[0];
}

describe("authenticated dashboard (real D1 + real crypto.subtle)", () => {
  const email = `dashboard-test-${crypto.randomUUID()}@example.com`;
  const password = "correcthorsebatterystaple123";

  it("rejects an unauthenticated request", async () => {
    const res = await get("/dashboard");
    expect(res.status).toBe(401);
    expect(res.headers.get("cache-control")).toBe("private, no-store");
  });

  it("signs up, signs in, and serves the real dashboard for that user", async () => {
    const signUp = await post("/api/auth/sign-up/email", { email, password, name: "Integration Test" });
    expect(signUp.status).toBe(200);

    const signIn = await post("/api/auth/sign-in/email", { email, password });
    expect(signIn.status).toBe(200);
    const cookie = extractSessionCookie(signIn);

    const dashboard = await get("/dashboard", cookie);
    expect(dashboard.status).toBe(200);
    expect(dashboard.headers.get("cache-control")).toBe("private, no-store");

    const html = await dashboard.text();
    expect(html).toContain(email);
    // React SSR emits comment-boundary markers between JSX expressions
    // ("0<!-- --> / <!-- -->500"), so match the two numbers independently.
    expect(html).toMatch(/>0<!-- --> \/ <!-- -->500</);
  });
});

describe("static landing page caching (TRD §7.4)", () => {
  it("sets a public, edge-cacheable Cache-Control header", async () => {
    const res = await get("/");
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("public, max-age=60");
  });
});
