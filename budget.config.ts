/**
 * Consumption model backing TRD §2.1. Versioned so `budget:check` and
 * `budget:cpu` fail loudly when assumptions or Cloudflare's free-tier
 * numbers change.
 */
export const FREE_TIER_LIMITS = {
  workers: { requestsPerDay: 100_000, cpuMsPerRequest: 10, subrequestsPerInvocation: 50 },
  d1: { rowsReadPerDay: 5_000_000, rowsWrittenPerDay: 100_000, storageBytes: 5 * 1024 ** 3 },
  kv: { readsPerDay: 100_000, writesPerDay: 1_000 },
  r2: { storageBytes: 10 * 1024 ** 3, classAOpsPerMonth: 1_000_000, classBOpsPerMonth: 10_000_000 },
  workersAi: { neuronsPerDay: 10_000 },
} as const;

export const TARGET = {
  monthlyActiveUsers: 5_000,
  sessionsPerUserPerMonth: 20,
  dynamicRequestsPerSession: 8,
} as const;

const dynamicRequestsPerMonth =
  TARGET.monthlyActiveUsers * TARGET.sessionsPerUserPerMonth * TARGET.dynamicRequestsPerSession;
export const projectedDynamicRequestsPerDay = Math.ceil((dynamicRequestsPerMonth / 30) * 1.25); // +25% peak margin

/**
 * Route mix (TRD §2.1): a flat per-request budget applied uniformly to
 * every dynamic request is wrong once routes have meaningfully different
 * resource costs — e.g. /api/ai/chat writes 3 D1 rows (two message turns +
 * one quota upsert, src/server/ai.ts) while /dashboard writes 0. Modeling
 * every dynamic request as if it were the heaviest one overstates D1
 * writes ~4x at this MAU target and fails the budget gate on a route that
 * makes up a fraction of real traffic. Fractions sum to 1 and are a
 * deliberately conservative estimate, not measured production traffic —
 * revisit once real usage data exists.
 */
const ROUTE_MIX = [
  { name: "aiChat", fraction: 0.15, cpuMs: 4, d1RowsRead: 12, d1RowsWritten: 3, kvReads: 0, kvWrites: 0, subrequests: 1 },
  { name: "dashboard", fraction: 0.35, cpuMs: 3, d1RowsRead: 2, d1RowsWritten: 0, kvReads: 0, kvWrites: 0, subrequests: 0 },
  { name: "authAndOther", fraction: 0.5, cpuMs: 2, d1RowsRead: 2, d1RowsWritten: 1, kvReads: 2, kvWrites: 0, subrequests: 1 },
] as const;

function weightedAverage(key: "cpuMs" | "d1RowsRead" | "d1RowsWritten" | "kvReads" | "kvWrites" | "subrequests"): number {
  return ROUTE_MIX.reduce((sum, route) => sum + route.fraction * route[key], 0);
}

/** Per-request budget derived from the route mix above (TRD §2.1). Every new route's resource cost should be added to ROUTE_MIX, not this constant directly. */
export const PER_REQUEST_BUDGET = {
  cpuMs: 7, // TRD §7.1 hard ceiling, not derived from the mix — every individual route must fit under this regardless of traffic share.
  d1RowsRead: Math.ceil(weightedAverage("d1RowsRead")),
  d1RowsWritten: Math.ceil(weightedAverage("d1RowsWritten")),
  kvReads: Math.ceil(weightedAverage("kvReads")),
  kvWrites: Math.ceil(weightedAverage("kvWrites")),
  subrequests: Math.ceil(weightedAverage("subrequests")),
} as const;

/** 80% headroom gate used by scripts/budget-check.ts (TRD §7.2). */
export const HEADROOM_RATIO = 0.8;
