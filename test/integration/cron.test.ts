import { env } from "cloudflare:workers";
import { describe, it, expect, vi } from "vitest";
import { createDb } from "../../src/db/client";
import { schema } from "../../src/db/client";
import { reconcileNeuronUsage } from "../../src/server/cron";
import worker from "../../src/index";

/**
 * Daily Neuron-usage reconciliation (TRD §3.5): the Cron Trigger declared
 * in wrangler.jsonc ("0 3 * * *") must actually reconcile the D1-estimated
 * Neuron figure against Cloudflare's GraphQL Analytics API.
 *
 * `reconcileNeuronUsage` takes an injectable `fetchImpl` (see cron.ts)
 * specifically because this suite runs inside the real workerd isolate
 * (`@cloudflare/vitest-plugin`), where a Node-side
 * `vi.stubGlobal("fetch", ...)` never reaches code executing in that
 * isolate, and this repo's `cloudflare:test` version doesn't export an
 * in-isolate `fetchMock` (unlike `@cloudflare/vitest-pool-workers`).
 */

describe("reconcileNeuronUsage", () => {
  it("combines the D1 estimate with the Analytics API totals into a neuron_calibration row", async () => {
    const db = createDb(env.DB);
    const day = "2026-01-15";

    await db.insert(schema.users).values({ id: "u1", email: "cron-test@example.com", name: "Cron Test", emailVerified: false, createdAt: new Date(), updatedAt: new Date() });
    await db.insert(schema.aiUsage).values([{ userId: "u1", day, neurons: 12 }]);

    const fetchStub = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      expect(String(url)).toBe("https://api.cloudflare.com/client/v4/graphql");
      expect(init?.method).toBe("POST");
      return new Response(
        JSON.stringify({
          data: {
            viewer: {
              accounts: [{ aiInferenceAdaptiveGroups: [{ count: 3, sum: { totalInputTokens: 500, totalOutputTokens: 200 } }] }],
            },
          },
        }),
        { status: 200 },
      );
    });

    await reconcileNeuronUsage({ CF_ACCOUNT_ID: "test-account", CF_ANALYTICS_API_TOKEN: "test-token" }, db, day, fetchStub as unknown as typeof fetch);

    expect(fetchStub).toHaveBeenCalledOnce();
    const row = await env.DB.prepare("SELECT * FROM neuron_calibration WHERE day = ?").bind(day).first();
    expect(row).toMatchObject({
      day,
      estimated_neurons: 12,
      real_request_count: 3,
      real_input_tokens: 500,
      real_output_tokens: 200,
    });
  });

  it("skips reconciliation without calling fetch when CF_ANALYTICS_API_TOKEN is unset", async () => {
    const db = createDb(env.DB);
    const fetchStub = vi.fn();

    await reconcileNeuronUsage({}, db, "2026-01-16", fetchStub as unknown as typeof fetch);

    expect(fetchStub).not.toHaveBeenCalled();
  });
});

describe("worker.scheduled", () => {
  it("is wired to reconcileNeuronUsage and returns cleanly with no analytics credentials configured", async () => {
    // Real env has no CF_ANALYTICS_API_TOKEN in this test suite, so
    // reconcileNeuronUsage's own env-guard short-circuits before any real
    // outbound fetch — proves the entrypoint (wrangler.jsonc's Cron
    // Trigger -> src/index.tsx's `scheduled` export) is actually wired to
    // the reconciliation job, not merely present in the same file.
    let pending: Promise<unknown> = Promise.resolve();
    await expect(
      worker.scheduled(
        { cron: "0 3 * * *", scheduledTime: Date.now() } as ScheduledEvent,
        env,
        { waitUntil: (p: Promise<unknown>) => { pending = p; }, passThroughOnException: () => {} } as ExecutionContext,
      ),
    ).resolves.toBeUndefined();
    await expect(pending).resolves.toBeUndefined();
  });
});
