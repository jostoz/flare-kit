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

/** Per-request budget derived from the projected peak (TRD §2.1). Every new route is checked against this. */
export const PER_REQUEST_BUDGET = {
  cpuMs: 7,
  d1RowsRead: 100,
  d1RowsWritten: 2,
  kvReads: 2,
  kvWrites: 0,
  subrequests: 5,
} as const;

/** 80% headroom gate used by scripts/budget-check.ts (TRD §7.2). */
export const HEADROOM_RATIO = 0.8;
