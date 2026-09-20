#!/usr/bin/env bun
/**
 * §7.2 gate: projects the per-request budget (budget.config.ts) across the
 * daily peak and fails if any resource exceeds HEADROOM_RATIO of its free-tier
 * quota. Run against `wrangler dev --remote` metrics in CI; this standalone
 * pass validates the arithmetic against the committed assumptions.
 */
import { FREE_TIER_LIMITS, PER_REQUEST_BUDGET, projectedDynamicRequestsPerDay, HEADROOM_RATIO } from "../budget.config";

interface Projection {
  resource: string;
  projected: number;
  limit: number;
  ratio: number;
}

const rawProjections: Array<{ resource: string; projected: number; limit: number }> = [
  {
    resource: "d1.rowsRead",
    projected: projectedDynamicRequestsPerDay * PER_REQUEST_BUDGET.d1RowsRead,
    limit: FREE_TIER_LIMITS.d1.rowsReadPerDay,
  },
  {
    resource: "d1.rowsWritten",
    projected: projectedDynamicRequestsPerDay * PER_REQUEST_BUDGET.d1RowsWritten,
    limit: FREE_TIER_LIMITS.d1.rowsWrittenPerDay,
  },
  {
    resource: "kv.reads",
    projected: projectedDynamicRequestsPerDay * PER_REQUEST_BUDGET.kvReads,
    limit: FREE_TIER_LIMITS.kv.readsPerDay,
  },
  {
    resource: "kv.writes",
    projected: projectedDynamicRequestsPerDay * PER_REQUEST_BUDGET.kvWrites,
    limit: FREE_TIER_LIMITS.kv.writesPerDay,
  },
  {
    resource: "workers.requests",
    projected: projectedDynamicRequestsPerDay,
    limit: FREE_TIER_LIMITS.workers.requestsPerDay,
  },
];
const projections: Projection[] = rawProjections.map((p) => ({ ...p, ratio: p.limit === 0 ? 0 : p.projected / p.limit }));

let failed = false;
for (const p of projections) {
  const status = p.ratio > HEADROOM_RATIO ? "FAIL" : "ok";
  if (p.ratio > HEADROOM_RATIO) failed = true;
  console.log(
    `[${status}] ${p.resource.padEnd(20)} projected=${p.projected.toLocaleString().padStart(10)} ` +
      `limit=${p.limit.toLocaleString().padStart(12)} usage=${(p.ratio * 100).toFixed(1)}%`,
  );
}

if (failed) {
  console.error(`\nBudget gate failed: at least one resource exceeds ${HEADROOM_RATIO * 100}% of its free-tier quota.`);
  process.exit(1);
}
console.log(`\nBudget gate passed: all resources ≤ ${HEADROOM_RATIO * 100}% of free-tier quota at ${projectedDynamicRequestsPerDay.toLocaleString()} req/day.`);
