/**
 * Daily Neuron-usage reconciliation (TRD §3.5): "El consumo real se
 * reconcilia contra la GraphQL Analytics API mediante Cron Trigger diario;
 * los costes por Neuron del modelo se calibran ahí, no se hardcodean."
 * The Cron Trigger itself (`triggers.crons` in wrangler.jsonc, "0 3 * * *")
 * already existed; this wires it to the job the TRD specifies rather than
 * leaving it unimplemented.
 *
 * `ai_usage.neurons` (written per-request in ai.ts) is a cheap
 * character-count approximation — good enough for the per-user daily quota
 * gate, wrong to trust as real cost accounting. This job pulls the real
 * totals from Cloudflare's account-level GraphQL Analytics API
 * (`aiInferenceAdaptiveGroups`) once a day and stores both figures side by
 * side in `neuron_calibration` (src/db/schema.ts) so the approximation's
 * drift is visible — not silently trusted forever.
 *
 * Opt-in: CF_ACCOUNT_ID + CF_ANALYTICS_API_TOKEN (a narrowly-scoped
 * Account Analytics:Read token — deliberately NOT the same token used to
 * deploy this Worker, which has far broader permissions and has no
 * business being bound into the running Worker itself). Missing either
 * skips the reconciliation rather than failing the cron run.
 */

import { eq, sql } from "drizzle-orm";
import type { Db } from "../db/client";
import { schema } from "../db/client";

export interface CronEnv {
  CF_ACCOUNT_ID?: string;
  CF_ANALYTICS_API_TOKEN?: string;
}

interface AiInferenceGroup {
  count: number;
  sum: { totalInputTokens: number; totalOutputTokens: number };
}

interface GraphQLResponse {
  data?: { viewer?: { accounts?: Array<{ aiInferenceAdaptiveGroups?: AiInferenceGroup[] }> } };
  errors?: Array<{ message: string }>;
}

/** Yesterday, UTC, YYYY-MM-DD — the cron runs at 03:00 UTC, after the previous day is fully closed out. */
export function reconciliationDay(now: Date = new Date()): string {
  const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  return yesterday.toISOString().slice(0, 10);
}

async function fetchRealUsage(
  env: CronEnv,
  day: string,
  fetchImpl: typeof fetch,
): Promise<{ requestCount: number; inputTokens: number; outputTokens: number }> {
  const query = `query ReconcileNeuronUsage($accountTag: string!, $start: Time!, $end: Time!) {
    viewer {
      accounts(filter: { accountTag: $accountTag }) {
        aiInferenceAdaptiveGroups(filter: { datetime_geq: $start, datetime_leq: $end }, limit: 1000) {
          count
          sum { totalInputTokens totalOutputTokens }
        }
      }
    }
  }`;

  const res = await fetchImpl("https://api.cloudflare.com/client/v4/graphql", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${env.CF_ANALYTICS_API_TOKEN}` },
    body: JSON.stringify({
      query,
      variables: { accountTag: env.CF_ACCOUNT_ID, start: `${day}T00:00:00Z`, end: `${day}T23:59:59Z` },
    }),
  });

  const body = (await res.json()) as GraphQLResponse;
  if (!res.ok || body.errors?.length) {
    throw new Error(`GraphQL Analytics API error: ${body.errors?.map((e) => e.message).join("; ") ?? res.statusText}`);
  }

  const groups = body.data?.viewer?.accounts?.[0]?.aiInferenceAdaptiveGroups ?? [];
  return groups.reduce(
    (acc, g) => ({
      requestCount: acc.requestCount + g.count,
      inputTokens: acc.inputTokens + (g.sum.totalInputTokens ?? 0),
      outputTokens: acc.outputTokens + (g.sum.totalOutputTokens ?? 0),
    }),
    { requestCount: 0, inputTokens: 0, outputTokens: 0 },
  );
}

/**
 * `fetchImpl` defaults to the real global `fetch` — overridable so
 * integration tests can inject a stub without a Node-side
 * `vi.stubGlobal("fetch", ...)`, which never reaches code running inside
 * the workerd isolate these tests exercise (this repo's `cloudflare:test`
 * version doesn't expose an in-isolate `fetchMock`, see cron.test.ts).
 */
export async function reconcileNeuronUsage(env: CronEnv, db: Db, day: string = reconciliationDay(), fetchImpl: typeof fetch = fetch): Promise<void> {
  if (!env.CF_ACCOUNT_ID || !env.CF_ANALYTICS_API_TOKEN) return;

  const [{ estimatedNeurons }] = await db
    .select({ estimatedNeurons: sql<number>`coalesce(sum(${schema.aiUsage.neurons}), 0)` })
    .from(schema.aiUsage)
    .where(eq(schema.aiUsage.day, day));

  const real = await fetchRealUsage(env, day, fetchImpl);

  await db
    .insert(schema.neuronCalibration)
    .values({
      day,
      estimatedNeurons,
      realRequestCount: real.requestCount,
      realInputTokens: real.inputTokens,
      realOutputTokens: real.outputTokens,
      reconciledAt: Date.now(),
    })
    .onConflictDoUpdate({
      target: schema.neuronCalibration.day,
      set: {
        estimatedNeurons,
        realRequestCount: real.requestCount,
        realInputTokens: real.inputTokens,
        realOutputTokens: real.outputTokens,
        reconciledAt: Date.now(),
      },
    });
}
